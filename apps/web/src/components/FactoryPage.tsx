import { Fragment } from 'react';
import {
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Code2,
  Compass,
  FileText,
  FlaskConical,
  FolderGit2,
  GitPullRequest,
  Play,
  ScanSearch,
  Sparkles,
} from 'lucide-react';

interface FactoryPageProps {
  repoPath: string;
  savedPlanPath: string | null;
  onPickDirectory: () => void;
  onOpenInitialNode: () => void;
  onViewPlan: (filePath: string) => void;
}

const roadmapStages = [
  {
    id: 'triage',
    step: '01',
    title: 'Triagem / Contexto',
    description: 'Conecte uma tarefa do JIRA ou título e gere o plano técnico inicial com o Claude Code.',
    icon: Compass,
    interactive: true,
  },
  {
    id: 'planning',
    step: '02',
    title: 'Planejamento',
    description: 'Refinamento dos critérios de aceite, escopo e arquitetura da solução.',
    icon: ClipboardList,
    interactive: false,
  },
  {
    id: 'development',
    step: '03',
    title: 'Desenvolvimento',
    description: 'Implementação assistida seguindo contratos, padrões e escopo definidos.',
    icon: Code2,
    interactive: false,
  },
  {
    id: 'tests',
    step: '04',
    title: 'Testes',
    description: 'Validação automatizada de fluxos, edge cases e regressões.',
    icon: FlaskConical,
    interactive: false,
  },
  {
    id: 'review',
    step: '05',
    title: 'Code Review',
    description: 'Análise crítica do diff, entorno e aderência aos requisitos.',
    icon: ScanSearch,
    interactive: false,
  },
  {
    id: 'pr',
    step: '06',
    title: 'PR',
    description: 'Preparação da entrega final para revisão e merge no repositório.',
    icon: GitPullRequest,
    interactive: false,
  },
] as const;

export function FactoryPage({
  repoPath,
  savedPlanPath,
  onPickDirectory,
  onOpenInitialNode,
  onViewPlan,
}: FactoryPageProps) {
  return (
    <main className="mx-auto max-w-6xl px-6 pb-32 pt-12 sm:px-10 sm:pt-16">
      <div className="mb-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
        <Sparkles size={14} /> Fábrica de software · Ciclo de desenvolvimento
      </div>

      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div>
          <h1 className="max-w-2xl text-3xl font-semibold leading-[1.14] tracking-[-0.04em] sm:text-[46px]">
            Do contexto à entrega, <span className="text-accent">nó por nó.</span>
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-muted">
            Acompanhe em qual etapa do ciclo de desenvolvimento uma tarefa está. Selecione o nó inicial para
            informar a demanda e gerar o plano em Markdown com o Claude Code.
          </p>
        </div>

        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-3.5">
          <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted">
            Repositório ativo no WSL
          </span>
          <button
            type="button"
            onClick={onPickDirectory}
            className="flex w-full items-center gap-2.5 rounded-lg border border-line-subtle bg-page px-3 py-2 text-left font-mono text-xs transition hover:border-accent/40"
            aria-haspopup="dialog"
          >
            <FolderGit2 size={15} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">
              {repoPath || 'Selecionar pasta do repositório'}
            </span>
            <span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span>
          </button>
        </div>
      </div>

      <section aria-labelledby="roadmap-heading" className="mt-12">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 id="roadmap-heading" className="text-sm font-medium text-secondary">
            Roadmap do ciclo de desenvolvimento
          </h2>
          <span className="font-mono text-[11px] text-muted">
            Etapa atual: <strong className="font-medium text-accent">01 · Triagem / Contexto</strong>
          </span>
        </div>

        <ol className="space-y-4">
          {[roadmapStages.slice(0, 3), roadmapStages.slice(3, 6)].map((row, rowIndex) => (
            <Fragment key={rowIndex}>
              <li className="list-none">
                <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
                  {row.map((stage, indexInRow) => {
                    const Icon = stage.icon;
                    const isLastInRow = indexInRow === row.length - 1;
                    return (
                      <Fragment key={stage.id}>
                        {stage.interactive ? (
                          <button
                            type="button"
                            onClick={onOpenInitialNode}
                            className="group flex h-full w-full flex-col justify-between rounded-2xl border border-accent/40 bg-selected/60 p-5 text-left shadow-lg shadow-black/10 transition hover:border-accent hover:bg-selected"
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="grid size-9 place-items-center rounded-xl bg-accent text-on-accent">
                                  <Icon size={17} />
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-0.5 font-mono text-[10px] font-medium text-accent">
                                  <Play size={10} /> Iniciar
                                </span>
                              </div>
                              <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-accent">
                                Etapa {stage.step}
                              </p>
                              <h3 className="mt-1 text-sm font-semibold text-primary">{stage.title}</h3>
                              <p className="mt-2 text-xs leading-5 text-muted">{stage.description}</p>
                            </div>
                            <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-accent group-hover:underline">
                              Selecionar tarefa <ArrowRight size={13} />
                            </span>
                          </button>
                        ) : (
                          <div
                            aria-disabled="true"
                            className="flex h-full flex-col justify-between rounded-2xl border border-line bg-surface/70 p-5 opacity-80"
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="grid size-9 place-items-center rounded-xl border border-line bg-page text-muted">
                                  <Icon size={17} />
                                </span>
                                <span className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] text-muted">
                                  Visualização
                                </span>
                              </div>
                              <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-muted">
                                Etapa {stage.step}
                              </p>
                              <h3 className="mt-1 text-sm font-medium text-secondary">{stage.title}</h3>
                              <p className="mt-2 text-xs leading-5 text-muted">{stage.description}</p>
                            </div>
                          </div>
                        )}

                        {!isLastInRow && (
                          <div aria-hidden="true" className="flex items-center justify-center text-muted">
                            <ArrowRight size={16} className="hidden lg:block" />
                            <ArrowDown size={16} className="block lg:hidden" />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              </li>

              {rowIndex === 0 && (
                <li aria-hidden="true" className="flex items-center justify-center gap-3 py-1 text-muted">
                  <span className="h-px flex-1 bg-line-subtle" />
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 font-mono text-[10px] text-muted">
                    <ArrowDown size={12} className="text-accent" />
                    Próxima fase (03 → 04)
                  </span>
                  <span className="h-px flex-1 bg-line-subtle" />
                </li>
              )}
            </Fragment>
          ))}
        </ol>
      </section>

      {savedPlanPath && (
        <section
          aria-label="Último plano salvo"
          className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-accent/30 bg-surface px-5 py-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-selected text-accent">
              <CheckCircle2 size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-primary">Plano da tarefa salvo em Markdown</p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={savedPlanPath}>
                {savedPlanPath}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onViewPlan(savedPlanPath)}
            className="modal-button border-accent/40 text-accent hover:bg-selected"
          >
            <FileText size={14} />
            Visualizar plano em Markdown
          </button>
        </section>
      )}
    </main>
  );
}
