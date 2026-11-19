import { useState } from 'react';
import {
  Compass,
  FileText,
  GitPullRequest,
  Loader2,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type { BackgroundSessionSummary } from '@development-factory/shared';
import {
  getSessionStatusPresentation,
  isSessionActivelyRunning,
} from '../utils/session-status';

interface BackgroundTasksPopoverProps {
  id: string;
  sessions: BackgroundSessionSummary[];
  activeSessionId?: string;
  loadingSessions?: boolean;
  sessionsError?: string | null;
  onOpenTerminal: (sessionId: string) => void;
  onViewReport: (reportPath: string) => void;
  onStopSession: (sessionId: string) => Promise<BackgroundSessionSummary>;
  onClose: () => void;
}

export function BackgroundTasksPopover({
  id,
  sessions,
  activeSessionId,
  loadingSessions = false,
  sessionsError = null,
  onOpenTerminal,
  onViewReport,
  onStopSession,
  onClose,
}: BackgroundTasksPopoverProps) {
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const runningCount = sessions.filter(isSessionActivelyRunning).length;

  async function handleStop(sessionId: string) {
    if (stoppingIds.has(sessionId)) {
      return;
    }

    setActionError(null);
    setStoppingIds(current => {
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });

    try {
      await onStopSession(sessionId);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Não foi possível encerrar a operação em background.',
      );
    } finally {
      setStoppingIds(current => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

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
              : `${sessions.length} ${sessions.length === 1 ? 'operação registrada' : 'operações registradas'}`}
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

      {(sessionsError || actionError) && (
        <div
          role="alert"
          className="border-b border-danger/15 bg-danger/5 px-4 py-2.5 text-[11px] leading-5 text-danger"
        >
          {actionError ?? sessionsError}
        </div>
      )}

      <div className="max-h-[52dvh] overflow-y-auto p-3">
        {loadingSessions && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span>Carregando operações...</span>
          </div>
        ) : sessions.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted">
            Nenhuma operação em execução ou recente nesta sessão.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {sessions.map(session => {
              const meta = getSessionStatusPresentation(session);
              const isFactory = session.mode === 'factory';
              const isStopping = stoppingIds.has(session.sessionId);
              const isActive = activeSessionId === session.sessionId;
              const reportPath = session.reportPath;

              return (
                <li
                  key={session.sessionId}
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

                    {session.status === 'running' && (
                      <button
                        type="button"
                        disabled={isStopping}
                        aria-busy={isStopping}
                        className="modal-button ml-auto border-danger/25 px-2.5 py-1.5 text-[11px] text-danger hover:bg-danger/10"
                        onClick={() => void handleStop(session.sessionId)}
                      >
                        <Square size={10} />
                        <span>{isStopping ? 'Encerrando...' : 'Encerrar'}</span>
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
