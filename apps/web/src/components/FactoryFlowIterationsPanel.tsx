import { useCallback, useMemo, useState } from 'react';
import { getFactoryComparableIterations } from '@development-factory/shared';
import type {
  FactoryFlow,
  FactoryFlowDetails,
  FactoryIterationEvidence,
} from '@development-factory/shared';
import { fetchFactoryFlowIterationComparison } from '../api/factory-flows.js';
import { useFactoryInspection } from '../hooks/useFactoryInspection.js';
import {
  getFactoryReviewVerdictPresentation,
  getFactoryStageLabel,
} from '../utils/factory-flow-status.js';
import { FactoryFlowDiffPanel } from './FactoryFlowDiffPanel.js';

const testStatusLabels: Record<NonNullable<FactoryIterationEvidence['tests']>['status'], string> = {
  passed: 'Aprovados',
  failed: 'Com falhas',
  not_run: 'Não executados',
};

const testCaseStatusLabels = { passed: 'Passou', failed: 'Falhou', skipped: 'Ignorado' };

function CycleEvidence({ evidence }: { evidence: FactoryIterationEvidence }) {
  const { tests, review, checkpoint } = evidence;
  const verdict = review ? getFactoryReviewVerdictPresentation(review.verdict) : null;
  const caseCount = tests ? tests.passed + tests.failed + tests.skipped : 0;
  return (
    <article className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Ciclo {evidence.iteration}</h3>
        <p className="break-all text-xs text-muted">
          {checkpoint ? (
            <>
              <code title={checkpoint.commitSha}>{checkpoint.commitSha.slice(0, 12)}</code>
              {' · '}{getFactoryStageLabel(checkpoint.stage)}
            </>
          ) : (
            'Checkpoint indisponível'
          )}
        </p>
      </div>
      <section className="space-y-2 border-t border-line pt-3">
        <h4 className="text-xs font-semibold text-primary">Testes</h4>
        {tests ? (
          <>
            <p className="text-xs font-medium text-secondary">{testStatusLabels[tests.status]}</p>
            <p className="text-xs text-muted">
              {tests.passed} passaram · {tests.failed} falharam · {tests.skipped} ignorados
            </p>
            {tests.coverage && (
              <p className="text-xs text-muted">
                Cobertura de linhas {tests.coverage.linesPercent}%
                {tests.coverage.branchesPercent !== null && (
                  <> · Ramos {tests.coverage.branchesPercent}%</>
                )}
              </p>
            )}
            {tests.cases.length > 0 && (
              <details className="text-xs text-secondary">
                <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
                  Casos de teste ({caseCount})
                </summary>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto break-words">
                  {tests.cases.map((testCase, index) => (
                    <li key={`${index}:${testCase.id}`}>
                      <code>{testCase.id}</code> · {testCaseStatusLabels[testCase.status]}
                      <p className="text-muted">{testCase.description}</p>
                    </li>
                  ))}
                </ul>
                {caseCount > tests.cases.length && (
                  <p className="mt-2 text-muted">Exibindo {tests.cases.length} de {caseCount} casos.</p>
                )}
              </details>
            )}
            {tests.commands.length > 0 && (
              <details className="text-xs text-secondary">
                <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
                  Comandos executados ({tests.commandCount})
                </summary>
                <ul className="mt-2 space-y-1">
                  {tests.commands.map(({ command, exitCode }, index) => (
                    <li key={`${index}:${command}`} className="break-all">
                      <code>{command}</code>
                      {' · '}{exitCode === null ? 'Sem código de saída' : `Saída ${exitCode}`}
                    </li>
                  ))}
                </ul>
                {tests.commandCount > tests.commands.length && (
                  <p className="mt-2 text-muted">
                    Exibindo {tests.commands.length} de {tests.commandCount} comandos.
                  </p>
                )}
              </details>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">Resultados de testes indisponíveis.</p>
        )}
      </section>
      <section className="space-y-2 border-t border-line pt-3">
        <h4 className="text-xs font-semibold text-primary">Findings de Review</h4>
        {review && verdict ? (
          <>
            <p className={`text-xs font-medium ${verdict.textClass}`}>{verdict.label}</p>
            {review.findings.length > 0 ? (
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {review.findings.map((finding, index) => (
                  <li
                    key={`${index}:${finding.file}:${finding.line}`}
                    className="space-y-1 rounded-md bg-page p-2 text-xs"
                  >
                    <p className="break-all text-muted">
                      <strong className="text-secondary">{finding.severity}</strong>
                      {' · '}
                      <code>{finding.file}:{finding.line}</code>
                    </p>
                    <p className="whitespace-pre-wrap break-words text-secondary">
                      {finding.explanation}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">Nenhum finding registrado.</p>
            )}
            {review.findingCount > review.findings.length && (
              <p className="text-xs text-muted">
                Exibindo {review.findings.length} de {review.findingCount} findings.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">Resultados de review indisponíveis.</p>
        )}
      </section>
    </article>
  );
}

function CycleComparison({ flow, fromIteration }: { flow: FactoryFlow; fromIteration: number }) {
  const flowId = flow.id;
  const request = useCallback(
    (signal: AbortSignal) => fetchFactoryFlowIterationComparison(flowId, fromIteration, signal),
    [flowId, fromIteration],
  );
  const { result, reload } = useFactoryInspection(request, flow.updatedAt);
  const data = result && 'data' in result ? result.data : null;
  const fromCheckpointId = data?.before.checkpoint?.id;
  const toCheckpointId = data?.after.checkpoint?.id;
  const comparison = useMemo(
    () => (fromCheckpointId && toCheckpointId ? { fromCheckpointId, toCheckpointId } : undefined),
    [fromCheckpointId, toCheckpointId],
  );

  if (!result) {
    return (
      <p role="status" className="text-xs text-muted">
        Carregando comparação dos ciclos…
      </p>
    );
  }
  if ('error' in result) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-danger">
          {result.error}
        </p>
        <button type="button" className="modal-button" onClick={reload}>
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <CycleEvidence evidence={result.data.before} />
        <CycleEvidence evidence={result.data.after} />
      </div>
      {comparison && flow.worktreePath ? (
        <FactoryFlowDiffPanel
          key={`${comparison.fromCheckpointId}:${comparison.toCheckpointId}`}
          flowId={flowId}
          comparison={comparison}
        />
      ) : (
        <p className="text-xs text-muted">
          {!flow.worktreePath
            ? 'O worktree está indisponível para consultar o diff entre checkpoints.'
            : 'A comparação de código fica disponível quando os dois ciclos tiverem checkpoints.'}
        </p>
      )}
    </div>
  );
}

export function FactoryFlowIterationsPanel({
  flow,
  details,
}: {
  flow: FactoryFlow;
  details: FactoryFlowDetails;
}) {
  const [selection, setSelection] = useState<number | null>(null);
  const pairs = getFactoryComparableIterations(details);
  const fromIteration = selection !== null && pairs.includes(selection) ? selection : pairs.at(-1);
  if (fromIteration === undefined) {
    return (
      <p className="text-sm text-muted">
        A comparação fica disponível quando houver dois ciclos consecutivos registrados.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block w-fit space-y-1 text-xs font-medium text-secondary">
        Ciclos para comparar
        <select
          className="field block w-full px-3"
          value={fromIteration}
          onChange={event => setSelection(Number(event.currentTarget.value))}
        >
          {pairs.map(iteration => (
            <option key={iteration} value={iteration}>
              Ciclo {iteration} → Ciclo {iteration + 1}
            </option>
          ))}
        </select>
      </label>
      <CycleComparison flow={flow} fromIteration={fromIteration} />
    </div>
  );
}
