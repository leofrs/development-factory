import { useId } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  GitPullRequest,
  Layers,
  RefreshCw,
} from 'lucide-react';
import type {
  FactoryMetricsPeriod,
  FactoryMetricsResponse,
} from '@development-factory/shared';
import type { FactoryMetricsController } from '../hooks/useFactoryMetrics.js';
import { getFactoryStageLabel, getFactoryStageStep } from '../utils/factory-flow-status.js';

const PERIOD_OPTIONS: ReadonlyArray<{ value: FactoryMetricsPeriod; label: string }> = [
  { value: 'all', label: 'Todo o período' },
  { value: '7d', label: 'Últimos 7 dias' },
  { value: '30d', label: 'Últimos 30 dias' },
  { value: '90d', label: 'Últimos 90 dias' },
];

export function formatMetricsDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return 'Sem dados';
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)} ms`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function getRepoDisplayName(repoPath: string): string {
  const parts = repoPath.split('/').filter(Boolean);
  return parts.at(-1) ?? repoPath;
}

function getActiveData(metrics: FactoryMetricsController): FactoryMetricsResponse | undefined {
  if (metrics.state.status === 'loaded') {
    return metrics.state.data;
  }
  return metrics.state.previous;
}

export function FactoryMetricsPanel({ metrics }: { metrics: FactoryMetricsController }) {
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const repoSelectId = `${panelId}-repo`;
  const periodSelectId = `${panelId}-period`;

  const isLoading = metrics.state.status === 'loading';
  const data = getActiveData(metrics);
  const availableRepos = data?.availableRepos ?? [];
  const repoOptions =
    metrics.repoPathFilter && !availableRepos.includes(metrics.repoPathFilter)
      ? [metrics.repoPathFilter, ...availableRepos]
      : availableRepos;

  const maxStageAverageMs = data
    ? data.stageLeadTimes.reduce((max, item) => {
        if (item.averageDurationMs !== null && item.averageDurationMs > max) {
          return item.averageDurationMs;
        }
        return max;
      }, 0)
    : 0;
  const maxReasonCount = data?.rejectionReasons[0]?.count ?? 0;

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 size={18} aria-hidden="true" className="text-accent" />
            <h2 id={headingId} className="text-lg font-semibold">
              Métricas da Factory
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted">
            Qualidade, lead time por bloco e adoção calculados a partir dos fluxos persistidos no SQLite.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem]">
            <label
              htmlFor={repoSelectId}
              className="mb-1.5 block text-[11px] font-medium text-secondary"
            >
              Repositório
            </label>
            <select
              id={repoSelectId}
              value={metrics.repoPathFilter}
              onChange={event => metrics.setRepoPathFilter(event.target.value)}
              className="field py-2 pl-3 pr-8 text-xs"
            >
              <option value="">Todos os repositórios</option>
              {repoOptions.map(repo => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-[10.5rem]">
            <label
              htmlFor={periodSelectId}
              className="mb-1.5 block text-[11px] font-medium text-secondary"
            >
              Período
            </label>
            <select
              id={periodSelectId}
              value={metrics.periodFilter}
              onChange={event =>
                metrics.setPeriodFilter(event.target.value as FactoryMetricsPeriod)
              }
              className="field py-2 pl-3 pr-8 text-xs"
            >
              {PERIOD_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={metrics.refresh}
            disabled={isLoading}
            className="modal-button h-[38px] px-3.5 text-xs font-medium text-primary"
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={isLoading ? 'animate-spin text-accent' : 'text-accent'}
            />
            Atualizar
          </button>
        </div>
      </div>

      {isLoading && (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted"
        >
          Carregando métricas da Factory…
        </p>
      )}

      {metrics.state.status === 'failed' && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        >
          <span>{metrics.state.message}</span>
          <button
            type="button"
            onClick={metrics.refresh}
            className="modal-button border-danger/40 text-danger hover:bg-danger/10"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {data && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Layers size={14} aria-hidden="true" className="text-accent" />
                Total de fluxos
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-primary">
                {data.summary.totalFlows}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {data.summary.activeFlows} ativos · {data.summary.cancelledFlows} cancelados ·{' '}
                {data.summary.failedFlows} falhos
              </p>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <CheckCircle2 size={14} aria-hidden="true" className="text-accent" />
                Fluxos concluídos
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-primary">
                {data.summary.completedFlows}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {data.summary.totalFlows > 0
                  ? `${Math.round((data.summary.completedFlows / data.summary.totalFlows) * 100)}% do total no período`
                  : 'Sem fluxos no período'}
              </p>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <GitPullRequest size={14} aria-hidden="true" className="text-accent" />
                PRs abertos
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-primary">
                {data.summary.openedPrs}
              </p>
              <p className="mt-1 text-[11px] text-muted">Publicados pelo Bloco 06</p>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Clock size={14} aria-hidden="true" className="text-accent" />
                Lead time médio total
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-primary">
                {formatMetricsDuration(data.summary.averageFlowLeadTimeMs)}
              </p>
              <p className="mt-1 text-[11px] text-muted">Da triagem à conclusão</p>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <CheckCircle2 size={14} aria-hidden="true" className="text-accent" />
                Aprovação 1º ciclo
              </p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-primary">
                {data.firstCycleReview.approvalRatePercent !== null
                  ? `${data.firstCycleReview.approvalRatePercent}%`
                  : 'Sem dados'}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {data.firstCycleReview.evaluatedFlows > 0
                  ? `${data.firstCycleReview.approvedFirstCycle} de ${data.firstCycleReview.evaluatedFlows} avaliados`
                  : 'Nenhuma revisão concluída'}
              </p>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <section
              aria-labelledby={`${panelId}-leadtime`}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <h3 id={`${panelId}-leadtime`} className="text-sm font-semibold">
                Lead time médio por bloco (01 a 06)
              </h3>
              <p className="mt-1 text-xs text-muted">
                Tempo médio entre início e conclusão das etapas finalizadas.
              </p>

              {data.stageLeadTimes.every(item => item.completedCount === 0) ? (
                <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
                  Nenhuma etapa concluída com timestamps completos neste recorte.
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {data.stageLeadTimes.map(item => {
                    const widthPercent =
                      item.averageDurationMs !== null && maxStageAverageMs > 0
                        ? Math.max(4, Math.round((item.averageDurationMs / maxStageAverageMs) * 100))
                        : 0;
                    return (
                      <li key={item.stage} className="space-y-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                          <span className="font-medium text-primary">
                            {getFactoryStageStep(item.stage)} · {getFactoryStageLabel(item.stage)}
                          </span>
                          <span className="font-mono text-secondary tabular-nums">
                            {formatMetricsDuration(item.averageDurationMs)}
                            <span className="ml-2 font-sans text-[11px] text-muted">
                              ({item.completedCount}{' '}
                              {item.completedCount === 1 ? 'concluído' : 'concluídos'}
                              {item.partialCount > 0 ? ` · ${item.partialCount} parcial` : ''})
                            </span>
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-page">
                          {widthPercent > 0 && (
                            <div
                              className="h-full rounded-full bg-accent transition-all"
                              style={{ width: `${widthPercent}%` }}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section
              aria-labelledby={`${panelId}-first-cycle`}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <h3 id={`${panelId}-first-cycle`} className="text-sm font-semibold">
                Taxa de aprovação no 1º ciclo do Review (Bloco 05)
              </h3>
              <p className="mt-1 text-xs text-muted">
                Fluxos aprovados na primeira auditoria sem necessidade de retorno para correções.
              </p>

              {data.firstCycleReview.evaluatedFlows === 0 ||
              data.firstCycleReview.approvalRatePercent === null ? (
                <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
                  Nenhum fluxo avaliado no Bloco 05 neste período.
                </p>
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-mono text-3xl font-semibold tabular-nums text-accent">
                      {data.firstCycleReview.approvalRatePercent}%
                    </span>
                    <span className="text-xs text-muted">
                      {data.firstCycleReview.approvedFirstCycle} aprovados ·{' '}
                      {data.firstCycleReview.rejectedFirstCycle} com retorno ·{' '}
                      {data.firstCycleReview.evaluatedFlows} avaliados
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Taxa de aprovação no 1º ciclo do Review"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(data.firstCycleReview.approvalRatePercent)}
                    className="h-3 overflow-hidden rounded-full bg-page"
                  >
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${data.firstCycleReview.approvalRatePercent}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-xl bg-page p-3">
                      <p className="text-muted">Aprovados de primeira</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-accent tabular-nums">
                        {data.firstCycleReview.approvedFirstCycle}
                      </p>
                    </div>
                    <div className="rounded-xl bg-page p-3">
                      <p className="text-muted">Reprovados no 1º ciclo</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-warning tabular-nums">
                        {data.firstCycleReview.rejectedFirstCycle}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <section
              aria-labelledby={`${panelId}-rejection-reasons`}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <h3 id={`${panelId}-rejection-reasons`} className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle size={15} aria-hidden="true" className="text-warning" />
                Principais motivos de reprovação no Bloco 05
              </h3>
              <p className="mt-1 text-xs text-muted">
                Ranking das causas bloqueantes registradas nas revisões de código.
              </p>

              {data.rejectionReasons.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
                  Nenhuma reprovação registrada no Bloco 05 neste período.
                </p>
              ) : (
                <ol className="mt-4 space-y-2.5">
                  {data.rejectionReasons.map((item, index) => {
                    const widthPercent =
                      maxReasonCount > 0
                        ? Math.max(6, Math.round((item.count / maxReasonCount) * 100))
                        : 0;
                    return (
                      <li key={item.reason} className="rounded-xl bg-page p-3 text-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium text-primary">
                            <span className="mr-2 font-mono text-warning">#{index + 1}</span>
                            {item.reason}
                          </span>
                          <span className="font-mono text-secondary tabular-nums">
                            {item.count} {item.count === 1 ? 'ocorrência' : 'ocorrências'} ·{' '}
                            {item.flowCount} {item.flowCount === 1 ? 'fluxo' : 'fluxos'}
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
                          <div
                            className="h-full rounded-full bg-warning"
                            style={{ width: `${widthPercent}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <section
              aria-labelledby={`${panelId}-throughput`}
              className="rounded-2xl border border-line bg-surface p-4"
            >
              <h3 id={`${panelId}-throughput`} className="text-sm font-semibold">
                Volume por repositório
              </h3>
              <p className="mt-1 text-xs text-muted">
                Fluxos concluídos, PRs abertos e cancelamentos agrupados por repositório.
              </p>

              {data.byRepository.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-xs text-muted">
                  Nenhum fluxo registrado para os filtros selecionados.
                </p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-line text-[11px] text-muted">
                        <th scope="col" className="pb-2 pr-3 font-medium">
                          Repositório
                        </th>
                        <th scope="col" className="px-2 pb-2 text-right font-medium">
                          Total
                        </th>
                        <th scope="col" className="px-2 pb-2 text-right font-medium">
                          Concluídos
                        </th>
                        <th scope="col" className="px-2 pb-2 text-right font-medium">
                          PRs abertos
                        </th>
                        <th scope="col" className="px-2 pb-2 text-right font-medium">
                          Cancelados
                        </th>
                        <th scope="col" className="pb-2 pl-2 text-right font-medium">
                          1º ciclo
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-subtle">
                      {data.byRepository.map(repo => (
                        <tr key={repo.repoPath}>
                          <td className="py-2.5 pr-3">
                            <span className="block font-medium text-primary">
                              {getRepoDisplayName(repo.repoPath)}
                            </span>
                            <span className="block font-mono text-[11px] text-muted">
                              {repo.repoPath}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                            {repo.totalFlows}
                          </td>
                          <td className="px-2 py-2.5 text-right font-mono text-accent tabular-nums">
                            {repo.completedFlows}
                          </td>
                          <td className="px-2 py-2.5 text-right font-mono text-primary tabular-nums">
                            {repo.openedPrs}
                          </td>
                          <td className="px-2 py-2.5 text-right font-mono text-muted tabular-nums">
                            {repo.cancelledFlows}
                          </td>
                          <td className="py-2.5 pl-2 text-right font-mono text-secondary tabular-nums">
                            {repo.firstCycleApprovalRatePercent !== null
                              ? `${repo.firstCycleApprovalRatePercent}%`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
