import { useMemo } from 'react';
import {
  ChevronRight,
  Compass,
  FileText,
  GitPullRequest,
  Loader2,
  Terminal,
  X,
} from 'lucide-react';
import {
  type BackgroundSessionSummary,
  type FactoryFlow,
} from '@development-factory/shared';
import {
  getFactoryFlowStatePresentation,
  getFactoryStageLabel,
  getFactoryStageStep,
  isFactoryFlowActivelyRunning,
} from '../utils/factory-flow-status';
import {
  getSessionStatusPresentation,
  isSessionActivelyRunning,
} from '../utils/session-status';

interface BackgroundTasksPopoverProps {
  id: string;
  sessions: BackgroundSessionSummary[];
  factoryFlows?: FactoryFlow[];
  activeSessionId?: string;
  loadingSessions?: boolean;
  sessionsError?: string | null;
  loadingFactoryFlows?: boolean;
  factoryFlowsError?: string | null;
  onOpenTerminal: (sessionId: string) => void;
  onOpenFlowRoadmap?: (flowId: string) => void;
  onViewReport: (reportPath: string) => void;
  onClose: () => void;
}

type BackgroundOperationItem =
  | {
      kind: 'flow';
      key: string;
      sortTime: number;
      flow: FactoryFlow;
      linkedSession?: BackgroundSessionSummary;
    }
  | {
      kind: 'session';
      key: string;
      sortTime: number;
      session: BackgroundSessionSummary;
    };

export function BackgroundTasksPopover({
  id,
  sessions,
  factoryFlows = [],
  activeSessionId,
  loadingSessions = false,
  sessionsError = null,
  loadingFactoryFlows = false,
  factoryFlowsError = null,
  onOpenTerminal,
  onOpenFlowRoadmap,
  onViewReport,
  onClose,
}: BackgroundTasksPopoverProps) {
  const items = useMemo<BackgroundOperationItem[]>(() => {
    const sessionsById = new Map<string, BackgroundSessionSummary>();
    const latestSessionByFlowId = new Map<string, BackgroundSessionSummary>();
    const flowIds = new Set(factoryFlows.map(flow => flow.id));

    for (const session of sessions) {
      sessionsById.set(session.sessionId, session);
      if (session.flowId && !latestSessionByFlowId.has(session.flowId)) {
        latestSessionByFlowId.set(session.flowId, session);
      }
    }

    const result: BackgroundOperationItem[] = [];

    for (const flow of factoryFlows) {
      const linkedSession =
        (flow.currentSessionId ? sessionsById.get(flow.currentSessionId) : undefined) ??
        latestSessionByFlowId.get(flow.id);
      result.push({
        kind: 'flow',
        key: `flow:${flow.id}`,
        sortTime: Date.parse(flow.updatedAt),
        flow,
        linkedSession,
      });
    }

    for (const session of sessions) {
      if (session.flowId && flowIds.has(session.flowId)) {
        continue;
      }
      result.push({
        kind: 'session',
        key: `session:${session.sessionId}`,
        sortTime: Date.parse(session.startedAt),
        session,
      });
    }

    return result.sort((a, b) => b.sortTime - a.sortTime);
  }, [factoryFlows, sessions]);

  const runningCount = useMemo(() => {
    let count = 0;
    for (const item of items) {
      if (item.kind === 'flow') {
        if (
          isFactoryFlowActivelyRunning(item.flow) ||
          (item.linkedSession ? isSessionActivelyRunning(item.linkedSession) : false)
        ) {
          count += 1;
        }
      } else if (isSessionActivelyRunning(item.session)) {
        count += 1;
      }
    }
    return count;
  }, [items]);

  const isLoading = (loadingSessions || loadingFactoryFlows) && items.length === 0;
  const combinedError = sessionsError ?? factoryFlowsError;

  return (
    <section
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby="background-tasks-title"
      className="pointer-events-auto absolute bottom-full left-1/2 mb-3 w-[min(calc(100vw-1.5rem),30rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-surface/95 text-primary shadow-2xl shadow-black/40 backdrop-blur-md"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line bg-elevated/80 px-4 py-3">
        <div className="min-w-0">
          <h2 id="background-tasks-title" className="text-xs font-semibold text-primary">
            Operações em background
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            {runningCount > 0
              ? `${runningCount} em execução`
              : `${items.length} ${items.length === 1 ? 'operação registrada' : 'operações registradas'}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar painel de operações"
          className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-primary"
        >
          <X size={14} />
        </button>
      </header>

      {combinedError && (
        <div
          role="alert"
          className="border-b border-danger/15 bg-danger/5 px-4 py-2.5 text-[11px] leading-5 text-danger"
        >
          {combinedError}
        </div>
      )}

      <div className="max-h-[52dvh] overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span>Carregando operações...</span>
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted">
            Nenhuma operação em execução ou recente nesta sessão.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {items.map(item => {
              if (item.kind === 'flow') {
                const { flow, linkedSession } = item;
                const stageStep = getFactoryStageStep(flow.currentStage);
                const stageLabel = getFactoryStageLabel(flow.currentStage);
                const meta =
                  linkedSession && linkedSession.status === 'running'
                    ? getSessionStatusPresentation(linkedSession)
                    : getFactoryFlowStatePresentation(flow.state);
                const isActive =
                  Boolean(activeSessionId) && linkedSession?.sessionId === activeSessionId;
                const reportPath = linkedSession?.reportPath ?? null;

                return (
                  <li
                    key={item.key}
                    className={`rounded-xl border p-3 transition ${
                      isActive
                        ? 'border-accent/40 bg-selected/40'
                        : 'border-line bg-page/70 hover:border-line-strong'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOpenFlowRoadmap?.(flow.id);
                        onClose();
                      }}
                      aria-label={`Abrir roadmap do fluxo ${flow.title}`}
                      className="flex w-full items-start justify-between gap-2 rounded-lg text-left transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-selected px-1.5 py-0.5 text-[10px] font-medium text-accent">
                            <Compass size={10} />
                            Factory
                          </span>
                          <span className="inline-flex items-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                            {stageStep} · {stageLabel}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${meta.textClass}`}
                          >
                            <span className={`size-1.5 rounded-full ${meta.dotClass}`} />
                            {meta.label}
                          </span>
                        </div>
                        <p
                          className="mt-1.5 truncate text-xs font-medium text-primary"
                          title={flow.title}
                        >
                          {flow.title}
                        </p>
                        <p
                          className="mt-0.5 truncate font-mono text-[10px] text-muted"
                          title={flow.target.repoPath}
                        >
                          {flow.target.repoPath}
                        </p>
                      </div>
                      <ChevronRight size={15} className="mt-1 shrink-0 text-muted" />
                    </button>

                    {reportPath && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className="modal-button border-accent/35 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected"
                          onClick={() => {
                            onViewReport(reportPath);
                            onClose();
                          }}
                        >
                          <FileText size={12} />
                          <span>{flow.currentStage === 'triage' ? 'Ver plano' : 'Ver artefato'}</span>
                        </button>
                      </div>
                    )}
                  </li>
                );
              }

              const { session } = item;
              const meta = getSessionStatusPresentation(session);
              const isFactory = session.mode === 'factory';
              const isActive = activeSessionId === session.sessionId;
              const reportPath =
                session.mode === 'factory' || session.historyState === 'saved'
                  ? session.reportPath
                  : null;

              return (
                <li
                  key={item.key}
                  className={`rounded-xl border p-3 transition ${
                    isActive
                      ? 'border-accent/40 bg-selected/40'
                      : 'border-line bg-page/70 hover:border-line-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                            isFactory
                              ? 'border-accent/30 bg-selected text-accent'
                              : 'border-line bg-surface text-secondary'
                          }`}
                        >
                          {isFactory ? <Compass size={10} /> : <GitPullRequest size={10} />}
                          {isFactory ? 'Factory' : 'Review'}
                        </span>
                        {isFactory && session.stage && (
                          <span className="inline-flex items-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                            {getFactoryStageStep(session.stage)} ·{' '}
                            {getFactoryStageLabel(session.stage)}
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${meta.textClass}`}
                        >
                          <span className={`size-1.5 rounded-full ${meta.dotClass}`} />
                          {meta.label}
                        </span>
                      </div>
                      <p
                        className="mt-1.5 truncate text-xs font-medium text-primary"
                        title={session.title}
                      >
                        {session.title}
                      </p>
                      <p
                        className="mt-0.5 truncate font-mono text-[10px] text-muted"
                        title={session.repoPath}
                      >
                        {session.repoPath}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {!isFactory && (
                      <button
                        type="button"
                        className="modal-button px-2.5 py-1.5 text-[11px]"
                        onClick={() => {
                          onOpenTerminal(session.sessionId);
                          onClose();
                        }}
                      >
                        <Terminal size={12} />
                        <span>Abrir terminal</span>
                      </button>
                    )}

                    {reportPath && (
                      <button
                        type="button"
                        className="modal-button border-accent/35 px-2.5 py-1.5 text-[11px] text-accent hover:bg-selected"
                        onClick={() => {
                          onViewReport(reportPath);
                          onClose();
                        }}
                      >
                        <FileText size={12} />
                        <span>{isFactory ? 'Ver plano' : 'Ver parecer'}</span>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
