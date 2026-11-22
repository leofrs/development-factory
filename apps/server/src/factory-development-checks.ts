import { FactoryDevelopmentSidecarSchema } from '@development-factory/shared';
import type { FactoryDevelopmentChecks, FactoryRepositoryProfile } from '@development-factory/shared';
import { runBackendCommandCheck, writeValidatedStageSidecar } from './factory-backend-checks.js';
import { FactoryStageArtifactError, getFactoryStageSidecarPath } from './factory-stage-runners.js';
import { validateFactoryStageArtifacts } from './history.js';

function summarizeDevelopmentFailure(output: string): string | undefined {
  // Preserva diagnósticos estruturados sem persistir a saída arbitrária do processo.
  const codes = new Set(
    Array.from(
      output.matchAll(/\b(?:error|erro) +([A-Z]{1,4}\d{3,5})(?=:)/g),
      match => match[1],
    ).filter((code): code is string => code !== undefined),
  );
  if (codes.size > 0) {
    return `Diagnósticos ${[...codes].slice(0, 10).join(', ')}.`;
  }
  return undefined;
}

export function getFactoryDevelopmentChecksError(
  reportPath: string,
  checks: FactoryDevelopmentChecks | undefined,
): FactoryStageArtifactError | undefined {
  if (!checks) {
    return undefined;
  }
  const issues = Object.entries(checks).flatMap(([check, result]) =>
    result?.errorSummary
      ? [{ code: 'check_failed', path: ['backendChecks', check], message: result.errorSummary }]
      : [],
  );
  if (issues.length > 0) {
    return new FactoryStageArtifactError(
      'FACTORY_DEVELOPMENT_CHECKS_FAILED',
      'development',
      getFactoryStageSidecarPath(reportPath),
      'As verificações de Desenvolvimento falharam',
      issues,
    );
  }
  return undefined;
}

export async function appendFactoryDevelopmentChecks(
  reportPath: string,
  worktreePath: string,
  commands: Pick<FactoryRepositoryProfile['commands'], 'typecheck' | 'lint'>,
  signal: AbortSignal,
): Promise<FactoryStageArtifactError | undefined> {
  signal.throwIfAborted();
  const sidecar = validateFactoryStageArtifacts('development', reportPath);
  const typecheckResult = await runBackendCommandCheck(commands.typecheck, worktreePath, signal, {
    summarizeFailure: summarizeDevelopmentFailure,
  });
  const lintResult = await runBackendCommandCheck(commands.lint, worktreePath, signal, {
    summarizeFailure: summarizeDevelopmentFailure,
  });
  const backendChecks: FactoryDevelopmentChecks = {
    typecheck: typecheckResult.check,
    lint: lintResult.check,
  };
  signal.throwIfAborted();

  writeValidatedStageSidecar(
    'development',
    reportPath,
    { ...sidecar, backendChecks },
    FactoryDevelopmentSidecarSchema,
    'Não foi possível gravar as verificações de Desenvolvimento no sidecar de até 5 MB',
  );
  return getFactoryDevelopmentChecksError(reportPath, backendChecks);
}
