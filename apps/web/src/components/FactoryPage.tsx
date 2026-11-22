import { useId, useState } from 'react';
import { Activity, CircleCheck, Clock, FolderGit2, GitPullRequest, Plus } from 'lucide-react';
import type { FactoryFlow, FactoryStageName } from '@development-factory/shared';
import type { FactoryPreflight } from '../hooks/useFactoryPreflight.js';
import {
  isFactoryFlowActivelyRunning,
  isFactoryFlowReadyForPr,
} from '../utils/factory-flow-status.js';
import { FactoryFlowCard } from './FactoryFlowCard.js';
import { FactoryPreflightPanel } from './FactoryPreflightPanel.js';

interface FactoryPageProps {
  repoPath: string;
  preflight: FactoryPreflight;
  factoryFlows: readonly FactoryFlow[];
  loadingFactoryFlows: boolean;
  factoryFlowsError: string | null;
  onPickDirectory: () => void;
  onOpenNewFlow: () => void;
  onOpenFlowRoadmap: (flowId: string) => void;
  onCancelFlow: (flowId: string) => Promise<FactoryFlow>;
  onRerunFlowStage: (flowId: string, stage: FactoryStageName) => Promise<void>;
}

const flowGroups = [
  { id: 'running', label: 'Em execução', Icon: Activity, color: 'text-accent' },
  { id: 'waiting', label: 'Aguardando decisão humana', Icon: Clock, color: 'text-warning' },
  { id: 'readyForPr', label: 'Prontos para PR', Icon: GitPullRequest, color: 'text-accent' },
  { id: 'finished', label: 'Finalizados', Icon: CircleCheck, color: 'text-muted' },
] as const;

type FlowGroup = (typeof flowGroups)[number]['id'];
type FlowActionState = { pending: true } | { pending: false; error: string };

function getFlowGroup(flow: FactoryFlow): FlowGroup {
  if (isFactoryFlowActivelyRunning(flow)) {
    return 'running';
  }
  if (flow.state === 'waiting_action') {
    return isFactoryFlowReadyForPr(flow) ? 'readyForPr' : 'waiting';
  }
  return 'finished';
}

export function FactoryPage({
  repoPath,
  preflight,
  factoryFlows,
  loadingFactoryFlows,
  factoryFlowsError,
  onPickDirectory,
  onOpenNewFlow,
  onOpenFlowRoadmap,
  onCancelFlow,
  onRerunFlowStage,
}: FactoryPageProps) {
  const pageId = useId();
  const preflightStatusId = `${pageId}-preflight`;
  const flowsHeadingId = `${pageId}-flows`;
  const [flowActions, setFlowActions] = useState(() => new Map<string, FlowActionState>());
  const canOpenFlow = preflight.state.status === 'checked' && !preflight.state.result.blocked;
  const showFlowGroups = factoryFlows.length > 0 || (!loadingFactoryFlows && !factoryFlowsError);
  const groupedFlows: Record<FlowGroup, FactoryFlow[]> = {
    running: [],
    waiting: [],
    readyForPr: [],
    finished: [],
  };
  for (const flow of factoryFlows) {
    groupedFlows[getFlowGroup(flow)].push(flow);
  }

  function updateFlowAction(flowId: string, action: FlowActionState | null) {
    setFlowActions(current => {
      const next = new Map(current);
      if (action) {
        next.set(flowId, action);
      } else {
        next.delete(flowId);
      }
      return next;
    });
  }

  function runFlowAction(flowId: string, operation: () => Promise<unknown>, fallback: string) {
    if (flowActions.get(flowId)?.pending) {
      return;
    }

    updateFlowAction(flowId, { pending: true });
    Promise.resolve()
      .then(operation)
      .then(() => updateFlowAction(flowId, null))
      .catch((error: unknown) =>
        updateFlowAction(flowId, {
          pending: false,
          error: error instanceof Error ? error.message : fallback,
        }),
      );
  }

  return (
    <main className="mx-auto min-h-screen max-w-[94rem] px-4 pb-32 pt-8 sm:px-8 sm:pt-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Factory</h1>
        <section
          aria-label="Iniciar novo fluxo"
          className="flex min-w-0 max-w-2xl flex-1 flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1">
            <span className="mb-2 block text-xs font-medium text-secondary">
              Repositório para novo fluxo
            </span>
            <button
              type="button"
              onClick={onPickDirectory}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-left font-mono text-xs transition hover:border-accent/40"
              aria-haspopup="dialog"
              aria-label={
                repoPath
                  ? `Alterar repositório para novo fluxo · ${repoPath}`
                  : 'Selecionar pasta do repositório'
              }
            >
              <FolderGit2 size={16} aria-hidden="true" className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate" title={repoPath}>
                {repoPath || 'Selecionar pasta do repositório'}
              </span>
              <span aria-hidden="true" className="shrink-0 text-accent">
                {repoPath ? 'Alterar' : 'Selecionar'}
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenNewFlow}
            disabled={!canOpenFlow}
            aria-describedby={preflightStatusId}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-on-accent transition enabled:hover:bg-accent-hover"
          >
            <Plus size={17} aria-hidden="true" />
            Iniciar fluxo
          </button>
        </section>
      </header>

      <div className="mt-4 rounded-xl bg-surface [&_ul]:grid-cols-2 lg:[&_ul]:grid-cols-5">
        <FactoryPreflightPanel preflight={preflight} statusId={preflightStatusId} checkJiraInTask />
      </div>

      <section aria-labelledby={flowsHeadingId} className="mt-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={flowsHeadingId} className="text-lg font-semibold">
            Fluxos ativos e recentes
          </h2>
          {showFlowGroups && (
            <p className="text-xs text-muted">
              {factoryFlows.length} {factoryFlows.length === 1 ? 'fluxo' : 'fluxos'}
            </p>
          )}
        </div>

        {loadingFactoryFlows && factoryFlows.length === 0 && (
          <p role="status" className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
            Carregando fluxos…
          </p>
        )}
        {factoryFlowsError && (
          <p
            role="alert"
            className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            {factoryFlowsError}
          </p>
        )}

        {showFlowGroups && (
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {flowGroups.map(({ id, label, Icon, color }) => {
              const flows = groupedFlows[id];
              const groupHeadingId = `${pageId}-${id}`;
              return (
                <section
                  key={id}
                  aria-labelledby={groupHeadingId}
                  className="min-w-0 rounded-2xl border border-line-subtle bg-elevated/55 p-2.5"
                >
                  <header className="flex items-center gap-2 px-1.5 pb-2.5 pt-1">
                    <Icon size={15} aria-hidden="true" className={`shrink-0 ${color}`} />
                    <h3 id={groupHeadingId} className="flex-1 text-sm font-medium">
                      {label}
                    </h3>
                    <span
                      role="status"
                      className={`rounded-md bg-page px-2 py-0.5 font-mono text-xs tabular-nums ${color}`}
                    >
                      <span className="sr-only">{label} · </span>
                      {flows.length}
                    </span>
                  </header>

                  {flows.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line p-4 text-xs text-muted">
                      Nenhum fluxo
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {flows.map(flow => {
                        const action = flowActions.get(flow.id);
                        return (
                          <li key={flow.id}>
                            <FactoryFlowCard
                              flow={flow}
                              readyForPr={id === 'readyForPr'}
                              actionPending={action?.pending === true}
                              actionError={action?.pending === false ? action.error : undefined}
                              onOpenRoadmap={() => onOpenFlowRoadmap(flow.id)}
                              onStop={() => {
                                runFlowAction(
                                  flow.id,
                                  () => onCancelFlow(flow.id),
                                  'Não foi possível parar o fluxo.',
                                );
                              }}
                              onRerun={() => {
                                runFlowAction(
                                  flow.id,
                                  () => onRerunFlowStage(flow.id, flow.currentStage),
                                  'Não foi possível executar a etapa.',
                                );
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
