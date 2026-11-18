import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FactoryRequest, ReviewRequest } from '@development-factory/shared';

type HistoryState = 'pending' | 'saved' | 'incomplete';

export interface ReviewHistoryOptions {
  readonly reviewId?: string;
  readonly executionId?: string;
  readonly prepared?: {
    readonly reportPath: string;
    readonly sessionPath: string;
    readonly startedAt: string;
  };
}

interface SessionHistoryConfig {
  readonly repoPath: string;
  readonly slugSource: string;
  readonly prefix: string;
  readonly metadata: string;
  readonly reportPlaceholderTitle: string;
  readonly reportPlaceholderNote: string;
  readonly sessionTitle: string;
  readonly incompleteTitle: string;
  readonly incompleteNote: string;
  readonly prepared?: ReviewHistoryOptions['prepared'];
}

function createSessionHistory(
  config: SessionHistoryConfig,
  onChange: (state: HistoryState) => void,
  onError: (message: string) => void,
) {
  const startedAt = config.prepared?.startedAt ?? new Date().toISOString();

  let reportPath: string;
  let sessionPath: string;
  let fileBasename: string;
  let placeholder: string;
  let descriptor = -1;

  if (config.prepared) {
    reportPath = config.prepared.reportPath;
    sessionPath = config.prepared.sessionPath;
    fileBasename = basename(sessionPath, '.session.md');
    placeholder = readFileSync(reportPath, 'utf8');
    descriptor = openSync(sessionPath, 'a', 0o600);
  } else {
    const directory = join(realpathSync(config.repoPath), '.code-reviews');
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      throw new Error('.code-reviews precisa ser um diretório real dentro do repositório.');
    }
    const slug = config.slugSource.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || config.prefix;
    fileBasename = `${startedAt.replace(/[:.]/g, '-')}-${config.prefix}-${slug}-${randomUUID()}`;
    reportPath = join(directory, `${fileBasename}.md`);
    sessionPath = join(directory, `${fileBasename}.session.md`);
    placeholder = `# ${config.reportPlaceholderTitle}\n\n${config.metadata}\n> ${config.reportPlaceholderNote}\n`;
    writeFileSync(reportPath, placeholder, { flag: 'wx', mode: 0o600 });
    try {
      descriptor = openSync(sessionPath, 'wx', 0o600);
      appendFileSync(descriptor, `# ${config.sessionTitle}\n\n${config.metadata}\n> Registro textual da TUI; pode conter redesenhos e repetições. O arquivo final fica em ${JSON.stringify(reportPath)}.\n\n## Saída do terminal\n\n    `);
    } catch (error) {
      if (descriptor !== -1) closeSync(descriptor);
      writeFileSync(reportPath, `# ${config.reportPlaceholderTitle} não iniciado\n\n${config.metadata}\nNão foi possível criar o registro da sessão.\n`);
      throw error;
    }
  }
  let finished = false;
  let failed = false;
  let saved = false;
  let escapeTail = '';
  const checkReport = () => {
    try {
      const content = readFileSync(reportPath, 'utf8').trim();
      const nextSaved = content.length > 0 && content !== placeholder.trim();
      if (nextSaved !== saved) { saved = nextSaved; onChange(saved ? 'saved' : 'pending'); }
    } catch { /* Um editor pode substituir o arquivo de forma atômica. */ }
  };
  watchFile(reportPath, { interval: 500, persistent: false }, checkReport);

  const record = (data: string) => {
    if (finished || failed) return;
    try {
      // Aguarda sequências ANSI divididas entre chunks antes de removê-las.
      const text = escapeTail + data;
      const incomplete = text.match(/\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?|[PX^_][^\x1b]*(?:\x1b)?)?$/);
      escapeTail = incomplete?.[0] ?? '';
      const complete = escapeTail ? text.slice(0, -escapeTail.length) : text;
      const plain = stripVTControlCharacters(complete).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      appendFileSync(descriptor, plain.replace(/\n/g, '\n    '));
    } catch {
      failed = true;
      onError('Não foi possível continuar salvando o registro da sessão. Verifique o espaço e as permissões do repositório.');
    }
  };
  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    unwatchFile(reportPath, checkReport);
    checkReport();
    try {
      appendFileSync(descriptor, `\n\n- Encerramento: ${reason}\n- Fim: ${new Date().toISOString()}\n`);
      if (!saved) {
        writeFileSync(reportPath, `# ${config.incompleteTitle}\n\n${config.metadata}\n${config.incompleteNote} (${reason}).\n\nConsulte o registro da sessão: [${fileBasename}.session.md](./${fileBasename}.session.md).\n`);
        onChange('incomplete');
      }
    } catch { onError('Falha ao finalizar os arquivos de histórico. Verifique o espaço e as permissões do repositório.'); }
    finally { closeSync(descriptor); }
  };
  return { reportPath, sessionPath, record, finish };
}

export function createReviewHistory(
  request: ReviewRequest,
  onChange: (state: HistoryState) => void,
  onError: (message: string) => void,
  options: ReviewHistoryOptions = {},
) {
  const startedAt = options.prepared?.startedAt ?? new Date().toISOString();
  const target = `${request.targetType === 'pr' ? 'PR #' : 'Branch '}${request.identifier}`;
  const reviewMetadata = [
    options.reviewId ? `- Review ID: ${options.reviewId}\n` : '',
    options.executionId ? `- Execução ID: ${options.executionId}\n` : '',
  ].join('');
  const metadata = `${reviewMetadata}- Alvo: ${JSON.stringify(target)}\n- Repositório: ${JSON.stringify(request.repoPath)}\n- Início: ${startedAt}\n`;

  return createSessionHistory(
    {
      repoPath: request.repoPath,
      slugSource: request.identifier,
      prefix: request.targetType,
      metadata,
      reportPlaceholderTitle: 'Code review',
      reportPlaceholderNote: 'Review em andamento. O parecer final será salvo aqui pelo Claude Code.',
      sessionTitle: 'Registro da sessão de code review',
      incompleteTitle: 'Code review incompleto',
      incompleteNote: 'O parecer final não foi salvo pelo Claude antes do encerramento',
      prepared: options.prepared,
    },
    onChange,
    onError,
  );
}

export function createFactoryHistory(
  request: FactoryRequest,
  onChange: (state: HistoryState) => void,
  onError: (message: string) => void,
) {
  const startedAt = new Date().toISOString();
  const labels: Record<FactoryRequest['inputType'], string> = {
    jira_url: 'URL JIRA',
    jira_key: 'Chave JIRA',
    title: 'Título da tarefa',
  };
  const metadata = `- Origem: ${labels[request.inputType]}\n- Tarefa: ${JSON.stringify(request.value)}\n- Repositório: ${JSON.stringify(request.repoPath)}\n- Início: ${startedAt}\n`;

  return createSessionHistory(
    {
      repoPath: request.repoPath,
      slugSource: request.value,
      prefix: `factory-${request.inputType}`,
      metadata,
      reportPlaceholderTitle: 'Plano da tarefa',
      reportPlaceholderNote: 'Planejamento em andamento. O plano final será salvo aqui pelo Claude Code.',
      sessionTitle: 'Registro da sessão de planejamento (Factory)',
      incompleteTitle: 'Plano da tarefa incompleto',
      incompleteNote: 'O plano final não foi salvo pelo Claude antes do encerramento',
    },
    onChange,
    onError,
  );
}
