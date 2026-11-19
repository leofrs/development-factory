import { useEffect, useRef, useState } from 'react';
import { Activity, Code2, Factory, GitPullRequest, History, Loader2, Scale } from 'lucide-react';
import type { BackgroundSessionSummary } from '@development-factory/shared';
import { BackgroundTasksPopover } from './BackgroundTasksPopover';
import { ThemeToggle } from './ThemeToggle';
import type { Theme } from '../theme';
import { isSessionActivelyRunning } from '../utils/session-status';

export type AppView = 'factory' | 'review';

interface FloatingDockProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  onOpenHistory: () => void;
  onOpenSeverityMatrix: () => void;
  sessions: BackgroundSessionSummary[];
  activeSessionId?: string;
  loadingSessions?: boolean;
  sessionsError?: string | null;
  onOpenTerminal: (sessionId: string) => void;
  onViewReport: (reportPath: string) => void;
  onStopSession: (sessionId: string) => Promise<BackgroundSessionSummary>;
  theme: Theme;
  onToggleTheme: () => void;
}

const POPOVER_ID = 'background-tasks-popover';

export function FloatingDock({
  activeView,
  onSelectView,
  onOpenHistory,
  onOpenSeverityMatrix,
  sessions,
  activeSessionId,
  loadingSessions,
  sessionsError,
  onOpenTerminal,
  onViewReport,
  onStopSession,
  theme,
  onToggleTheme,
}: FloatingDockProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const dockContainerRef = useRef<HTMLDivElement>(null);

  const runningCount = sessions.filter(isSessionActivelyRunning).length;
  const statusLabel =
    runningCount > 0
      ? `${runningCount} em execução`
      : sessions.length > 0
        ? `${sessions.length} ${sessions.length === 1 ? 'operação' : 'operações'}`
        : 'Operações';

  useEffect(() => {
    if (!popoverOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !dockContainerRef.current?.contains(target)) {
        setPopoverOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPopoverOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popoverOpen]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 sm:bottom-6 sm:px-6">
      <div ref={dockContainerRef} className="relative max-w-full">
        {popoverOpen && (
          <BackgroundTasksPopover
            id={POPOVER_ID}
            sessions={sessions}
            activeSessionId={activeSessionId}
            loadingSessions={loadingSessions}
            sessionsError={sessionsError}
            onOpenTerminal={onOpenTerminal}
            onViewReport={onViewReport}
            onStopSession={onStopSession}
            onClose={() => setPopoverOpen(false)}
          />
        )}

        <nav
          aria-label="Menu principal"
          className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface/90 px-3 py-2 shadow-2xl shadow-black/30 backdrop-blur-md sm:gap-3 sm:px-4"
        >
        <a
          href="/"
          className="flex items-center gap-2.5 rounded-xl px-2 py-1 text-xs font-semibold tracking-tight transition hover:bg-hover"
          aria-label="development-factory, início"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-on-accent">
            <Code2 size={16} />
          </span>
          <span className="hidden sm:inline">development-factory</span>
        </a>

        <span className="hidden h-5 w-px bg-line sm:block" aria-hidden="true" />

        <div
          className="flex items-center gap-1 rounded-xl border border-line-subtle bg-page p-1"
          role="group"
          aria-label="Alternar página"
        >
          <button
            type="button"
            onClick={() => onSelectView('factory')}
            aria-pressed={activeView === 'factory'}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeView === 'factory'
                ? 'bg-selected text-accent ring-1 ring-accent/20'
                : 'text-muted hover:text-primary'
            }`}
          >
            <Factory size={14} />
            Factory
          </button>
          <button
            type="button"
            onClick={() => onSelectView('review')}
            aria-pressed={activeView === 'review'}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeView === 'review'
                ? 'bg-selected text-accent ring-1 ring-accent/20'
                : 'text-muted hover:text-primary'
            }`}
          >
            <GitPullRequest size={14} />
            Review
          </button>
        </div>

        <span className="hidden h-5 w-px bg-line md:block" aria-hidden="true" />

        <button
          type="button"
          onClick={() => setPopoverOpen(open => !open)}
          aria-expanded={popoverOpen}
          aria-controls={POPOVER_ID}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
            runningCount > 0
              ? 'border-accent/40 bg-selected text-accent hover:bg-selected/80'
              : popoverOpen
                ? 'border-line-strong bg-hover text-primary'
                : 'border-line text-muted hover:bg-hover hover:text-primary'
          }`}
        >
          {runningCount > 0 ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : (
            <Activity size={13} className={sessions.length > 0 ? 'text-accent' : 'text-muted'} />
          )}
          <span>{statusLabel}</span>
        </button>

        <button
          type="button"
          className="modal-button rounded-xl"
          onClick={onOpenHistory}
          aria-haspopup="dialog"
        >
          <History size={15} />
          <span>Histórico</span>
        </button>

        {activeView === 'review' && (
          <button
            type="button"
            className="modal-button rounded-xl px-2.5"
            onClick={onOpenSeverityMatrix}
            aria-label="Matriz de severidade por categoria"
            aria-haspopup="dialog"
            title="Matriz de severidade por categoria"
          >
            <Scale size={15} />
          </button>
        )}

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </nav>
      </div>
    </div>
  );
}
