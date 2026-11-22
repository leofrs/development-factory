import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileText,
  GitBranch,
  GitPullRequest,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import {
  FactoryPrReviewerSchema,
  isConventionalCommitPrTitle,
  parsePrReviewersInput,
  validateFactoryPrReviewForm,
  type FactoryFlow,
  type FactoryPrGate,
  type FactoryPrReviewFormErrors,
  type PublishFactoryPrRequest,
  type SaveFactoryPrReviewRequest,
} from '@development-factory/shared';
import { MarkdownContent } from './MarkdownContent.js';

interface FactoryFlowPrPanelProps {
  flow: FactoryFlow;
  prGate: FactoryPrGate | null | undefined;
  editable: boolean;
  busyAction: 'advance' | 'rerun' | 'return' | 'cancel' | 'triage' | 'pr' | 'publish' | 'jira' | null;
  onSavePrReview: (request: SaveFactoryPrReviewRequest) => Promise<void>;
  onPublishPr?: (request?: PublishFactoryPrRequest) => Promise<void>;
  onRetryPrJiraSync?: () => Promise<void>;
  onRunPrPreparation?: () => Promise<void>;
  onViewMarkdown?: (filePath: string) => void;
}

interface PrFormDraft {
  readonly title: string;
  readonly description: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly reviewers: string[];
  readonly updateJira: boolean;
}

function createDraftFromGate(prGate: FactoryPrGate): PrFormDraft {
  return {
    title: prGate.title,
    description: prGate.description,
    baseBranch: prGate.baseBranch,
    draft: prGate.draft,
    reviewers: [...prGate.reviewers],
    updateJira: prGate.jiraContext !== null ? prGate.updateJira : false,
  };
}

/**
 * Painel da Etapa 2 do Bloco 06 (`pr`): formulário editável de revisão humana pré-publicação
 * com validação local, pré-visualização Markdown e confirmação explícita antes do envio.
 */
export function FactoryFlowPrPanel({
  flow,
  prGate,
  editable,
  busyAction,
  onSavePrReview,
  onPublishPr,
  onRetryPrJiraSync,
  onRunPrPreparation,
  onViewMarkdown,
}: FactoryFlowPrPanelProps) {
  const formId = useId();
  const sourceKey = prGate
    ? `${flow.id}:${prGate.prArtifactId}:${prGate.updatedAt ?? 'initial'}`
    : '';
  const [syncedKey, setSyncedKey] = useState(sourceKey);
  const [formState, setFormState] = useState<PrFormDraft>(() =>
    prGate
      ? createDraftFromGate(prGate)
      : {
          title: '',
          description: '',
          baseBranch: flow.baseBranch && flow.baseBranch !== 'HEAD' ? flow.baseBranch : 'main',
          draft: false,
          reviewers: [],
          updateJira: false,
        },
  );
  const [reviewerInput, setReviewerInput] = useState('');
  const [descriptionMode, setDescriptionMode] = useState<'edit' | 'preview'>('edit');
  const [fieldErrors, setFieldErrors] = useState<FactoryPrReviewFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  useEffect(() => {
    if (!prGate || !sourceKey || sourceKey === syncedKey) {
      return;
    }
    setFormState(createDraftFromGate(prGate));
    setReviewerInput('');
    setFieldErrors({});
    setSubmitError(null);
    setConfirmingPublish(false);
    setSyncedKey(sourceKey);
  }, [prGate, sourceKey, syncedKey]);

  if (!prGate) {
    const canStartPreparation =
      editable &&
      flow.currentStage === 'pr' &&
      flow.state === 'waiting_action' &&
      Boolean(onRunPrPreparation);
    return (
      <div className="space-y-3 rounded-xl border border-line bg-surface p-4 text-xs">
        <div className="flex items-start gap-2.5">
          <GitPullRequest size={16} className="mt-0.5 shrink-0 text-accent" />
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-primary">
              Revisão Humana Pré-Publicação do Pull Request (Etapa 2)
            </h3>
            <p className="text-muted">
              O rascunho estruturado da Etapa 1 (<code>pr_summary</code>) ainda não foi gerado para
              este fluxo. Execute a preparação estruturada do PR para pré-carregar título,
              descrição Markdown com critérios de aceite e evidências de testes.
            </p>
          </div>
        </div>

        {canStartPreparation && onRunPrPreparation && (
          <button
            type="button"
            disabled={busyAction !== null}
            aria-busy={busyAction === 'rerun'}
            onClick={() => {
              void onRunPrPreparation();
            }}
            className="modal-button border-accent/40 bg-selected/60 px-3 py-1.5 text-xs text-accent hover:bg-selected disabled:opacity-60"
          >
            {busyAction === 'rerun' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <GitPullRequest size={13} />
            )}
            Executar etapa PR
          </button>
        )}
      </div>
    );
  }

  const isBusy = busyAction !== null;
  const publication = prGate.prPublication ?? flow.prPublication ?? null;
  const isPublished = publication?.status === 'published';
  const effectiveEditable = editable && !isPublished;
  const conventionalTitle = isConventionalCommitPrTitle(formState.title);
  const hasJiraContext = prGate.jiraContext !== null;
  const isDirtyFromDraft =
    formState.title.trim() !== prGate.draftTitle ||
    formState.description.trim() !== prGate.draftDescription ||
    formState.baseBranch.trim() !== prGate.draftBaseBranch ||
    formState.draft ||
    formState.reviewers.length > 0 ||
    formState.updateJira !== hasJiraContext;

  function clearFeedback() {
    setSubmitError(null);
    setStatusMessage(null);
  }

  function handleRestoreStage1Draft() {
    if (!prGate || !effectiveEditable || isBusy) {
      return;
    }
    setFormState({
      title: prGate.draftTitle,
      description: prGate.draftDescription,
      baseBranch: prGate.draftBaseBranch,
      draft: false,
      reviewers: [],
      updateJira: prGate.jiraContext !== null,
    });
    setReviewerInput('');
    setFieldErrors({});
    setConfirmingPublish(false);
    setSubmitError(null);
    setStatusMessage('Rascunho original gerado pela Etapa 1 restaurado.');
  }

  function appendReviewersFromInput(rawValue: string): string[] | null {
    const parsed = parsePrReviewersInput(rawValue);
    if (parsed.length === 0) {
      return formState.reviewers;
    }

    const existingKeys = new Set(formState.reviewers.map(item => item.toLowerCase()));
    const merged = [...formState.reviewers];
    for (const candidate of parsed) {
      const check = FactoryPrReviewerSchema.safeParse(candidate);
      if (!check.success) {
        setFieldErrors(current => ({
          ...current,
          reviewers: check.error.issues[0]?.message ?? 'Identificador de reviewer inválido.',
        }));
        return null;
      }
      const key = check.data.toLowerCase();
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        merged.push(check.data);
      }
    }

    if (merged.length > 50) {
      setFieldErrors(current => ({
        ...current,
        reviewers: 'Informe no máximo 50 reviewers.',
      }));
      return null;
    }

    setFormState(current => ({ ...current, reviewers: merged }));
    setReviewerInput('');
    setFieldErrors(current => ({ ...current, reviewers: undefined }));
    setConfirmingPublish(false);
    clearFeedback();
    return merged;
  }

  function handleReviewerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      appendReviewersFromInput(reviewerInput);
    }
  }

  function handleRemoveReviewer(reviewer: string) {
    if (!editable || isBusy) {
      return;
    }
    setFormState(current => ({
      ...current,
      reviewers: current.reviewers.filter(item => item !== reviewer),
    }));
    setFieldErrors(current => ({ ...current, reviewers: undefined }));
    setConfirmingPublish(false);
    clearFeedback();
  }

  function resolveValidatedPayload() {
    let effectiveReviewers = formState.reviewers;
    if (reviewerInput.trim().length > 0) {
      const merged = appendReviewersFromInput(reviewerInput);
      if (merged === null) {
        return null;
      }
      effectiveReviewers = merged;
    }

    const validation = validateFactoryPrReviewForm({
      title: formState.title,
      description: formState.description,
      baseBranch: formState.baseBranch,
      draft: formState.draft,
      reviewers: effectiveReviewers,
      updateJira: hasJiraContext ? formState.updateJira : false,
    });

    if (!validation.valid) {
      setFieldErrors(validation.errors);
      setConfirmingPublish(false);
      return null;
    }

    setFieldErrors({});
    return validation.data;
  }

  async function submitPrReview(confirmPublish: boolean) {
    if (!effectiveEditable || isBusy) {
      return;
    }
    clearFeedback();
    const validated = resolveValidatedPayload();
    if (!validated) {
      return;
    }

    try {
      await onSavePrReview({
        ...validated,
        confirmPublish,
        expectedUpdatedAt: flow.updatedAt,
      });
      setConfirmingPublish(false);
      setStatusMessage(
        confirmPublish
          ? 'Parâmetros confirmados para publicação do PR.'
          : 'Alterações salvas no rascunho de revisão (sem executar push ou criação de PR).',
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Não foi possível salvar os parâmetros revisados do Pull Request.',
      );
    }
  }

  function handlePrepareConfirmation() {
    if (!effectiveEditable || isBusy) {
      return;
    }
    clearFeedback();
    const validated = resolveValidatedPayload();
    if (!validated) {
      return;
    }
    setConfirmingPublish(true);
  }

  async function handlePublishPullRequest() {
    if (!effectiveEditable || isBusy || !onPublishPr) {
      return;
    }
    clearFeedback();
    try {
      await onPublishPr({ expectedUpdatedAt: flow.updatedAt });
      setStatusMessage('Pull Request publicado com sucesso.');
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Não foi possível publicar o Pull Request.',
      );
    }
  }

  async function handleRetryJiraComment() {
    if (isBusy || !onRetryPrJiraSync) {
      return;
    }
    clearFeedback();
    try {
      await onRetryPrJiraSync();
      setStatusMessage('Comentário publicado no card do Jira com sucesso.');
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Não foi possível reenviar o comentário ao card do Jira.',
      );
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrReview(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-primary">
              Revisão Humana Pré-Publicação do Pull Request (Bloco 06)
            </h3>
            {prGate.iteration > 0 && (
              <span className="rounded-full border border-accent/30 bg-selected px-2 py-0.5 font-mono text-[10px] text-accent">
                Iteração {prGate.iteration}
              </span>
            )}
            {prGate.confirmedForPublish && (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-selected px-2.5 py-0.5 text-[10px] font-medium text-accent">
                <ShieldCheck size={11} />
                Publicação confirmada
              </span>
            )}
          </div>
          <p className="text-xs text-muted">
            Revise e ajuste título, descrição Markdown, branch destino, modo Draft, reviewers e
            integração com Jira. Nenhuma ação irreversível (push/criação de PR) ocorre antes da
            confirmação explícita neste formulário.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onViewMarkdown && (
            <button
              type="button"
              onClick={() => onViewMarkdown(prGate.prReportPath)}
              className="modal-button border-accent/35 px-2.5 py-1 text-[11px] text-accent hover:bg-selected"
            >
              <FileText size={12} />
              Ver pr_summary
            </button>
          )}
          {effectiveEditable && isDirtyFromDraft && (
            <button
              type="button"
              disabled={isBusy}
              onClick={handleRestoreStage1Draft}
              className="modal-button px-2.5 py-1 text-[11px] disabled:opacity-60"
            >
              <RotateCcw size={12} />
              Restaurar rascunho da Etapa 1
            </button>
          )}
        </div>
      </div>

      {isPublished && publication.prUrl && (
        <div
          role="status"
          className="space-y-3 rounded-xl border border-accent/45 bg-selected/55 px-4 py-3.5 text-xs text-primary"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-accent">
                    Pull Request publicado
                    {publication.prNumber ? ` #${publication.prNumber}` : ''}
                  </p>
                  {publication.provider && (
                    <span className="rounded-full border border-accent/30 bg-page px-2 py-0.5 font-mono text-[10px] text-secondary">
                      {publication.provider === 'gitlab' ? 'GitLab' : 'GitHub'}
                    </span>
                  )}
                  {publication.draft && (
                    <span className="rounded-full border border-line bg-page px-2 py-0.5 font-mono text-[10px] text-muted">
                      Draft
                    </span>
                  )}
                </div>
                <p className="font-mono text-[11px] text-secondary">
                  {publication.headBranch} → {publication.baseBranch}
                  {publication.commitSha ? ` · commit ${publication.commitSha.slice(0, 7)}` : ''}
                </p>
              </div>
            </div>

            <a
              href={publication.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="modal-button border-accent/40 bg-page px-3 py-1.5 text-xs font-medium text-accent hover:bg-selected"
            >
              Abrir Pull Request
              <ExternalLink size={12} />
            </a>
          </div>

          {publication.jiraSync.status === 'updated' && (
            <p className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-page px-3 py-2 text-[11px] text-accent">
              <CheckCircle2 size={13} className="shrink-0" />
              <span>
                Comentário com link do PR e resumo das evidências publicado no card{' '}
                <strong className="font-mono">{publication.jiraSync.issueKey}</strong>.
              </span>
            </p>
          )}

          {publication.jiraSync.status === 'failed' && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-warning/45 bg-warning/10 px-3 py-2.5 text-[11px] text-primary"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                <div className="min-w-0 space-y-0.5">
                  <p className="font-semibold text-warning">
                    PR preservado, mas falhou ao comentar no Jira{' '}
                    {publication.jiraSync.issueKey ? `(${publication.jiraSync.issueKey})` : ''}
                  </p>
                  {publication.jiraSync.error && (
                    <p className="wrap-anywhere text-secondary">{publication.jiraSync.error}</p>
                  )}
                </div>
              </div>
              {onRetryPrJiraSync && (
                <button
                  type="button"
                  disabled={isBusy}
                  aria-busy={busyAction === 'jira'}
                  onClick={() => {
                    void handleRetryJiraComment();
                  }}
                  className="modal-button shrink-0 border-warning/45 bg-page px-3 py-1.5 text-[11px] font-medium text-warning hover:bg-warning/10 disabled:opacity-60"
                >
                  {busyAction === 'jira' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCcw size={12} />
                  )}
                  Reenviar comentário ao Jira
                </button>
              )}
            </div>
          )}

          {publication.jiraSync.status === 'not_requested' && publication.jiraSync.issueKey && (
            <p className="text-[11px] text-muted">
              Atualização automática do card {publication.jiraSync.issueKey} não solicitada.
            </p>
          )}
        </div>
      )}

      {publication?.status === 'blocked_by_secrets' && (
        <div
          role="alert"
          className="space-y-2.5 rounded-xl border border-danger/45 bg-danger/10 px-4 py-3 text-xs text-primary"
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <div className="space-y-1">
              <p className="font-semibold text-danger">
                Publicação bloqueada pelo secret scanning (antes de git push)
              </p>
              {publication.error && <p className="text-[11px] text-secondary">{publication.error}</p>}
            </div>
          </div>
          {publication.secretFindings.length > 0 && (
            <ul
              aria-label="Segredos suspeitos detectados no diff"
              className="space-y-1.5 pl-6 text-[11px]"
            >
              {publication.secretFindings.map((finding, index) => (
                <li
                  key={`${finding.file}:${finding.line}:${index}`}
                  className="rounded-lg border border-danger/30 bg-page px-2.5 py-1.5"
                >
                  <p className="font-mono font-semibold text-danger">
                    {finding.file}:{finding.line}{' '}
                    <span className="font-sans font-normal text-secondary">· {finding.rule}</span>
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {finding.snippet}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {publication?.status === 'failed' && publication.error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3 text-xs text-danger"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="font-semibold">Falha na publicação do Pull Request</p>
            <p className="text-[11px]">{publication.error}</p>
          </div>
        </div>
      )}

      {prGate.confirmedForPublish && !isPublished && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-selected/50 px-3.5 py-3 text-xs text-primary"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-accent" />
            <div className="space-y-0.5">
              <p className="font-semibold text-accent">
                Parâmetros finais revisados e confirmados para publicação
              </p>
              <p className="text-[11px] text-secondary">
                O envio determinístico (secret scanning, commit/push e abertura do PR) usará estes
                parâmetros confirmados.
              </p>
            </div>
          </div>
          {effectiveEditable && onPublishPr && (
            <button
              type="button"
              disabled={isBusy}
              aria-busy={busyAction === 'publish'}
              onClick={() => {
                void handlePublishPullRequest();
              }}
              className="modal-button shrink-0 border-accent bg-accent px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
            >
              {busyAction === 'publish' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              Publicar Pull Request
            </button>
          )}
        </div>
      )}

      {statusMessage && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-accent/35 bg-selected/40 px-3 py-2 text-xs text-accent"
        >
          <CheckCircle2 size={14} className="shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {submitError && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <AlertCircle size={14} className="shrink-0" />
          <span>{submitError}</span>
        </p>
      )}

      <form onSubmit={handleFormSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor={`${formId}-title`}
                className="text-xs font-semibold text-primary"
              >
                Título do Pull Request
              </label>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                  conventionalTitle
                    ? 'border-accent/30 bg-selected text-accent'
                    : 'border-warning/35 bg-warning/10 text-warning'
                }`}
              >
                {conventionalTitle
                  ? 'Conventional Commits'
                  : 'Sugestão: tipo(escopo?): descrição'}
              </span>
            </div>
            <input
              id={`${formId}-title`}
              type="text"
              value={formState.title}
              maxLength={200}
              disabled={!effectiveEditable || isBusy}
              aria-invalid={fieldErrors.title !== undefined}
              aria-describedby={
                fieldErrors.title ? `${formId}-title-error` : undefined
              }
              onChange={event => {
                setFormState(current => ({ ...current, title: event.target.value }));
                setFieldErrors(current => ({ ...current, title: undefined }));
                setConfirmingPublish(false);
                clearFeedback();
              }}
              placeholder="feat(escopo): descreva a entrega do PR"
              className="w-full rounded-lg border border-line bg-page px-3 py-2 text-xs text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70"
            />
            {fieldErrors.title && (
              <p
                id={`${formId}-title-error`}
                role="alert"
                className="text-[11px] text-danger"
              >
                {fieldErrors.title}
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className="block text-xs font-semibold text-primary">
                Branch de origem (headBranch)
              </span>
              <div className="flex items-center gap-2 rounded-lg border border-line bg-page px-3 py-2 font-mono text-xs text-secondary">
                <GitBranch size={13} className="shrink-0 text-accent" />
                <span className="truncate" title={prGate.headBranch}>
                  {prGate.headBranch}
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={`${formId}-base-branch`}
                className="block text-xs font-semibold text-primary"
              >
                Branch destino (baseBranch)
              </label>
              <input
                id={`${formId}-base-branch`}
                type="text"
                value={formState.baseBranch}
                maxLength={255}
                disabled={!effectiveEditable || isBusy}
                aria-invalid={fieldErrors.baseBranch !== undefined}
                aria-describedby={
                  fieldErrors.baseBranch ? `${formId}-base-branch-error` : undefined
                }
                onChange={event => {
                  setFormState(current => ({ ...current, baseBranch: event.target.value }));
                  setFieldErrors(current => ({ ...current, baseBranch: undefined }));
                  setConfirmingPublish(false);
                  clearFeedback();
                }}
                placeholder="main"
                className="w-full rounded-lg border border-line bg-page px-3 py-2 font-mono text-xs text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70"
              />
              {fieldErrors.baseBranch && (
                <p
                  id={`${formId}-base-branch-error`}
                  role="alert"
                  className="text-[11px] text-danger"
                >
                  {fieldErrors.baseBranch}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor={`${formId}-description`}
                className="text-xs font-semibold text-primary"
              >
                Descrição Markdown do Pull Request
              </label>
              <div
                role="group"
                aria-label="Modo de visualização da descrição"
                className="inline-flex rounded-lg border border-line bg-page p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={descriptionMode === 'edit'}
                  onClick={() => setDescriptionMode('edit')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    descriptionMode === 'edit'
                      ? 'bg-selected text-accent'
                      : 'text-muted hover:text-primary'
                  }`}
                >
                  <Pencil size={11} />
                  Editar
                </button>
                <button
                  type="button"
                  aria-pressed={descriptionMode === 'preview'}
                  onClick={() => setDescriptionMode('preview')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                    descriptionMode === 'preview'
                      ? 'bg-selected text-accent'
                      : 'text-muted hover:text-primary'
                  }`}
                >
                  <Eye size={11} />
                  Pré-visualizar
                </button>
              </div>
            </div>

            {descriptionMode === 'edit' ? (
              <textarea
                id={`${formId}-description`}
                value={formState.description}
                rows={11}
                maxLength={65_536}
                disabled={!effectiveEditable || isBusy}
                aria-invalid={fieldErrors.description !== undefined}
                aria-describedby={
                  fieldErrors.description ? `${formId}-description-error` : undefined
                }
                onChange={event => {
                  setFormState(current => ({ ...current, description: event.target.value }));
                  setFieldErrors(current => ({ ...current, description: undefined }));
                  setConfirmingPublish(false);
                  clearFeedback();
                }}
                placeholder="Descreva as alterações, critérios de aceite e evidências de validação em Markdown..."
                className="w-full rounded-lg border border-line bg-page p-3 font-mono text-xs leading-5 text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70"
              />
            ) : (
              <div
                aria-label="Pré-visualização da descrição Markdown"
                className="max-h-96 overflow-y-auto rounded-lg border border-line bg-page p-3.5 text-xs"
              >
                {formState.description.trim().length > 0 ? (
                  <MarkdownContent content={formState.description} />
                ) : (
                  <p className="text-muted">Nenhuma descrição informada para pré-visualizar.</p>
                )}
              </div>
            )}

            {fieldErrors.description && (
              <p
                id={`${formId}-description-error`}
                role="alert"
                className="text-[11px] text-danger"
              >
                {fieldErrors.description}
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-line-subtle pt-3">
            <label
              htmlFor={`${formId}-reviewer-input`}
              className="block text-xs font-semibold text-primary"
            >
              Reviewers
            </label>
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-0 flex-1">
                <UserPlus
                  size={13}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id={`${formId}-reviewer-input`}
                  type="text"
                  value={reviewerInput}
                  disabled={!effectiveEditable || isBusy}
                  aria-invalid={fieldErrors.reviewers !== undefined}
                  aria-describedby={
                    fieldErrors.reviewers ? `${formId}-reviewers-error` : `${formId}-reviewers-help`
                  }
                  onChange={event => {
                    setReviewerInput(event.target.value);
                    setFieldErrors(current => ({ ...current, reviewers: undefined }));
                  }}
                  onKeyDown={handleReviewerKeyDown}
                  placeholder="Adicione usuários ou times (ex.: maria.silva, org/time)"
                  className="w-full rounded-lg border border-line bg-page py-2 pl-8 pr-3 text-xs text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70"
                />
              </div>
              {effectiveEditable && (
                <button
                  type="button"
                  disabled={isBusy || reviewerInput.trim().length === 0}
                  onClick={() => appendReviewersFromInput(reviewerInput)}
                  className="modal-button px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  <Plus size={13} />
                  Adicionar
                </button>
              )}
            </div>
            <p id={`${formId}-reviewers-help`} className="text-[11px] text-muted">
              Separe múltiplos reviewers por vírgula ou espaço e pressione Enter ou Adicionar.
            </p>
            {fieldErrors.reviewers && (
              <p
                id={`${formId}-reviewers-error`}
                role="alert"
                className="text-[11px] text-danger"
              >
                {fieldErrors.reviewers}
              </p>
            )}
            {formState.reviewers.length > 0 && (
              <ul
                aria-label="Lista de reviewers selecionados"
                className="flex flex-wrap gap-1.5 pt-1"
              >
                {formState.reviewers.map(reviewer => (
                  <li
                    key={reviewer}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-selected px-2.5 py-1 font-mono text-[11px] text-accent"
                  >
                    <span>@{reviewer}</span>
                    {effectiveEditable && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleRemoveReviewer(reviewer)}
                        aria-label={`Remover reviewer ${reviewer}`}
                        className="rounded-full p-0.5 text-accent/80 transition hover:bg-accent/15 hover:text-accent disabled:opacity-50"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 border-t border-line-subtle pt-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-page p-3 text-xs">
              <input
                type="checkbox"
                checked={formState.draft}
                disabled={!effectiveEditable || isBusy}
                onChange={event => {
                  setFormState(current => ({ ...current, draft: event.target.checked }));
                  setConfirmingPublish(false);
                  clearFeedback();
                }}
                className="mt-0.5 size-4 accent-accent"
              />
              <span className="space-y-0.5">
                <span className="block font-semibold text-primary">Abrir como Draft PR</span>
                <span className="block text-[11px] text-muted">
                  Cria o Pull Request em modo rascunho (<code>--draft</code>) para revisão inicial.
                </span>
              </span>
            </label>

            <label
              className={`flex items-start gap-2.5 rounded-xl border border-line bg-page p-3 text-xs ${
                hasJiraContext ? 'cursor-pointer' : 'opacity-70'
              }`}
            >
              <input
                type="checkbox"
                checked={hasJiraContext ? formState.updateJira : false}
                disabled={!effectiveEditable || isBusy || !hasJiraContext}
                onChange={event => {
                  setFormState(current => ({ ...current, updateJira: event.target.checked }));
                  setConfirmingPublish(false);
                  clearFeedback();
                }}
                className="mt-0.5 size-4 accent-accent"
              />
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5 font-semibold text-primary">
                  <span>Comentar/atualizar card no Jira</span>
                  {prGate.jiraContext && (
                    <span className="rounded border border-accent/30 bg-selected px-1.5 py-0.5 font-mono text-[10px] text-accent">
                      {prGate.jiraContext.key}
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-muted">
                  {prGate.jiraContext
                    ? 'Registra comentário com o link do PR e resumo das evidências no card vinculado.'
                    : 'Nenhum card do Jira vinculado na Triagem deste fluxo.'}
                </span>
                {prGate.jiraContext?.url && (
                  <a
                    href={prGate.jiraContext.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                  >
                    Abrir {prGate.jiraContext.key}
                    <ExternalLink size={10} />
                  </a>
                )}
              </span>
            </label>
          </div>
        </div>

        {(prGate.satisfiedAcceptanceCriteriaIds.length > 0 || prGate.evidence.length > 0) && (
          <div className="rounded-xl border border-line bg-surface p-3.5 text-xs">
            <p className="font-semibold text-primary">
              Evidências consolidadas pela Etapa 1
            </p>
            {prGate.satisfiedAcceptanceCriteriaIds.length > 0 && (
              <p className="mt-1 text-[11px] text-secondary">
                Critérios de aceite atendidos:{' '}
                <span className="font-mono text-accent">
                  {prGate.satisfiedAcceptanceCriteriaIds.join(', ')}
                </span>
              </p>
            )}
            {prGate.evidence.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-muted">
                {prGate.evidence.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {effectiveEditable && (
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="submit"
                disabled={isBusy}
                aria-busy={busyAction === 'pr'}
                className="modal-button px-3 py-1.5 text-xs disabled:opacity-60"
              >
                {busyAction === 'pr' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Save size={13} />
                )}
                Salvar revisão
              </button>

              {!confirmingPublish && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={handlePrepareConfirmation}
                  className="modal-button border-accent/40 bg-selected/60 px-3.5 py-1.5 text-xs font-medium text-accent hover:bg-selected disabled:opacity-60"
                >
                  <GitPullRequest size={13} />
                  Revisar e confirmar publicação
                </button>
              )}
            </div>

            {confirmingPublish && (
              <div
                role="region"
                aria-label="Confirmação explícita para publicação do Pull Request"
                className="space-y-3 rounded-xl border border-accent/40 bg-selected/35 p-3.5 text-xs"
              >
                <div className="space-y-1">
                  <p className="font-semibold text-accent">
                    Confirmar parâmetros finais para publicação do PR
                  </p>
                  <p className="text-[11px] text-secondary">
                    Confira os dados abaixo antes de confirmar. Nenhuma ação externa irreversível
                    (push ou abertura de PR) ocorre antes desta confirmação explícita.
                  </p>
                </div>

                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-line bg-page p-2.5 text-[11px]">
                  <dt className="text-muted">Título</dt>
                  <dd className="font-medium text-primary">{formState.title.trim()}</dd>
                  <dt className="text-muted">Branches</dt>
                  <dd className="font-mono text-secondary">
                    {prGate.headBranch} → {formState.baseBranch.trim()}
                  </dd>
                  <dt className="text-muted">Modo</dt>
                  <dd className="text-secondary">
                    {formState.draft ? 'Draft PR (--draft)' : 'PR pronto para revisão'}
                  </dd>
                  <dt className="text-muted">Reviewers</dt>
                  <dd className="font-mono text-secondary">
                    {formState.reviewers.length > 0
                      ? formState.reviewers.map(item => `@${item}`).join(', ')
                      : 'Nenhum reviewer selecionado'}
                  </dd>
                  <dt className="text-muted">Jira</dt>
                  <dd className="text-secondary">
                    {hasJiraContext && formState.updateJira
                      ? `Comentar e atualizar ${prGate.jiraContext?.key}`
                      : 'Não atualizar Jira'}
                  </dd>
                </dl>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => setConfirmingPublish(false)}
                    className="modal-button px-3 py-1.5 text-xs disabled:opacity-60"
                  >
                    Voltar à edição
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-busy={busyAction === 'pr'}
                    onClick={() => {
                      void submitPrReview(true);
                    }}
                    className="modal-button border-accent bg-accent px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
                  >
                    {busyAction === 'pr' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <ShieldCheck size={13} />
                    )}
                    Confirmar publicação do PR
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
