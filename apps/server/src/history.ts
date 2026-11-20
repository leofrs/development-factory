import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FactoryRequest, FactoryStageName } from '@development-factory/shared';
import { isImplementationReport } from './factory-development.js';
import { isReviewReport } from './factory-review.js';
import { isTestReport } from './factory-tests.js';
import { maxHistoryBytes } from './history-reader.js';
import { IMPLEMENTATION_REPORT_TITLE } from './prompts/factory-development.js';
import { REVIEW_REPORT_TITLE } from './prompts/factory-review.js';
import { TEST_REPORT_TITLE } from './prompts/factory-tests.js';

type HistoryState = 'pending' | 'saved' | 'incomplete';

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
  readonly validateReport?: (content: string) => boolean;
}

function readValidatedReport(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    return info.isFile() && info.size <= maxHistoryBytes ? readFileSync(descriptor, 'utf8') : '';
  } finally {
    closeSync(descriptor);
  }
}

function createSessionHistory(
  config: SessionHistoryConfig,
  onChange: (state: HistoryState) => void,
  onError: (message: string) => void,
) {
  const startedAt = new Date().toISOString();
  let descriptor = -1;
  const directory = join(realpathSync(config.repoPath), '.code-reviews');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error('.code-reviews precisa ser um diretório real dentro do repositório.');
  }
  const slug = config.slugSource.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || config.prefix;
  const fileBasename = `${startedAt.replace(/[:.]/g, '-')}-${config.prefix}-${slug}-${randomUUID()}`;
  const reportPath = join(directory, `${fileBasename}.md`);
  const sessionPath = join(directory, `${fileBasename}.session.md`);
  const placeholder = `# ${config.reportPlaceholderTitle}\n\n${config.metadata}\n> ${config.reportPlaceholderNote}\n`;
  writeFileSync(reportPath, placeholder, { flag: 'wx', mode: 0o600 });
  try {
    descriptor = openSync(sessionPath, 'wx', 0o600);
    appendFileSync(descriptor, `# ${config.sessionTitle}\n\n${config.metadata}\n> Registro textual da TUI; pode conter redesenhos e repetições. O arquivo final fica em ${JSON.stringify(reportPath)}.\n\n## Saída do terminal\n\n    `);
  } catch (error) {
    if (descriptor !== -1) closeSync(descriptor);
    writeFileSync(reportPath, `# ${config.reportPlaceholderTitle} não iniciado\n\n${config.metadata}\nNão foi possível criar o registro da sessão.\n`);
    throw error;
  }
  let finished = false;
  let failed = false;
  let saved = false;
  let escapeTail = '';
  const checkReport = () => {
    try {
      const content = (config.validateReport
        ? readValidatedReport(reportPath)
        : readFileSync(reportPath, 'utf8')).trim();
      const nextSaved =
        content.length > 0 &&
        content !== placeholder.trim() &&
        (config.validateReport?.(content) ?? true);
      if (nextSaved !== saved) { saved = nextSaved; onChange(saved ? 'saved' : 'pending'); }
    } catch { /* Um editor pode substituir o arquivo de forma atômica. */ }
  };
  if (!config.validateReport) {
    watchFile(reportPath, { interval: 500, persistent: false }, checkReport);
  }

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
  const finish = (reason: string, acceptReport = true) => {
    if (finished) return;
    finished = true;
    unwatchFile(reportPath, checkReport);
    if (acceptReport) {
      checkReport();
    }
    try {
      appendFileSync(descriptor, `\n\n- Encerramento: ${reason}\n- Fim: ${new Date().toISOString()}\n`);
      if (!saved) {
        if (!config.validateReport) {
          writeFileSync(reportPath, `# ${config.incompleteTitle}\n\n${config.metadata}\n${config.incompleteNote} (${reason}).\n\nConsulte o registro da sessão: [${fileBasename}.session.md](./${fileBasename}.session.md).\n`);
        }
        onChange('incomplete');
      }
    } catch { onError('Falha ao finalizar os arquivos de histórico. Verifique o espaço e as permissões do repositório.'); }
    finally { closeSync(descriptor); }
  };
  return { reportPath, sessionPath, record, finish };
}

const REPORT_STAGE_HISTORY_CONFIG: Partial<
  Record<
    FactoryStageName,
    {
      readonly prefixSegment: string;
      readonly reportPlaceholderTitle: string;
      readonly reportPlaceholderNote: string;
      readonly sessionTitle: string;
      readonly validateReport: (content: string) => boolean;
    }
  >
> = {
  development: {
    prefixSegment: 'factory-development',
    reportPlaceholderTitle: IMPLEMENTATION_REPORT_TITLE,
    reportPlaceholderNote: 'Desenvolvimento em andamento. O relatório final será salvo aqui.',
    sessionTitle: 'Registro da sessão de desenvolvimento (Factory)',
    validateReport: isImplementationReport,
  },
  tests: {
    prefixSegment: 'factory-tests',
    reportPlaceholderTitle: TEST_REPORT_TITLE,
    reportPlaceholderNote: 'Execução de testes em andamento. O relatório final será salvo aqui.',
    sessionTitle: 'Registro da sessão de testes (Factory)',
    validateReport: isTestReport,
  },
  review: {
    prefixSegment: 'factory-review',
    reportPlaceholderTitle: REVIEW_REPORT_TITLE,
    reportPlaceholderNote: 'Code Review em andamento. O relatório final será salvo aqui.',
    sessionTitle: 'Registro da sessão de code review (Factory)',
    validateReport: isReviewReport,
  },
};

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
  const stageConfig = request.stage ? REPORT_STAGE_HISTORY_CONFIG[request.stage] : undefined;

  return createSessionHistory(
    {
      repoPath: request.repoPath,
      slugSource: request.value,
      prefix: stageConfig
        ? `${stageConfig.prefixSegment}-${request.inputType}`
        : `factory-${request.inputType}`,
      metadata,
      reportPlaceholderTitle: stageConfig?.reportPlaceholderTitle ?? 'Plano da tarefa',
      reportPlaceholderNote:
        stageConfig?.reportPlaceholderNote ??
        'Planejamento em andamento. O plano final será salvo aqui pelo Claude Code.',
      sessionTitle:
        stageConfig?.sessionTitle ?? 'Registro da sessão de planejamento (Factory)',
      incompleteTitle: 'Plano da tarefa incompleto',
      incompleteNote: 'O plano final não foi salvo pelo Claude antes do encerramento',
      ...(stageConfig ? { validateReport: stageConfig.validateReport } : {}),
    },
    onChange,
    onError,
  );
}
