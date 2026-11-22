import {
  FactoryPrDescriptionSchema,
  FactoryPrReviewerSchema,
  FactoryPrTargetBranchSchema,
  FactoryPrTitleSchema,
  type SaveFactoryPrReviewRequest,
} from './factory.js';

const CONVENTIONAL_COMMIT_PR_TITLE_PATTERN =
  /^(?:feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert)(?:\([a-z0-9._/-]+\))?!?: \S.*$/;

export interface FactoryPrReviewFormInput {
  readonly title: string;
  readonly description: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly reviewers: readonly string[];
  readonly updateJira: boolean;
}

export interface FactoryPrReviewFormErrors {
  readonly title?: string;
  readonly description?: string;
  readonly baseBranch?: string;
  readonly reviewers?: string;
}

export type FactoryPrReviewFormValidationResult =
  | {
      readonly valid: true;
      readonly data: Omit<SaveFactoryPrReviewRequest, 'confirmPublish' | 'expectedUpdatedAt'>;
    }
  | {
      readonly valid: false;
      readonly errors: FactoryPrReviewFormErrors;
    };

/** Normaliza um identificador de reviewer removendo espaços externos e `@` inicial. */
export function normalizePrReviewerInput(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

/** Divide texto livre (vírgulas, ponto-e-vírgula ou espaços) em reviewers únicos normalizados. */
export function parsePrReviewersInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of raw.split(/[\s,;]+/)) {
    const normalized = normalizePrReviewerInput(token);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

/** Indica se o título segue o padrão Conventional Commits (`tipo(escopo?): descrição`). */
export function isConventionalCommitPrTitle(title: string): boolean {
  return CONVENTIONAL_COMMIT_PR_TITLE_PATTERN.test(title.trim());
}

/** Valida os campos editáveis da revisão humana pré-publicação do PR antes do envio ao backend. */
export function validateFactoryPrReviewForm(
  input: FactoryPrReviewFormInput,
): FactoryPrReviewFormValidationResult {
  const errors: {
    title?: string;
    description?: string;
    baseBranch?: string;
    reviewers?: string;
  } = {};

  const parsedTitle = FactoryPrTitleSchema.safeParse(input.title);
  if (!parsedTitle.success) {
    errors.title = parsedTitle.error.issues[0]?.message ?? 'Informe o título do Pull Request';
  }

  const parsedDescription = FactoryPrDescriptionSchema.safeParse(input.description);
  if (!parsedDescription.success) {
    errors.description =
      parsedDescription.error.issues[0]?.message ?? 'Informe a descrição Markdown do Pull Request';
  }

  const parsedBaseBranch = FactoryPrTargetBranchSchema.safeParse(input.baseBranch);
  if (!parsedBaseBranch.success) {
    errors.baseBranch =
      parsedBaseBranch.error.issues[0]?.message ?? 'Informe uma branch destino válida';
  }

  const normalizedReviewers: string[] = [];
  const seenReviewers = new Set<string>();
  for (const rawReviewer of input.reviewers) {
    const normalized = normalizePrReviewerInput(rawReviewer);
    const parsedReviewer = FactoryPrReviewerSchema.safeParse(normalized);
    if (!parsedReviewer.success) {
      errors.reviewers =
        parsedReviewer.error.issues[0]?.message ?? 'Lista de reviewers contém item inválido';
      break;
    }
    const key = parsedReviewer.data.toLowerCase();
    if (seenReviewers.has(key)) {
      errors.reviewers = `Reviewer duplicado: ${parsedReviewer.data}`;
      break;
    }
    seenReviewers.add(key);
    normalizedReviewers.push(parsedReviewer.data);
  }

  if (normalizedReviewers.length > 50 && !errors.reviewers) {
    errors.reviewers = 'Informe no máximo 50 reviewers';
  }

  if (
    errors.title !== undefined ||
    errors.description !== undefined ||
    errors.baseBranch !== undefined ||
    errors.reviewers !== undefined ||
    !parsedTitle.success ||
    !parsedDescription.success ||
    !parsedBaseBranch.success
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      title: parsedTitle.data,
      description: parsedDescription.data,
      baseBranch: parsedBaseBranch.data,
      draft: input.draft,
      reviewers: normalizedReviewers,
      updateJira: input.updateJira,
    },
  };
}
