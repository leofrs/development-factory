import { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  FACTORY_APPROVED_NOTES_MAX_LENGTH,
  type FactoryFlow,
  type FactoryReviewFindingDecision,
  type FactoryReviewFindingSeverity,
  type FactoryReviewFindingTriageAction,
  type FactoryReviewGate,
  type FactoryReviewTriagedFinding,
  type ReturnFactoryTargetStage,
} from '@development-factory/shared';
import { getFactoryReviewVerdictPresentation } from '../utils/factory-flow-status.js';

type SeverityFilter = 'all' | FactoryReviewFindingSeverity;

interface FactoryFlowFindingsPanelProps {
  flow: FactoryFlow;
  reviewGate: FactoryReviewGate | null | undefined;
  editable: boolean;
  canReturnToTests: boolean;
  busyAction: 'advance' | 'rerun' | 'return' | 'cancel' | 'triage' | null;
  onSaveTriage: (decisions: FactoryReviewFindingDecision[]) => Promise<void>;
  onReturnToStage: (targetStage: ReturnFactoryTargetStage, approvedNotes?: string) => Promise<void>;
  onAdvanceToPr: () => Promise<void>;
  onOpenDiffLocation?: (file: string, line: number) => void;
}

const SEVERITY_BADGE_CLASSES: Readonly<Record<FactoryReviewFindingSeverity, string>> = {
  BLOQUEANTE: 'border-danger/40 bg-danger/10 text-danger',
  SUGESTÃO: 'border-warning/40 bg-warning/10 text-warning',
  NIT: 'border-line bg-page text-secondary',
};

const ACTION_BADGE_LABELS: Readonly<
  Record<
    FactoryReviewFindingTriageAction,
    { readonly label: string; readonly className: string }
  >
> = {
  pending: {
    label: 'Aguardando triagem',
    className: 'border-line bg-page text-muted',
  },
  approve_fix: {
    label: 'Correção aprovada',
    className: 'border-accent/40 bg-selected text-accent',
  },
  promote_mandatory: {
    label: 'Promovida a obrigatória',
    className: 'border-danger/40 bg-danger/10 text-danger',
  },
  dismiss_false_positive: {
    label: 'Falso positivo descartado',
    className: 'border-line-subtle bg-page text-muted line-through',
  },
};

function toPersistedDecisions(
  findings: readonly FactoryReviewTriagedFinding[],
  override?: {
    readonly findingId: string;
    readonly action: FactoryReviewFindingTriageAction;
    readonly justification?: string;
  },
): FactoryReviewFindingDecision[] {
  const decisions: FactoryReviewFindingDecision[] = [];
  for (const finding of findings) {
    const nextAction =
      override && override.findingId === finding.id ? override.action : finding.action;
    if (nextAction === 'pending') {
      continue;
    }
    const nextJustification =
      override && override.findingId === finding.id
        ? override.justification
        : finding.justification;
    const trimmed = nextJustification?.trim();
    decisions.push({
      findingId: finding.id,
      action: nextAction,
      ...(nextAction === 'dismiss_false_positive' && trimmed ? { justification: trimmed } : {}),
    });
  }
  return decisions;
}

export function FactoryFlowFindingsPanel({
  flow,
  reviewGate,
  editable,
  canReturnToTests,
  busyAction,
  onSaveTriage,
  onReturnToStage,
  onAdvanceToPr,
  onOpenDiffLocation,
}: FactoryFlowFindingsPanelProps) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [dismissDraftId, setDismissDraftId] = useState<string | null>(null);
  const [dismissJustification, setDismissJustification] = useState('');
  const [returnNotes, setReturnNotes] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const visibleFindings = useMemo(() => {
    if (!reviewGate) {
      return [];
    }
    if (severityFilter === 'all') {
      return reviewGate.findings;
    }
    return reviewGate.findings.filter(finding => finding.severity === severityFilter);
  }, [reviewGate, severityFilter]);

  if (!reviewGate) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 text-xs text-muted">
        Nenhum relatório de Code Review (Bloco 05) pronto para triagem neste fluxo ainda.
      </div>
    );
  }

  const verdictPresentation = getFactoryReviewVerdictPresentation(reviewGate.verdict);
  const { counts } = reviewGate;
  const isBusy = busyAction !== null;
  const returnScopeCount = reviewGate.findings.filter(item => item.includedInReturnScope).length;

  async function applyFindingAction(
    findingId: string,
    action: FactoryReviewFindingTriageAction,
    justification?: string,
  ) {
    if (!reviewGate || isBusy) {
      return;
    }
    setLocalError(null);
    const nextDecisions = toPersistedDecisions(reviewGate.findings, {
      findingId,
      action,
      justification,
    });
    try {
      await onSaveTriage(nextDecisions);
      if (dismissDraftId === findingId) {
        setDismissDraftId(null);
        setDismissJustification('');
      }
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : 'Não foi possível salvar a decisão de triagem.',
      );
    }
  }

  const filterButtons: Array<{
    readonly id: SeverityFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    { id: 'all', label: 'Todos', count: counts.total },
    { id: 'BLOQUEANTE', label: 'BLOQUEANTE', count: counts.blocking },
    { id: 'SUGESTÃO', label: 'SUGESTÃO', count: counts.suggestion },
    { id: 'NIT', label: 'NIT', count: counts.nit },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-primary">
              Triagem de Findings do Code Review (Bloco 05)
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[10px] font-medium ${verdictPresentation.textClass}`}
            >
              <span className={`size-1.5 rounded-full ${verdictPresentation.dotClass}`} />
              {verdictPresentation.label}
            </span>
            {reviewGate.iteration > 0 && (
              <span className="rounded-full border border-accent/30 bg-selected px-2 py-0.5 font-mono text-[10px] text-accent">
                Iteração {reviewGate.iteration}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Aprove correções, descarte falsos positivos ou promova sugestões antes de retornar o
            fluxo ou liberar o Bloco 06 (PR).
          </p>
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Bloqueantes ativos</p>
          <p
            className={`mt-1 font-mono text-base font-semibold ${
              counts.activeBlockers > 0 ? 'text-danger' : 'text-accent'
            }`}
          >
            {counts.activeBlockers}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Correções aprovadas</p>
          <p className="mt-1 font-mono text-base font-semibold text-primary">
            {counts.approvedForFix}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Sugestões promovidas</p>
          <p className="mt-1 font-mono text-base font-semibold text-warning">
            {counts.promotedMandatory}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Falsos positivos descartados</p>
          <p className="mt-1 font-mono text-base font-semibold text-secondary">
            {counts.dismissed}
          </p>
        </div>
      </div>

      {localError && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <AlertCircle size={14} className="shrink-0" />
          {localError}
        </p>
      )}

      <div
        role="group"
        aria-label="Filtrar findings por severidade"
        className="flex flex-wrap items-center gap-1.5"
      >
        {filterButtons.map(button => {
          const active = severityFilter === button.id;
          return (
            <button
              key={button.id}
              type="button"
              aria-pressed={active}
              onClick={() => setSeverityFilter(button.id)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                active
                  ? 'border-accent bg-selected text-accent'
                  : 'border-line bg-surface text-secondary hover:bg-hover'
              }`}
            >
              {button.label} ({button.count})
            </button>
          );
        })}
      </div>

      {counts.total === 0 ? (
        <div className="rounded-xl border border-accent/30 bg-selected/30 p-4 text-xs text-accent">
          Nenhum apontamento registrado no sidecar do Code Review. Fluxo liberado para o Bloco 06
          (PR).
        </div>
      ) : visibleFindings.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-4 text-xs text-muted">
          Nenhum apontamento com a severidade selecionada.
        </div>
      ) : (
        <ul className="space-y-3" aria-label="Lista de findings do Code Review">
          {visibleFindings.map(finding => {
            const actionBadge = ACTION_BADGE_LABELS[finding.action];
            const isDismissDraftOpen = dismissDraftId === finding.id;
            const isDismissed = finding.action === 'dismiss_false_positive';
            const isPromoted = finding.action === 'promote_mandatory';

            return (
              <li key={finding.id}>
                <article
                  aria-label={`Finding ${finding.id} · ${finding.severity}`}
                  className={`space-y-3 rounded-xl border p-4 transition ${
                    finding.isActiveBlocker
                      ? 'border-danger/40 bg-surface'
                      : isDismissed
                        ? 'border-line-subtle bg-surface/60 opacity-85'
                        : 'border-line bg-surface'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded border border-accent/35 bg-selected px-2 py-0.5 font-mono text-[11px] font-semibold text-accent">
                        {finding.id}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${SEVERITY_BADGE_CLASSES[finding.severity]}`}
                      >
                        {finding.severity}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${actionBadge.className}`}
                      >
                        {actionBadge.label}
                      </span>
                      {finding.isActiveBlocker && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-danger/35 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                          <ShieldAlert size={10} aria-hidden="true" />
                          Bloqueante ativo
                        </span>
                      )}
                      {finding.category && (
                        <span className="rounded border border-line bg-page px-2 py-0.5 font-mono text-[10px] text-muted">
                          {finding.category}
                        </span>
                      )}
                    </div>

                    {onOpenDiffLocation ? (
                      <button
                        type="button"
                        onClick={() => onOpenDiffLocation(finding.file, finding.line)}
                        aria-label={`Abrir ${finding.file} linha ${finding.line} no diff`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-accent/35 bg-page px-2.5 py-1 font-mono text-[11px] text-accent transition hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <bdi>
                          {finding.file}:{finding.line}
                        </bdi>
                        <ExternalLink size={11} aria-hidden="true" />
                      </button>
                    ) : (
                      <code className="rounded-md border border-line bg-page px-2 py-1 font-mono text-[11px] text-secondary">
                        {finding.file}:{finding.line}
                      </code>
                    )}
                  </div>

                  <p className="whitespace-pre-wrap break-words text-xs leading-5 text-primary">
                    {finding.explanation}
                  </p>

                  {isDismissed && finding.justification && (
                    <div className="rounded-lg border border-line bg-page px-3 py-2 text-[11px] text-secondary">
                      <span className="font-medium text-primary">Justificativa: </span>
                      <span>{finding.justification}</span>
                    </div>
                  )}

                  {editable && (
                    <div className="space-y-2 border-t border-line-subtle pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          aria-busy={busyAction === 'triage'}
                          aria-pressed={finding.action === 'approve_fix'}
                          onClick={() => {
                            void applyFindingAction(
                              finding.id,
                              finding.action === 'approve_fix' ? 'pending' : 'approve_fix',
                            );
                          }}
                          className={`modal-button px-2.5 py-1 text-[11px] disabled:opacity-60 ${
                            finding.action === 'approve_fix'
                              ? 'border-accent bg-selected text-accent'
                              : 'border-accent/35 text-accent hover:bg-selected'
                          }`}
                        >
                          <Check size={11} aria-hidden="true" />
                          {finding.action === 'approve_fix'
                            ? 'Correção aprovada'
                            : 'Aprovar correção'}
                        </button>

                        {finding.severity === 'SUGESTÃO' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            aria-busy={busyAction === 'triage'}
                            aria-pressed={isPromoted}
                            onClick={() => {
                              void applyFindingAction(
                                finding.id,
                                isPromoted ? 'pending' : 'promote_mandatory',
                              );
                            }}
                            className={`modal-button px-2.5 py-1 text-[11px] disabled:opacity-60 ${
                              isPromoted
                                ? 'border-danger bg-danger/15 text-danger'
                                : 'border-warning/40 text-warning hover:bg-warning/10'
                            }`}
                          >
                            <ArrowUpCircle size={11} aria-hidden="true" />
                            {isPromoted
                              ? 'Promovida a obrigatória'
                              : 'Promover a obrigatória'}
                          </button>
                        )}

                        {!isDismissed ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              setLocalError(null);
                              setDismissDraftId(current =>
                                current === finding.id ? null : finding.id,
                              );
                              setDismissJustification('');
                            }}
                            className="modal-button border-line px-2.5 py-1 text-[11px] text-secondary hover:bg-hover disabled:opacity-60"
                          >
                            <XCircle size={11} aria-hidden="true" />
                            Descartar falso positivo
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy}
                            aria-busy={busyAction === 'triage'}
                            onClick={() => {
                              void applyFindingAction(finding.id, 'pending');
                            }}
                            className="modal-button border-line px-2.5 py-1 text-[11px] text-secondary hover:bg-hover disabled:opacity-60"
                          >
                            <RotateCcw size={11} aria-hidden="true" />
                            Reabrir apontamento
                          </button>
                        )}
                      </div>

                      {isDismissDraftOpen && (
                        <div className="space-y-2 rounded-lg border border-line bg-page p-3">
                          <label className="grid gap-1 text-[11px] text-primary">
                            Justificativa do descarte (opcional)
                            <input
                              type="text"
                              value={dismissJustification}
                              maxLength={1000}
                              disabled={isBusy}
                              onChange={event => setDismissJustification(event.target.value)}
                              placeholder="Ex.: Validação já garantida pelo schema Zod na fronteira."
                              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-accent"
                            />
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={isBusy}
                              aria-busy={busyAction === 'triage'}
                              onClick={() => {
                                void applyFindingAction(
                                  finding.id,
                                  'dismiss_false_positive',
                                  dismissJustification,
                                );
                              }}
                              className="modal-button border-accent/40 bg-selected px-2.5 py-1 text-[11px] text-accent hover:bg-selected/80 disabled:opacity-60"
                            >
                              {busyAction === 'triage' ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <Check size={11} />
                              )}
                              Confirmar descarte
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                setDismissDraftId(null);
                                setDismissJustification('');
                              }}
                              className="modal-button px-2.5 py-1 text-[11px] text-muted"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <section
          aria-label="Decisão de transição após triagem do Code Review"
          className="space-y-3 rounded-xl border border-line bg-surface p-4"
        >
          <div
            role="status"
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
              reviewGate.canAdvanceToPr
                ? 'border-accent/35 bg-selected/50 text-accent'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {reviewGate.canAdvanceToPr ? (
              <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
            ) : (
              <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            )}
            <span>
              {reviewGate.canAdvanceToPr
                ? 'Nenhum bloqueante ativo restante. Você pode avançar o fluxo para o Bloco 06 (PR) ou retornar se desejar ajustes.'
                : `Restam ${counts.activeBlockers} ${
                    counts.activeBlockers === 1 ? 'bloqueante ativo' : 'bloqueantes ativos'
                  }. Retorne o fluxo para correção ou descarte os falsos positivos para liberar o Bloco 06 (PR).`}
            </span>
          </div>

          <label className="grid gap-1 text-xs text-primary">
            Notas adicionais para retorno (opcional)
            <textarea
              value={returnNotes}
              rows={2}
              maxLength={FACTORY_APPROVED_NOTES_MAX_LENGTH}
              disabled={isBusy}
              onChange={event => setReturnNotes(event.target.value)}
              placeholder="Instruções complementares para Desenvolvimento ou Testes..."
              className="rounded-lg border border-line bg-page p-2 text-xs focus-visible:outline-2 focus-visible:outline-accent"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isBusy}
              aria-busy={busyAction === 'return'}
              onClick={() => {
                setLocalError(null);
                void onReturnToStage('development', returnNotes.trim() || undefined).catch(
                  (error: unknown) => {
                    setLocalError(
                      error instanceof Error
                        ? error.message
                        : 'Não foi possível retornar para Desenvolvimento.',
                    );
                  },
                );
              }}
              className="modal-button border-warning/40 px-3 py-1.5 text-xs text-warning hover:bg-warning/10 disabled:opacity-60"
            >
              {busyAction === 'return' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )}
              Retornar para Desenvolvimento
              {returnScopeCount > 0 ? ` (${returnScopeCount})` : ''}
            </button>

            {canReturnToTests && (
              <button
                type="button"
                disabled={isBusy}
                aria-busy={busyAction === 'return'}
                onClick={() => {
                  setLocalError(null);
                  void onReturnToStage('tests', returnNotes.trim() || undefined).catch(
                    (error: unknown) => {
                      setLocalError(
                        error instanceof Error
                          ? error.message
                          : 'Não foi possível retornar para Testes.',
                      );
                    },
                  );
                }}
                className="modal-button border-warning/40 px-3 py-1.5 text-xs text-warning hover:bg-warning/10 disabled:opacity-60"
              >
                {busyAction === 'return' ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Retornar para Testes
                {returnScopeCount > 0 ? ` (${returnScopeCount})` : ''}
              </button>
            )}

            <button
              type="button"
              disabled={isBusy || !reviewGate.canAdvanceToPr}
              aria-busy={busyAction === 'advance'}
              onClick={() => {
                setLocalError(null);
                void onAdvanceToPr().catch((error: unknown) => {
                  setLocalError(
                    error instanceof Error
                      ? error.message
                      : 'Não foi possível avançar para PR.',
                  );
                });
              }}
              className="modal-button border-accent/40 bg-selected/60 px-3 py-1.5 text-xs text-accent hover:bg-selected disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'advance' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ArrowRight size={12} />
              )}
              Avançar para PR
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
