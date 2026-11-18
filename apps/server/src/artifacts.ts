import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  REVIEW_CONTRACT_VERSION,
  type Review,
  type ReviewArtifactFormat,
  type ReviewArtifactKind,
  type ReviewExecution,
} from '@development-factory/shared';

export interface PreparedArtifactTarget {
  readonly kind: ReviewArtifactKind;
  readonly format: ReviewArtifactFormat;
  readonly path: string;
}

export interface PrepareArtifactFilesOptions {
  readonly includeStructuredResult?: boolean;
  readonly createdAt?: string;
}

export class ArtifactPreparationError extends Error {
  constructor(
    message: string,
    public readonly targets: readonly PreparedArtifactTarget[],
    public readonly createdKinds: ReadonlySet<ReviewArtifactKind>,
    public readonly failedKind: ReviewArtifactKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ArtifactPreparationError';
  }
}

export interface ReviewArtifactFileWriter {
  prepareExecutionFiles(
    review: Review,
    execution: ReviewExecution,
    options?: PrepareArtifactFilesOptions,
  ): PreparedArtifactTarget[];
}

function resolveSafeReviewsDirectory(repoPath: string): string {
  const resolvedRepo = realpathSync(repoPath);
  const directory = join(resolvedRepo, '.code-reviews');
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('.code-reviews precisa ser um diretório real dentro do repositório.');
  }
  return directory;
}

function buildArtifactTargets(
  directory: string,
  review: Review,
  execution: ReviewExecution,
  startedAt: string,
  includeStructuredResult: boolean,
): PreparedArtifactTarget[] {
  const slug = review.target.identifier.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'review';
  const basename = `${startedAt.replace(/[:.]/g, '-')}-${review.target.type}-${slug}-${execution.id}`;

  const targets: PreparedArtifactTarget[] = [
    { kind: 'report', format: 'markdown', path: join(directory, `${basename}.md`) },
    { kind: 'session_log', format: 'markdown', path: join(directory, `${basename}.session.md`) },
  ];

  if (includeStructuredResult) {
    targets.push({
      kind: 'structured_result',
      format: 'json',
      path: join(directory, `${basename}.result.json`),
    });
  }

  return targets;
}

export const defaultReviewArtifactFileWriter: ReviewArtifactFileWriter = {
  prepareExecutionFiles(
    review: Review,
    execution: ReviewExecution,
    options: PrepareArtifactFilesOptions = {},
  ): PreparedArtifactTarget[] {
    const startedAt = options.createdAt ?? execution.createdAt;
    const includeStructuredResult = options.includeStructuredResult ?? true;

    let directory: string;
    try {
      directory = resolveSafeReviewsDirectory(review.target.repoPath);
    } catch (error) {
      const fallbackDir = join(review.target.repoPath, '.code-reviews');
      const targets = buildArtifactTargets(
        fallbackDir,
        review,
        execution,
        startedAt,
        includeStructuredResult,
      );
      const message = error instanceof Error
        ? error.message
        : 'Não foi possível preparar a pasta .code-reviews.';
      throw new ArtifactPreparationError(message, targets, new Set(), 'report', { cause: error });
    }

    const targets = buildArtifactTargets(
      directory,
      review,
      execution,
      startedAt,
      includeStructuredResult,
    );
    const reportTarget = targets.find(item => item.kind === 'report');
    const sessionTarget = targets.find(item => item.kind === 'session_log');
    const structuredTarget = targets.find(item => item.kind === 'structured_result');

    if (!reportTarget || !sessionTarget) {
      throw new ArtifactPreparationError(
        'Alvos obrigatórios de parecer e sessão não puderam ser definidos.',
        targets,
        new Set(),
        'report',
      );
    }

    const targetLabel = `${review.target.type === 'pr' ? 'PR #' : 'Branch '}${review.target.identifier}`;
    const metadata = [
      `- Review ID: ${review.id}`,
      `- Execução ID: ${execution.id}`,
      `- Alvo: ${JSON.stringify(targetLabel)}`,
      `- Repositório: ${JSON.stringify(review.target.repoPath)}`,
      `- Início: ${startedAt}`,
    ].join('\n') + '\n';

    const createdKinds = new Set<ReviewArtifactKind>();

    try {
      const placeholder = `# Code review\n\n${metadata}\n> Review em andamento. O parecer final será salvo aqui pelo Claude Code.\n`;
      writeFileSync(reportTarget.path, placeholder, { flag: 'wx', mode: 0o600 });
      createdKinds.add('report');
    } catch (error) {
      throw new ArtifactPreparationError(
        'Não foi possível criar o arquivo de parecer do review.',
        targets,
        createdKinds,
        'report',
        { cause: error },
      );
    }

    let descriptor = -1;
    try {
      descriptor = openSync(sessionTarget.path, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `# Registro da sessão de code review\n\n${metadata}\n> Registro textual da TUI; pode conter redesenhos e repetições. O parecer final fica em ${JSON.stringify(reportTarget.path)}.\n\n## Saída do terminal\n\n    `,
      );
      createdKinds.add('session_log');
    } catch (error) {
      try {
        writeFileSync(
          reportTarget.path,
          `# Code review não iniciado\n\n${metadata}\nNão foi possível criar o registro da sessão.\n`,
        );
      } catch {
        // Ignora falha secundária ao atualizar o parecer após erro de criação.
      }
      throw new ArtifactPreparationError(
        'Não foi possível criar o arquivo de registro da sessão.',
        targets,
        createdKinds,
        'session_log',
        { cause: error },
      );
    } finally {
      if (descriptor !== -1) {
        closeSync(descriptor);
      }
    }

    if (structuredTarget) {
      try {
        const initialStructured = JSON.stringify(
          {
            contractVersion: REVIEW_CONTRACT_VERSION,
            reviewId: review.id,
            executionId: execution.id,
            status: 'pending',
            createdAt: startedAt,
          },
          null,
          2,
        ) + '\n';
        writeFileSync(structuredTarget.path, initialStructured, { flag: 'wx', mode: 0o600 });
        createdKinds.add('structured_result');
      } catch (error) {
        try {
          writeFileSync(
            reportTarget.path,
            `# Code review não iniciado\n\n${metadata}\nNão foi possível criar o arquivo de resultado estruturado.\n`,
          );
        } catch {
          // Ignora falha secundária ao atualizar o parecer após erro de criação.
        }
        throw new ArtifactPreparationError(
          'Não foi possível criar o arquivo de resultado estruturado.',
          targets,
          createdKinds,
          'structured_result',
          { cause: error },
        );
      }
    }

    return targets;
  },
};
