import { RefreshCw } from 'lucide-react';
import type { FactoryPreflightCheck } from '@development-factory/shared';
import type { FactoryPreflight } from '../hooks/useFactoryPreflight.js';

const checkLabels = [
  ['claude', 'claude'],
  ['jiraMcp', 'Jira MCP'],
  ['github', 'gh auth'],
  ['git', 'Git'],
  ['profile', 'Perfil do repositório'],
] as const;

const checkStatuses: Record<FactoryPreflightCheck['status'], { label: string; className: string }> =
  {
    ok: { label: 'OK', className: 'text-accent' },
    warning: { label: 'Aviso', className: 'text-warning' },
    error: { label: 'Erro', className: 'text-danger' },
  };

function getStatusMessage(state: FactoryPreflight['state']): string {
  switch (state.status) {
    case 'idle':
      return 'Selecione o repositório para verificar o ambiente.';
    case 'checking':
      return 'Verificando o ambiente…';
    case 'failed':
      return state.message;
    case 'checked':
      return state.result.blocked
        ? 'Corrija as falhas abaixo e revalide o ambiente para iniciar o fluxo.'
        : 'Verificação concluída. O ambiente está pronto para prosseguir.';
  }
}

export function FactoryPreflightPanel({
  preflight,
  statusId,
  checkJiraInTask = false,
  isSubmitting = false,
}: {
  preflight: FactoryPreflight;
  statusId: string;
  checkJiraInTask?: boolean;
  isSubmitting?: boolean;
}) {
  const { state } = preflight;
  const titleId = `${statusId}-title`;
  const isChecking = state.status === 'checking';
  const canRevalidate = !isChecking && !isSubmitting;
  const hasError = state.status === 'failed' || (state.status === 'checked' && state.result.blocked);

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="space-y-2.5 rounded-xl border border-line-subtle p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={titleId} className="text-xs font-semibold">
          Verificação do ambiente
        </p>
        {state.status !== 'idle' && (
          <button
            type="button"
            onClick={() => {
              if (canRevalidate) {
                preflight.revalidate();
              }
            }}
            aria-disabled={!canRevalidate}
            className="modal-button aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <RefreshCw size={13} aria-hidden="true" className={isChecking ? 'animate-spin' : ''} />
            Revalidar
          </button>
        )}
      </div>

      <p
        id={statusId}
        role="status"
        className={`text-xs leading-5 ${hasError ? 'text-danger' : 'text-muted'}`}
      >
        {getStatusMessage(state)}
      </p>

      {state.status === 'checked' && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {checkLabels.map(([key, label]) => {
            const check = state.result.checks[key];
            const deferJira = checkJiraInTask && key === 'jiraMcp' && check.status === 'ok';
            const presentation = deferJira
              ? { label: 'Na tarefa', className: 'text-muted' }
              : checkStatuses[check.status];
            return (
              <li key={key} className="rounded-lg bg-page px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs font-medium">
                  <span>{label}</span>
                  <span className={presentation.className}>{presentation.label}</span>
                </div>
                <p className="mt-1 break-words text-[11px] leading-4 text-muted">
                  {deferJira
                    ? 'Verificado ao identificar a tarefa por URL ou chave do Jira.'
                    : check.message}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
