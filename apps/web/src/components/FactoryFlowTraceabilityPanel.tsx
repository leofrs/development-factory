import { useCallback, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type {
  FactoryFlowTraceabilityMatrix,
  FactoryTraceabilityFile,
  FactoryTraceabilityGap,
  FactoryTraceabilityRow,
} from '@development-factory/shared';
import { fetchFactoryFlowTraceability } from '../api/factory-flows.js';
import { useFactoryInspection } from '../hooks/useFactoryInspection.js';
import { getFactoryReviewVerdictPresentation } from '../utils/factory-flow-status.js';

type MatrixFilter = 'all' | 'with_gaps' | 'covered';

const worktreeChangeLabels = {
  added: 'Criado',
  modified: 'Modificado',
  deleted: 'Removido',
} as const;

const testStatusLabels = {
  passed: 'Passou',
  failed: 'Falhou',
  skipped: 'Ignorado',
} as const;

const testStatusClasses = {
  passed: 'border-accent/35 bg-accent/10 text-accent',
  failed: 'border-danger/35 bg-danger/10 text-danger',
  skipped: 'border-warning/35 bg-warning/10 text-warning',
} as const;

const overallTestsLabels = {
  passed: 'Aprovados',
  failed: 'Com falhas',
  not_run: 'Não executados',
} as const;

const reviewStatusPresentation: Record<
  FactoryTraceabilityRow['review']['status'],
  { label: string; badgeClass: string }
> = {
  pending: {
    label: 'Aguardando Review',
    badgeClass: 'border-line bg-page text-muted',
  },
  clean: {
    label: 'Sem apontamentos',
    badgeClass: 'border-accent/35 bg-accent/10 text-accent',
  },
  warnings: {
    label: 'Com ressalvas',
    badgeClass: 'border-warning/35 bg-warning/10 text-warning',
  },
  blocked: {
    label: 'Bloqueado',
    badgeClass: 'border-danger/35 bg-danger/10 text-danger',
  },
};

const findingSeverityClasses = {
  BLOQUEANTE: 'border-danger/35 bg-danger/10 text-danger',
  SUGESTÃO: 'border-warning/35 bg-warning/10 text-warning',
  NIT: 'border-line bg-page text-secondary',
} as const;

function hasErrorGap(gaps: readonly FactoryTraceabilityGap[]): boolean {
  return gaps.some(gap => gap.severity === 'error');
}

function FileBadgeList({ file }: { file: FactoryTraceabilityFile }) {
  const isChanged = file.changedInWorktree || file.changedInDevelopment;
  return (
    <li className="space-y-1 rounded-md border border-line-subtle bg-page px-2.5 py-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <code className="break-all font-mono text-primary">
          <bdi>{file.path}</bdi>
        </code>
        {file.binary ? (
          <span className="text-[10px] text-muted">Binário</span>
        ) : (
          file.additions !== null &&
          file.deletions !== null && (
            <span className="shrink-0 space-x-1.5 font-mono text-[10px]">
              <span className="text-accent">+{file.additions}</span>
              <span className="text-danger">−{file.deletions}</span>
            </span>
          )
        )}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px]">
        {file.worktreeChange && (
          <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-accent">
            Worktree · {worktreeChangeLabels[file.worktreeChange]}
          </span>
        )}
        {file.changedInDevelopment && (
          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-secondary">
            Desenvolvimento
          </span>
        )}
        {file.planned && (
          <span
            className={`rounded border px-1.5 py-0.5 ${
              isChanged
                ? 'border-line bg-surface text-muted'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {isChanged ? 'Planejado' : 'Planejado · sem alteração'}
          </span>
        )}
      </div>
    </li>
  );
}

function MatrixRow({ row }: { row: FactoryTraceabilityRow }) {
  const errorGap = hasErrorGap(row.gaps);
  const anyGap = row.gaps.length > 0;
  const rowHighlightClass = errorGap
    ? 'bg-danger/5'
    : anyGap
      ? 'bg-warning/5'
      : '';
  const reviewBadge = reviewStatusPresentation[row.review.status];

  return (
    <tr className={`border-t border-line align-top ${rowHighlightClass}`}>
      <th scope="row" className="min-w-56 p-3 text-left font-normal">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-accent/35 bg-selected px-2 py-0.5 font-mono text-[11px] font-semibold text-accent">
              {row.criterion.id}
            </span>
            {row.criterion.approved === true ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                <CheckCircle2 size={10} aria-hidden="true" />
                Aprovado
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-page px-2 py-0.5 text-[10px] text-muted">
                <Clock size={10} aria-hidden="true" />
                Da Triagem
              </span>
            )}
            {anyGap ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                  errorGap
                    ? 'border-danger/35 bg-danger/10 text-danger'
                    : 'border-warning/35 bg-warning/10 text-warning'
                }`}
              >
                {errorGap ? (
                  <AlertCircle size={10} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={10} aria-hidden="true" />
                )}
                {row.gaps.length} {row.gaps.length === 1 ? 'lacuna' : 'lacunas'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                <CheckCircle2 size={10} aria-hidden="true" />
                Rastreabilidade completa
              </span>
            )}
          </div>
          <p className="text-xs leading-5 text-primary">{row.criterion.description}</p>
          {row.gaps.length > 0 && (
            <ul aria-label={`Lacunas de ${row.criterion.id}`} className="space-y-1">
              {row.gaps.map((gap, index) => (
                <li
                  key={`${gap.code}-${index}`}
                  className={`flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-4 ${
                    gap.severity === 'error'
                      ? 'border-danger/30 bg-danger/10 text-danger'
                      : 'border-warning/30 bg-warning/10 text-warning'
                  }`}
                >
                  {gap.severity === 'error' ? (
                    <AlertCircle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                  ) : (
                    <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                  )}
                  <span>{gap.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </th>

      <td className="min-w-48 p-3 text-xs">
        {row.plan.testPlanItems.length > 0 || row.plan.plannedFiles.length > 0 ? (
          <div className="space-y-2">
            {row.plan.testPlanItems.length > 0 && (
              <ul className="space-y-1">
                {row.plan.testPlanItems.map((item, index) => (
                  <li
                    key={`${index}-${item}`}
                    className="rounded-md border border-line-subtle bg-page px-2 py-1.5 text-[11px] leading-4 text-secondary"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            )}
            {row.plan.plannedFiles.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
                  Arquivos previstos
                </p>
                <ul className="space-y-1">
                  {row.plan.plannedFiles.map(path => (
                    <li key={path} className="break-all font-mono text-[11px] text-muted">
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-warning">Sem item de plano vinculado</p>
        )}
      </td>

      <td className="min-w-52 p-3 text-xs">
        {row.files.length > 0 ? (
          <ul className="space-y-1.5">
            {row.files.map(file => (
              <FileBadgeList key={file.path} file={file} />
            ))}
          </ul>
        ) : (
          <p className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">
            <AlertCircle size={12} aria-hidden="true" />
            Sem arquivo vinculado
          </p>
        )}
      </td>

      <td className="min-w-52 p-3 text-xs">
        {row.tests.cases.length > 0 ? (
          <ul className="space-y-1.5">
            {row.tests.cases.map(testCase => (
              <li
                key={testCase.id}
                className="space-y-1 rounded-md border border-line-subtle bg-page px-2.5 py-2 text-[11px]"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <code className="font-mono font-semibold text-primary">{testCase.id}</code>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${testStatusClasses[testCase.status]}`}
                  >
                    {testStatusLabels[testCase.status]}
                  </span>
                </div>
                <p className="text-secondary">{testCase.description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">
            <AlertCircle size={12} aria-hidden="true" />
            Sem teste vinculado
          </p>
        )}
      </td>

      <td className="min-w-52 p-3 text-xs">
        <div className="space-y-2">
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${reviewBadge.badgeClass}`}
          >
            {reviewBadge.label}
          </span>
          {row.review.findings.length > 0 && (
            <ul className="space-y-1.5">
              {row.review.findings.map((finding, index) => (
                <li
                  key={`${index}:${finding.file}:${finding.line}`}
                  className="space-y-1 rounded-md border border-line-subtle bg-page px-2.5 py-2 text-[11px]"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${findingSeverityClasses[finding.severity]}`}
                    >
                      {finding.severity}
                    </span>
                    <code className="break-all font-mono text-[10px] text-muted">
                      {finding.file}:{finding.line}
                    </code>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-secondary">
                    {finding.explanation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </td>
    </tr>
  );
}

export function FactoryFlowTraceabilityPanel({
  flowId,
  updatedAt,
  initialMatrix,
}: {
  flowId: string;
  updatedAt?: string;
  initialMatrix?: FactoryFlowTraceabilityMatrix;
}) {
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const request = useCallback(
    (signal: AbortSignal) => fetchFactoryFlowTraceability(flowId, signal),
    [flowId],
  );
  const { result, reload } = useFactoryInspection(request, updatedAt);
  const matrix = result && 'data' in result ? result.data : (initialMatrix ?? null);

  const visibleRows = useMemo(() => {
    if (!matrix) {
      return [];
    }
    switch (filter) {
      case 'with_gaps':
        return matrix.rows.filter(row => row.gaps.length > 0);
      case 'covered':
        return matrix.rows.filter(row => row.gaps.length === 0);
      case 'all':
        return matrix.rows;
    }
  }, [filter, matrix]);

  if (!result && !matrix) {
    return (
      <p role="status" className="text-xs text-muted">
        Carregando matriz de rastreabilidade…
      </p>
    );
  }

  if (result && 'error' in result && !matrix) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-danger">
          {result.error}
        </p>
        <button type="button" onClick={reload} className="modal-button">
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!matrix) {
    return null;
  }

  const verdictPresentation = matrix.reviewVerdict
    ? getFactoryReviewVerdictPresentation(matrix.reviewVerdict)
    : null;
  const hasUnlinkedItems =
    matrix.unlinked.changedFiles.length > 0 ||
    matrix.unlinked.plannedFiles.length > 0 ||
    matrix.unlinked.testPlanItems.length > 0 ||
    matrix.unlinked.testCases.length > 0 ||
    matrix.unlinked.findings.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-primary">
            Matriz de Rastreabilidade (CA → Plano → Arquivo → Teste → Review)
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            Cruzamento dos sidecars JSON das etapas 01–05 com os arquivos alterados do worktree.
          </p>
        </div>
        <button type="button" className="modal-button" onClick={reload} disabled={!result && !initialMatrix}>
          Atualizar matriz
        </button>
      </div>

      {result && 'error' in result && (
        <p role="alert" className="text-xs text-danger">
          {result.error}
        </p>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Critérios de aceite</p>
          <p className="mt-1 font-mono text-base font-semibold text-primary">
            {matrix.summary.coveredCriteria}/{matrix.summary.totalCriteria} cobertos
          </p>
        </div>
        <div
          className={`rounded-xl border p-3 ${
            matrix.summary.criteriaWithGaps > 0
              ? 'border-warning/40 bg-warning/10'
              : 'border-line bg-surface'
          }`}
        >
          <p className="text-[11px] text-muted">Critérios com lacunas</p>
          <p
            className={`mt-1 font-mono text-base font-semibold ${
              matrix.summary.criteriaWithGaps > 0 ? 'text-warning' : 'text-accent'
            }`}
          >
            {matrix.summary.criteriaWithGaps}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Arquivos e testes</p>
          <p className="mt-1 font-mono text-sm font-semibold text-primary">
            {matrix.summary.totalChangedFiles} arquivos · {matrix.summary.totalTestCases} testes
          </p>
          {matrix.testsStatus && (
            <p className="mt-0.5 text-[11px] text-muted">
              Suíte: {overallTestsLabels[matrix.testsStatus]}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-[11px] text-muted">Code Review</p>
          <p className="mt-1 font-mono text-sm font-semibold text-primary">
            {matrix.summary.totalFindings} apontamentos ({matrix.summary.blockingFindings} bloqueantes)
          </p>
          {verdictPresentation && (
            <p className={`mt-0.5 text-[11px] font-medium ${verdictPresentation.textClass}`}>
              {verdictPresentation.label}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>Fontes lidas:</span>
          {[
            ['Triagem', matrix.stagesAvailable.triage],
            ['Planejamento', matrix.stagesAvailable.planning],
            ['Desenvolvimento', matrix.stagesAvailable.development],
            ['Testes', matrix.stagesAvailable.tests],
            ['Review', matrix.stagesAvailable.review],
            ['Worktree', matrix.worktreeAvailable],
          ].map(([label, available]) => (
            <span
              key={String(label)}
              className={`rounded-full border px-2 py-0.5 ${
                available
                  ? 'border-accent/30 bg-accent/10 text-accent'
                  : 'border-line bg-surface text-muted'
              }`}
            >
              {label}
            </span>
          ))}
        </div>

        {matrix.rows.length > 0 && (
          <div role="group" aria-label="Filtrar critérios da matriz" className="flex flex-wrap gap-1">
            {(
              [
                ['all', `Todos (${matrix.rows.length})`],
                ['with_gaps', `Com lacunas (${matrix.summary.criteriaWithGaps})`],
                ['covered', `Sem lacunas (${matrix.summary.coveredCriteria})`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className="rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-secondary hover:bg-hover aria-pressed:border-accent aria-pressed:bg-selected aria-pressed:text-accent"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!matrix.worktreeAvailable && (
        <p className="text-xs text-muted">
          Worktree isolado indisponível; exibindo os arquivos registrados nos sidecars das etapas.
        </p>
      )}
      {matrix.worktreeFilesTruncated && (
        <p role="status" className="text-xs text-warning">
          A lista de arquivos do worktree atingiu o limite de leitura para correlação.
        </p>
      )}

      {matrix.rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-xs text-muted">
          Nenhum critério de aceite registrado para montar a matriz de rastreabilidade.
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-xs text-muted">
          Nenhum critério corresponde ao filtro selecionado.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table aria-label="Matriz de Rastreabilidade" className="w-full border-collapse text-left">
            <thead className="bg-page text-[11px] font-semibold uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="p-3">Critério (CA)</th>
                <th scope="col" className="p-3">Plano (Bloco 02)</th>
                <th scope="col" className="p-3">Arquivos (Bloco 03 / Worktree)</th>
                <th scope="col" className="p-3">Testes (Bloco 04)</th>
                <th scope="col" className="p-3">Review (Bloco 05)</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(row => (
                <MatrixRow key={row.criterion.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasUnlinkedItems && (
        <section
          aria-label="Itens sem critério de aceite vinculado"
          className="space-y-3 rounded-xl border border-warning/35 bg-warning/5 p-4"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-warning">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Itens sem critério de aceite vinculado</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {matrix.unlinked.changedFiles.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-primary">
                  Arquivos alterados sem CA vinculado ({matrix.unlinked.changedFiles.length})
                </h4>
                <ul className="space-y-1.5">
                  {matrix.unlinked.changedFiles.map(file => (
                    <FileBadgeList key={file.path} file={file} />
                  ))}
                </ul>
              </div>
            )}
            {matrix.unlinked.plannedFiles.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-primary">
                  Arquivos planejados sem CA vinculado ({matrix.unlinked.plannedFiles.length})
                </h4>
                <ul className="space-y-1 rounded-md border border-line-subtle bg-page p-2.5 text-[11px]">
                  {matrix.unlinked.plannedFiles.map(path => (
                    <li key={path} className="break-all font-mono text-secondary">
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {matrix.unlinked.testPlanItems.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-primary">
                  Itens do plano de testes sem CA vinculado ({matrix.unlinked.testPlanItems.length})
                </h4>
                <ul className="space-y-1 rounded-md border border-line-subtle bg-page p-2.5 text-[11px] text-secondary">
                  {matrix.unlinked.testPlanItems.map((item, index) => (
                    <li key={`${index}-${item}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {matrix.unlinked.testCases.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-primary">
                  Casos de teste sem CA aprovado ({matrix.unlinked.testCases.length})
                </h4>
                <ul className="space-y-1.5">
                  {matrix.unlinked.testCases.map(testCase => (
                    <li
                      key={testCase.id}
                      className="rounded-md border border-line-subtle bg-page px-2.5 py-2 text-[11px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <code className="font-mono font-semibold text-primary">{testCase.id}</code>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${testStatusClasses[testCase.status]}`}
                        >
                          {testStatusLabels[testCase.status]}
                        </span>
                      </div>
                      <p className="mt-1 text-secondary">{testCase.description}</p>
                      <p className="mt-0.5 text-[10px] text-muted">
                        CAs citados: {testCase.acceptanceCriteriaIds.join(', ')}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {matrix.unlinked.findings.length > 0 && (
              <div className="space-y-1.5 md:col-span-2">
                <h4 className="text-xs font-medium text-primary">
                  Apontamentos de Review sem CA vinculado ({matrix.unlinked.findings.length})
                </h4>
                <ul className="space-y-1.5">
                  {matrix.unlinked.findings.map((finding, index) => (
                    <li
                      key={`${index}:${finding.file}:${finding.line}`}
                      className="rounded-md border border-line-subtle bg-page px-2.5 py-2 text-[11px]"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${findingSeverityClasses[finding.severity]}`}
                        >
                          {finding.severity}
                        </span>
                        <code className="break-all font-mono text-[10px] text-muted">
                          {finding.file}:{finding.line}
                        </code>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-secondary">
                        {finding.explanation}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {matrix.excludedCriteria.length > 0 && (
        <section
          aria-label="Critérios não aprovados no Planejamento"
          className="space-y-2 rounded-xl border border-line bg-surface p-4"
        >
          <h4 className="text-xs font-semibold text-secondary">
            Critérios não aprovados no Planejamento ({matrix.excludedCriteria.length})
          </h4>
          <ul className="space-y-1 text-xs text-muted">
            {matrix.excludedCriteria.map(item => (
              <li key={item.id}>
                <code className="font-mono text-secondary">{item.id}</code> — {item.description}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
