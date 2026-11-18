import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ReviewRequest } from '@development-factory/shared';

type HistoryState = 'pending' | 'saved' | 'incomplete';

export function createReviewHistory(request: ReviewRequest, onChange: (state: HistoryState) => void, onError: (message: string) => void) {
  const directory = join(realpathSync(request.repoPath), '.code-reviews');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error('.code-reviews precisa ser um diretório real dentro do repositório.');
  }
  const startedAt = new Date().toISOString();
  const slug = request.identifier.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'review';
  const basename = `${startedAt.replace(/[:.]/g, '-')}-${request.targetType}-${slug}-${randomUUID()}`;
  const reportPath = join(directory, `${basename}.md`);
  const sessionPath = join(directory, `${basename}.session.md`);
  const target = `${request.targetType === 'pr' ? 'PR #' : 'Branch '}${request.identifier}`;
  const metadata = `- Alvo: ${JSON.stringify(target)}\n- Repositório: ${JSON.stringify(request.repoPath)}\n- Início: ${startedAt}\n`;
  const placeholder = `# Code review\n\n${metadata}\n> Review em andamento. O parecer final será salvo aqui pelo Claude Code.\n`;
  writeFileSync(reportPath, placeholder, { flag: 'wx', mode: 0o600 });
  let descriptor = -1;
  try {
    descriptor = openSync(sessionPath, 'wx', 0o600);
    appendFileSync(descriptor, `# Registro da sessão de code review\n\n${metadata}\n> Registro textual da TUI; pode conter redesenhos e repetições. O parecer final fica em ${JSON.stringify(reportPath)}.\n\n## Saída do terminal\n\n    `);
  } catch (error) {
    if (descriptor !== -1) closeSync(descriptor);
    writeFileSync(reportPath, `# Code review não iniciado\n\n${metadata}\nNão foi possível criar o registro da sessão.\n`);
    throw error;
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
        writeFileSync(reportPath, `# Code review incompleto\n\n${metadata}\nO parecer final não foi salvo pelo Claude antes do encerramento (${reason}).\n\nConsulte o registro da sessão: [${basename}.session.md](./${basename}.session.md).\n`);
        onChange('incomplete');
      }
    } catch { onError('Falha ao finalizar os arquivos de histórico. Verifique o espaço e as permissões do repositório.'); }
    finally { closeSync(descriptor); }
  };
  return { reportPath, sessionPath, record, finish };
}
