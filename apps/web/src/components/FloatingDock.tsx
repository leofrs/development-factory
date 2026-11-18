import { Code2, Factory, GitPullRequest, History } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { Theme } from '../theme';

export type AppView = 'factory' | 'review';

interface FloatingDockProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  onOpenHistory: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function FloatingDock({
  activeView,
  onSelectView,
  onOpenHistory,
  theme,
  onToggleTheme,
}: FloatingDockProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 sm:bottom-6 sm:px-6">
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

        <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted md:flex">
          <span className="size-1.5 rounded-full bg-accent" /> Ambiente local
        </span>

        <button
          type="button"
          className="modal-button rounded-xl"
          onClick={onOpenHistory}
          aria-haspopup="dialog"
        >
          <History size={15} />
          <span>Histórico</span>
        </button>

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </nav>
    </div>
  );
}
