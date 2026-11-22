import { useId } from 'react';
import { ArrowUpRight, GitPullRequest, Loader2, RotateCcw, Square } from 'lucide-react';
import { FACTORY_STAGE_ORDER } from '@development-factory/shared';
import type { BackgroundSessionSummary, FactoryFlow } from '@development-factory/shared';
import {
  getFactoryFlowStatePresentation,
  getFactoryStageLabel,
  getFactoryStageStatePresentation,
  getFactoryStageStep,
} from '../utils/factory-flow-status.js';
import { FactoryLiveTerminalButton } from './FactoryLiveTerminalButton.js';
import { FactoryStageActivity } from './FactoryStageActivity.js';

interface FactoryFlowCardProps {
  flow: FactoryFlow;
  runningSession?: BackgroundSessionSummary;
  readyForPr: boolean;
  actionPending: boolean;
  actionError?: string;
  onOpenRoadmap: () => void;
  onOpenTerminal: () => boolean;
  onStop: () => void;
  onRerun: () => void;
}

function FactoryFlowProgress({ flow }: { flow: FactoryFlow }) {
  const currentIndex = FACTORY_STAGE_ORDER.indexOf(flow.currentStage);
  const currentState = flow.state === 'queued' ? 'pending' : flow.state;
  const completed = currentIndex + (currentState === 'completed' ? 1 : 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-secondary">
          {getFactoryStageStep(flow.currentStage)} · {getFactoryStageLabel(flow.currentStage)}
        </span>
        <span className="text-muted">
          {completed}/{FACTORY_STAGE_ORDER.length} concluídos
        </span>
      </div>
      <ol
        role="list"
        aria-label={`Progresso dos ${FACTORY_STAGE_ORDER.length} blocos`}
        className="grid grid-cols-6 gap-1"
      >
        {FACTORY_STAGE_ORDER.map((stage, index) => {
          const isCurrent = index === currentIndex;
          const otherState = index < currentIndex ? 'completed' : 'pending';
          const presentation = getFactoryStageStatePresentation(
            isCurrent ? currentState : otherState,
          );
          const label = `${getFactoryStageLabel(stage)} · ${presentation.label}`;
          return (
            <li
              key={stage}
              aria-current={isCurrent ? 'step' : undefined}
              title={label}
              className={`h-1.5 rounded-full ${presentation.dotClass} ${
                isCurrent ? 'outline outline-offset-1 outline-current' : ''
              } ${presentation.textClass}`}
            >
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function FactoryFlowCard({
  flow,
  runningSession,
  readyForPr,
  actionPending,
  actionError,
  onOpenRoadmap,
  onOpenTerminal,
  onStop,
  onRerun,
}: FactoryFlowCardProps) {
  const titleId = useId();
  const needsDecision = flow.state === 'waiting_action' && !readyForPr;
  const presentation = getFactoryFlowStatePresentation(flow.state);
  const decisions = flow.planningApproval?.decisions ?? [];
  const visibleDecisions = decisions.slice(0, 2);
  const canResume =
    needsDecision &&
    flow.currentSessionId === null &&
    flow.loopPausedReason !== null &&
    flow.error?.retryable !== false &&
    (flow.currentStage === 'development' ||
      flow.currentStage === 'tests' ||
      flow.currentStage === 'review');
  const roadmapLabel = needsDecision ? 'Revisar pendência' : 'Ver roadmap';
  const quickAction =
    readyForPr && !flow.prReview?.confirmedForPublish
      ? { label: 'Executar etapa PR', Icon: GitPullRequest, run: onRerun }
      : canResume
        ? { label: 'Retomar etapa', Icon: RotateCcw, run: onRerun }
        : flow.state === 'running'
          ? { label: 'Parar', Icon: Square, run: onStop }
          : null;
  const publishedPr = flow.prPublication?.status === 'published' ? flow.prPublication : null;

  return (
    <article
      aria-labelledby={titleId}
      className={`space-y-3 rounded-xl border p-3.5 ${
        needsDecision ? 'border-warning/40 bg-warning/5' : 'border-line bg-surface'
      }`}
    >
      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 font-medium ${
              readyForPr ? 'text-accent' : presentation.textClass
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${readyForPr ? 'bg-accent' : presentation.dotClass}`}
            />
            {readyForPr ? 'Aguardando disparo do PR' : presentation.label}
          </span>
          <span className="font-mono tabular-nums text-muted">
            {flow.iteration > 0 ? `Iteração ${flow.iteration}/${flow.maxIterations}` : 'Sem iteração'}
          </span>
        </div>
        <h4 id={titleId} className="wrap-anywhere text-sm font-semibold leading-5">
          {flow.title}
        </h4>
        <p className="mt-1 truncate font-mono text-[11px] text-muted" title={flow.target.repoPath}>
          {flow.target.repoPath}
        </p>
      </div>

      <FactoryFlowProgress flow={flow} />
      {runningSession && (
        <FactoryStageActivity key={runningSession.sessionId} session={runningSession} />
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-muted">Branch</dt>
        <dd className="wrap-anywhere font-mono text-secondary">
          {flow.branchName ?? 'Indisponível'}
        </dd>
        <dt className="text-muted">Worktree</dt>
        <dd className="wrap-anywhere font-mono text-secondary">
          {flow.worktreePath ?? 'Indisponível'}
        </dd>
        {publishedPr?.prUrl && (
          <>
            <dt className="text-muted">PR</dt>
            <dd className="wrap-anywhere font-mono text-accent">
              <a
                href={publishedPr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                {publishedPr.prNumber ? `#${publishedPr.prNumber}` : 'Ver PR'}
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
              {publishedPr.jiraSync.status === 'failed' && (
                <span className="ml-2 text-warning">· Jira pendente</span>
              )}
            </dd>
          </>
        )}
      </dl>

      <div className="space-y-1 rounded-lg border border-line-subtle bg-page/50 px-2.5 py-2">
        <p className="flex justify-between gap-2 text-xs text-muted">
          Decisões aprovadas
          <span className="font-mono tabular-nums text-secondary">{decisions.length}</span>
        </p>
        {visibleDecisions.length > 0 && (
          <ul className="space-y-1">
            {visibleDecisions.map(decision => (
              <li key={decision.id} className="flex gap-1.5 text-[11px] leading-4">
                <span className="shrink-0 font-mono text-accent">{decision.id}</span>
                <span
                  className="line-clamp-2 min-w-0 wrap-anywhere text-secondary"
                  title={decision.selectedOption}
                >
                  {decision.selectedOption}
                </span>
              </li>
            ))}
          </ul>
        )}
        {decisions.length > visibleDecisions.length && (
          <p className="text-[11px] text-muted">
            Mais {decisions.length - visibleDecisions.length} no roadmap
          </p>
        )}
      </div>

      {flow.loopPausedReason && (
        <p className="wrap-anywhere text-xs leading-5 text-warning">{flow.loopPausedReason}</p>
      )}
      {flow.error && (
        <p className="wrap-anywhere text-xs leading-5 text-danger">{flow.error.message}</p>
      )}
      {actionError && (
        <p role="alert" className="wrap-anywhere text-xs leading-5 text-danger">
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
        {runningSession && (
          <FactoryLiveTerminalButton
            key={runningSession.sessionId}
            title={flow.title}
            onOpen={onOpenTerminal}
          />
        )}
        <button
          type="button"
          onClick={onOpenRoadmap}
          aria-label={`${roadmapLabel} do fluxo ${flow.title}`}
          aria-haspopup="dialog"
          className={`modal-button ${needsDecision ? 'border-warning/35 text-warning' : 'text-secondary'}`}
        >
          {roadmapLabel}
          <ArrowUpRight size={13} aria-hidden="true" />
        </button>
        {quickAction && (
          <button
            type="button"
            onClick={() => {
              if (!actionPending) {
                quickAction.run();
              }
            }}
            aria-disabled={actionPending}
            aria-busy={actionPending}
            aria-label={`${actionPending ? 'Processando…' : quickAction.label} · ${flow.title}`}
            className={`modal-button aria-disabled:cursor-wait aria-disabled:opacity-60 ${
              flow.state === 'running'
                ? 'border-danger/30 text-danger hover:bg-danger/10'
                : 'border-accent/35 text-accent hover:bg-selected'
            }`}
          >
            {actionPending ? (
              <Loader2 size={13} aria-hidden="true" className="animate-spin" />
            ) : (
              <quickAction.Icon size={13} aria-hidden="true" />
            )}
            {actionPending ? 'Processando…' : quickAction.label}
          </button>
        )}
      </div>
    </article>
  );
}
