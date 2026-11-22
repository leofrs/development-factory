import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, openSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FactoryRequest, FactoryStageName } from '@development-factory/shared';
import { resolveFactoryArtifactsDirectory } from './artifacts.js';
import { isImplementationReport } from './factory-development.js';
import { isPrSummary } from './factory-pr.js';
import { isReviewReport } from './factory-review.js';
import {
  FactoryStageArtifactError,
  getFactoryStageSidecarPath,
  readFactoryArtifactFile,
  readFactoryStageSidecar,
  validateStructuredMarkdownReport,
} from './factory-stage-runners.js';
import { isTestReport } from './factory-tests.js';
import { redactSecrets, redactSecretsInValue } from './secret-redaction.js';
import { IMPLEMENTATION_REPORT_TITLE } from './prompts/factory-development.js';
import { PR_SUMMARY_TITLE } from './prompts/factory-pr.js';
import { REVIEW_REPORT_TITLE } from './prompts/factory-review.js';
import { TEST_REPORT_TITLE } from './prompts/factory-tests.js';

type HistoryResult = 'saved' | 'incomplete';

interface StageHistoryConfig {
  readonly prefixSegment: string;
  readonly reportPlaceholderTitle: string;
  readonly reportPlaceholderNote: string;
  readonly sessionTitle: string;
  readonly validateReport: (content: string) => boolean;
}

interface SessionHistoryConfig {
  readonly stage: FactoryStageName;
  readonly inputType: FactoryRequest['inputType'];
  readonly repoPath: string;
  readonly flowId?: string;
  readonly slugSource: string;
  readonly metadata: string;
}

function writeReportFileSafely(path: string, content: string): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeReportMarkdownFile(reportPath: string): void {
  let raw: string;
  try {
    raw = readFactoryArtifactFile(reportPath).toString('utf8');
  } catch {
    return;
  }
  const sanitized = redactSecrets(raw);
  if (sanitized !== raw) {
    writeReportFileSafely(reportPath, sanitized);
  }
}

function sanitizeSidecarJsonFile(sidecarPath: string): void {
  let rawBytes: Buffer;
  try {
    rawBytes = readFactoryArtifactFile(sidecarPath);
  } catch {
    return;
  }
  if (rawBytes.length === 0) {
    return;
  }
  let parsed: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return;
  }
  const sanitized = redactSecretsInValue(parsed);
  const serializedOriginal = JSON.stringify(parsed);
  const serializedSanitized = JSON.stringify(sanitized);
  if (serializedSanitized !== serializedOriginal) {
    writeReportFileSafely(sidecarPath, `${serializedSanitized}\n`);
  }
}

const MAX_PENDING_LINE_LENGTH = 8192;
const PENDING_LINE_OVERLAP = 512;

function createSessionHistory(
  config: SessionHistoryConfig,
  onChange: (state: HistoryResult) => void,
  onError: (message: string) => void,
) {
  const stageConfig = REPORT_STAGE_HISTORY_CONFIG[config.stage];
  const safeMetadata = redactSecrets(config.metadata);
  const startedAt = new Date().toISOString();
  let descriptor = -1;
  const directory = resolveFactoryArtifactsDirectory(config.repoPath, config.flowId);
  const prefix = `${stageConfig.prefixSegment}-${config.inputType}`;
  const slug =
    redactSecrets(config.slugSource).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || prefix;
  const fileBasename = `${startedAt.replace(/[:.]/g, '-')}-${prefix}-${slug}-${randomUUID()}`;
  const reportPath = join(directory, `${fileBasename}.md`);
  const sidecarPath = getFactoryStageSidecarPath(reportPath);
  const sessionPath = join(directory, `${fileBasename}.session.md`);
  const placeholder = `# ${stageConfig.reportPlaceholderTitle}\n\n${safeMetadata}\n> ${stageConfig.reportPlaceholderNote}\n`;
  writeFileSync(reportPath, placeholder, { flag: 'wx', mode: 0o600 });
  try {
    writeFileSync(sidecarPath, '', { flag: 'wx', mode: 0o600 });
    descriptor = openSync(sessionPath, 'wx', 0o600);
    appendFileSync(
      descriptor,
      `# ${stageConfig.sessionTitle}\n\n${safeMetadata}\n` +
        `> Registro textual da TUI. O relatório fica em ${JSON.stringify(reportPath)}.\n` +
        `> O sidecar JSON fica em ${JSON.stringify(sidecarPath)}.\n\n## Saída do terminal\n\n    `,
    );
  } catch (error) {
    if (descriptor !== -1) {
      closeSync(descriptor);
    }
    writeReportFileSafely(
      reportPath,
      `# ${stageConfig.reportPlaceholderTitle} não iniciado\n\n${safeMetadata}\n` +
        'Falha ao preparar o sidecar JSON ou o registro da sessão.\n',
    );
    throw error;
  }
  let finished = false;
  let failed = false;
  let escapeTail = '';
  let pendingLine = '';

  const flushPendingLine = (flushAll: boolean) => {
    if (pendingLine.length === 0) {
      return;
    }
    if (flushAll) {
      const redacted = redactSecrets(pendingLine);
      pendingLine = '';
      appendFileSync(descriptor, redacted.replace(/\n/g, '\n    '));
      return;
    }
    const lastNewline = pendingLine.lastIndexOf('\n');
    if (lastNewline !== -1) {
      const ready = pendingLine.slice(0, lastNewline + 1);
      pendingLine = pendingLine.slice(lastNewline + 1);
      const redacted = redactSecrets(ready);
      appendFileSync(descriptor, redacted.replace(/\n/g, '\n    '));
    }
    while (pendingLine.length > MAX_PENDING_LINE_LENGTH) {
      // Redige antes de fatiar linhas longas sem quebra para evitar vazamento na fronteira.
      pendingLine = redactSecrets(pendingLine);
      if (pendingLine.length <= MAX_PENDING_LINE_LENGTH) {
        break;
      }
      const cutIndex = pendingLine.length - PENDING_LINE_OVERLAP;
      const chunk = pendingLine.slice(0, cutIndex);
      pendingLine = pendingLine.slice(cutIndex);
      appendFileSync(descriptor, chunk);
    }
  };

  const record = (data: string) => {
    if (finished || failed) {
      return;
    }
    try {
      // Aguarda sequências ANSI divididas entre chunks antes de removê-las.
      const text = escapeTail + data;
      const incomplete = text.match(
        /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?|[PX^_][^\x1b]*(?:\x1b)?)?$/,
      );
      escapeTail = incomplete?.[0] ?? '';
      const complete = escapeTail ? text.slice(0, -escapeTail.length) : text;
      const plain = stripVTControlCharacters(complete)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      pendingLine += plain;
      flushPendingLine(false);
    } catch {
      failed = true;
      onError(
        'Não foi possível continuar salvando o registro da sessão. Verifique o espaço e as permissões do diretório de artefatos.',
      );
    }
  };
  const finish = (reason: string, acceptReport = true) => {
    if (finished) {
      return undefined;
    }
    finished = true;
    const safeReason = redactSecrets(reason);
    let content: string | undefined;
    let artifactError: FactoryStageArtifactError | undefined;
    try {
      sanitizeReportMarkdownFile(reportPath);
      sanitizeSidecarJsonFile(sidecarPath);
    } catch {
      // Erros de leitura/gravação de artefatos são diagnosticados na consolidação abaixo.
    }
    // Consolida a entrega após o encerramento para validar os dois arquivos já gravados.
    if (acceptReport) {
      try {
        content = readFactoryStageMarkdown(config.stage, reportPath);
        validateFactoryStageArtifacts(config.stage, reportPath, content);
      } catch (error) {
        artifactError =
          error instanceof FactoryStageArtifactError
            ? error
            : new FactoryStageArtifactError(
                'FACTORY_MARKDOWN_INVALID',
                config.stage,
                reportPath,
                'Não foi possível validar o contrato do relatório da etapa',
              );
      }
    }
    const saved = acceptReport && !artifactError;
    try {
      if (!failed) {
        flushPendingLine(true);
      }
      appendFileSync(
        descriptor,
        `\n\n- Encerramento: ${safeReason}\n- Fim: ${new Date().toISOString()}\n`,
      );
      if (
        !saved &&
        content === placeholder &&
        (config.stage === 'triage' || config.stage === 'planning')
      ) {
        writeReportFileSafely(
          reportPath,
          `# ${stageConfig.reportPlaceholderTitle} incompleto\n\n${safeMetadata}\n` +
            `O relatório final não foi salvo antes do encerramento (${safeReason}).\n\n` +
            `Consulte o registro da sessão: [${fileBasename}.session.md](./${fileBasename}.session.md).\n`,
        );
      }
    } catch {
      onError(
        'Falha ao finalizar os arquivos de histórico. Verifique o espaço e as permissões do diretório de artefatos.',
      );
    } finally {
      closeSync(descriptor);
    }
    onChange(saved ? 'saved' : 'incomplete');
    if (artifactError) {
      onError(artifactError.message);
    }
    return artifactError;
  };
  return { reportPath, sidecarPath, sessionPath, record, finish };
}

const TRIAGE_REPORT_TITLE = 'Documento de Entendimento do Problema';
const TRIAGE_REPORT_SECTIONS = {
  summary: 'Síntese Central (Core)',
  scenario: 'Detalhamento do Cenário (Causa e Expectativa)',
  acceptanceCriteria: 'Critérios de Aceite',
  negativeScope: 'Escopo Negativo (Fora do Escopo)',
  technicalClues: 'Pistas Técnicas Citadas na Task',
};
const PLANNING_REPORT_TITLE = 'Diagnóstico Técnico + Plano de Implementação';
const PLANNING_REPORT_SECTIONS = {
  diagnosis: 'Diagnóstico Técnico',
  decisions: 'Decisões de Design & Contratos',
  changes: 'Plano de Alterações (Arquivo por Arquivo)',
  regression: 'Cuidados de Regressão',
  tests: 'Plano de Testes',
};

function validateEarlyStageReport(
  content: string,
  title: string,
  sections: Readonly<Record<string, string>>,
): boolean {
  const sectionTitles = new Set(Object.values(sections));
  const normalizeTitle = (heading: string) =>
    heading.replaceAll('**', '').trim().replace(/[.:]$/, '');
  const normalized = content
    .replace(/^# (.+)$/m, (_, heading: string) => `# ${normalizeTitle(heading)}`)
    .replace(
      /^#{2,6}[ \t]+(?:\d+\.[ \t]+)?(.+)$/gm,
      (_, heading: string) => `## ${normalizeTitle(heading)}`,
    )
    .replace(
      /^\d+\.[ \t]+\*\*([^*\r\n]+)\*\*[.:]?[ \t]*([^\r\n]*)/gm,
      (line: string, heading: string, body: string) => {
        const sectionTitle = normalizeTitle(heading);
        return sectionTitles.has(sectionTitle) ? `## ${sectionTitle}\n${body}` : line;
      },
    );
  return validateStructuredMarkdownReport(normalized, title, sections);
}

const REPORT_STAGE_HISTORY_CONFIG: Readonly<Record<FactoryStageName, StageHistoryConfig>> = {
  triage: {
    prefixSegment: 'factory-triage',
    reportPlaceholderTitle: TRIAGE_REPORT_TITLE,
    reportPlaceholderNote: 'Triagem em andamento. O documento final será salvo aqui.',
    sessionTitle: 'Registro da sessão de triagem (Factory)',
    validateReport: content =>
      validateEarlyStageReport(content, TRIAGE_REPORT_TITLE, TRIAGE_REPORT_SECTIONS),
  },
  planning: {
    prefixSegment: 'factory-planning',
    reportPlaceholderTitle: PLANNING_REPORT_TITLE,
    reportPlaceholderNote: 'Planejamento em andamento. O plano final será salvo aqui.',
    sessionTitle: 'Registro da sessão de planejamento (Factory)',
    validateReport: content =>
      validateEarlyStageReport(content, PLANNING_REPORT_TITLE, PLANNING_REPORT_SECTIONS),
  },
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
  pr: {
    prefixSegment: 'factory-pr',
    reportPlaceholderTitle: PR_SUMMARY_TITLE,
    reportPlaceholderNote: 'Preparação do Pull Request em andamento. O resumo final será salvo aqui.',
    sessionTitle: 'Registro da sessão de PR (Factory)',
    validateReport: isPrSummary,
  },
};

function readFactoryStageMarkdown(stage: FactoryStageName, reportPath: string): string {
  if (extname(reportPath).toLowerCase() !== '.md') {
    throw new FactoryStageArtifactError(
      'FACTORY_MARKDOWN_INVALID',
      stage,
      reportPath,
      'O relatório da etapa precisa ter a extensão .md',
    );
  }
  try {
    return readFactoryArtifactFile(reportPath).toString('utf8');
  } catch {
    throw new FactoryStageArtifactError(
      'FACTORY_MARKDOWN_READ_FAILED',
      stage,
      reportPath,
      'Não foi possível ler o relatório Markdown como arquivo regular de até 5 MB, sem link simbólico',
    );
  }
}

export function validateFactoryStageArtifacts(
  stage: FactoryStageName,
  reportPath: string,
  markdown = readFactoryStageMarkdown(stage, reportPath),
) {
  if (!REPORT_STAGE_HISTORY_CONFIG[stage].validateReport(markdown.trim())) {
    throw new FactoryStageArtifactError(
      'FACTORY_MARKDOWN_INVALID',
      stage,
      reportPath,
      'O relatório Markdown não contém o título e as seções obrigatórias',
    );
  }
  return readFactoryStageSidecar(stage, reportPath);
}

export function createFactoryHistory(
  request: FactoryRequest,
  onChange: (state: HistoryResult) => void,
  onError: (message: string) => void,
) {
  const startedAt = new Date().toISOString();
  const labels: Record<FactoryRequest['inputType'], string> = {
    jira_url: 'URL JIRA',
    jira_key: 'Chave JIRA',
    title: 'Título da tarefa',
  };
  const metadata = `- Origem: ${labels[request.inputType]}\n- Tarefa: ${JSON.stringify(request.value)}\n- Repositório: ${JSON.stringify(request.repoPath)}\n- Início: ${startedAt}\n`;
  const stage = request.stage ?? 'triage';

  return createSessionHistory(
    {
      stage,
      inputType: request.inputType,
      repoPath: request.repoPath,
      ...(request.flowId ? { flowId: request.flowId } : {}),
      slugSource: request.value,
      metadata,
    },
    onChange,
    onError,
  );
}
