import { FolderGit2, Layers, Plus, Sparkles } from 'lucide-react';

interface FactoryPageProps {
  repoPath: string;
  onPickDirectory: () => void;
  onOpenNewFlow: () => void;
}

export function FactoryPage({ repoPath, onPickDirectory, onOpenNewFlow }: FactoryPageProps) {
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-7rem)] max-w-4xl flex-col justify-center px-6 pb-32 pt-12 sm:px-10 sm:pt-16">
      <div className="mb-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
        <Sparkles size={14} /> Fábrica de software · Ciclo de desenvolvimento
      </div>

      <h1 className="max-w-2xl text-3xl font-semibold leading-[1.14] tracking-[-0.04em] sm:text-[48px]">
        Do contexto à entrega, <span className="text-accent">nó por nó.</span>
      </h1>

      <p className="mt-4 max-w-xl text-sm leading-7 text-muted">
        Inicie fluxos de desenvolvimento em segundo plano. Acompanhe o roadmap de cada execução no
        menu <strong>Operações</strong> e consulte os planos e relatórios gerados no{' '}
        <strong>Histórico</strong>.
      </p>

      <section
        aria-label="Iniciar novo fluxo"
        className="mt-10 rounded-2xl border border-line bg-surface p-6 shadow-2xl shadow-black/15 sm:p-8"
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <span className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-muted">
              Repositório ativo no WSL
            </span>
            <button
              type="button"
              onClick={onPickDirectory}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line-subtle bg-page px-3.5 py-3 text-left font-mono text-xs transition hover:border-accent/40"
              aria-haspopup="dialog"
            >
              <FolderGit2 size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">
                {repoPath || 'Selecionar pasta do repositório'}
              </span>
              <span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenNewFlow}
            className="flex shrink-0 items-center justify-center gap-2.5 rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-on-accent shadow-lg shadow-black/15 transition hover:bg-accent-hover active:scale-[0.99]"
          >
            <Plus size={17} />
            Iniciar fluxo
          </button>
        </div>

        <p className="mt-4 flex items-center gap-2 border-t border-line-subtle pt-4 text-xs text-muted">
          <Layers size={14} className="shrink-0 text-accent" />
          Múltiplos fluxos podem ser iniciados e executados em paralelo sem bloquear esta tela.
        </p>
      </section>
    </main>
  );
}
