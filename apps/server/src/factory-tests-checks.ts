import { stripVTControlCharacters } from 'node:util';
import { FactoryTestsSidecarSchema } from '@development-factory/shared';
import type {
  FactoryBackendCommandCheck,
  FactoryRepositoryProfile,
  FactoryTestsChecks,
  FactoryTestsSidecar,
} from '@development-factory/shared';
import { runBackendCommandCheck, writeValidatedStageSidecar } from './factory-backend-checks.js';
import { validateFactoryStageArtifacts } from './history.js';

const TEST_OUTPUT_BYTES = 64 * 1024;

function parsePercentToken(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().replace(/%$/, '');
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value;
}

/**
 * Extrai métricas reais de cobertura (linhas e branches) da saída de ferramentas comuns
 * (`node --test --experimental-test-coverage`, Istanbul/c8/Vitest/Jest, text-summary e pytest-cov).
 */
export function parseTestCoverageFromOutput(
  rawOutput: string,
): FactoryTestsSidecar['coverage'] {
  const output = stripVTControlCharacters(rawOutput);
  if (output.trim().length === 0) {
    return null;
  }

  // 1. Tabela do Node.js test runner (`file | line % | branch % | funcs %`)
  if (/file\s*\|\s*line\s*%\s*\|\s*branch\s*%\s*\|/i.test(output)) {
    const nodeRow =
      /(?:^|\n)[ \t]*(?:ℹ[ \t]+)?all files[ \t]*\|([^|\n]+)\|([^|\n]+)\|/i.exec(output);
    const linesPercent = parsePercentToken(nodeRow?.[1]);
    if (linesPercent !== null) {
      return {
        linesPercent,
        branchesPercent: parsePercentToken(nodeRow?.[2]),
      };
    }
  }

  // 2. Tabela Istanbul / Jest / Vitest / c8 (`% Stmts | % Branch | % Funcs | % Lines`)
  if (/%\s*stmts\s*\|\s*%\s*branch\s*\|\s*%\s*funcs\s*\|\s*%\s*lines/i.test(output)) {
    const istanbulRow =
      /(?:^|\n)[ \t]*all files[ \t]*\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)/i.exec(output);
    const linesPercent = parsePercentToken(istanbulRow?.[4]);
    if (linesPercent !== null) {
      return {
        linesPercent,
        branchesPercent: parsePercentToken(istanbulRow?.[2]),
      };
    }
  }

  // 3. Resumo textual (`Lines : 88.5%`, `Branches : 76.25%`)
  const linesSummary =
    /^[ \t]*(?:ℹ[ \t]+)?(?:lines|linhas)(?:\s+coverage)?[ \t]*[:=][ \t]*(\d+(?:\.\d+)?)\s*%/im.exec(
      output,
    );
  const linesPercent = parsePercentToken(linesSummary?.[1]);
  if (linesPercent !== null) {
    const branchesSummary =
      /^[ \t]*(?:ℹ[ \t]+)?(?:branches|ramos)(?:\s+coverage)?[ \t]*[:=][ \t]*(\d+(?:\.\d+)?)\s*%/im.exec(
        output,
      );
    return {
      linesPercent,
      branchesPercent: parsePercentToken(branchesSummary?.[1]),
    };
  }

  // 4. Linha TOTAL (ex.: pytest-cov / coverage.py)
  const totalRow = /^[ \t]*TOTAL\b[^\n]*?[ \t](\d+(?:\.\d+)?)\s*%(?:[ \t]*|$)/m.exec(output);
  const totalLinesPercent = parsePercentToken(totalRow?.[1]);
  if (totalLinesPercent !== null) {
    return {
      linesPercent: totalLinesPercent,
      branchesPercent: null,
    };
  }

  return null;
}

function summarizeTestFailure(output: string): string | undefined {
  const nodeFailMatch = /^[ \t]*ℹ[ \t]+fail[ \t]+(\d+)\b/im.exec(output);
  if (nodeFailMatch?.[1] && Number(nodeFailMatch[1]) > 0) {
    return `Falharam ${nodeFailMatch[1]} teste(s).`;
  }
  const genericFailMatch = /\b(\d+)\s+failed\b/i.exec(output);
  if (genericFailMatch?.[1] && Number(genericFailMatch[1]) > 0) {
    return `Falharam ${genericFailMatch[1]} teste(s).`;
  }
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

/**
 * Executa deterministicamente os comandos de teste e cobertura do perfil no worktree após a sessão
 * e grava `executedCommands`, `status`, `coverage` e `backendChecks` reais no sidecar JSON.
 */
export async function appendFactoryTestsChecks(
  reportPath: string,
  worktreePath: string,
  commands: Pick<FactoryRepositoryProfile['commands'], 'test' | 'coverage'>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const sidecar = validateFactoryStageArtifacts('tests', reportPath);

  const testResult = await runBackendCommandCheck(commands.test, worktreePath, signal, {
    maxOutputBytes: TEST_OUTPUT_BYTES,
    summarizeFailure: summarizeTestFailure,
  });
  const coverageResult = await runBackendCommandCheck(commands.coverage, worktreePath, signal, {
    maxOutputBytes: TEST_OUTPUT_BYTES,
    summarizeFailure: summarizeTestFailure,
  });
  signal.throwIfAborted();

  const backendChecks: FactoryTestsChecks = {
    test: testResult.check,
    coverage: coverageResult.check,
  };
  const executedChecks = [backendChecks.test, backendChecks.coverage].filter(
    (check): check is FactoryBackendCommandCheck => check !== null,
  );
  const executedCommands: FactoryTestsSidecar['executedCommands'] = executedChecks.map(check => ({
    command: check.command,
    exitCode: check.exitCode,
  }));
  const status: FactoryTestsSidecar['status'] =
    executedChecks.length === 0
      ? 'not_run'
      : executedChecks.every(check => check.exitCode === 0)
        ? 'passed'
        : 'failed';
  const coverage: FactoryTestsSidecar['coverage'] =
    executedChecks.length === 0
      ? null
      : (parseTestCoverageFromOutput(coverageResult.output) ??
        parseTestCoverageFromOutput(testResult.output));

  writeValidatedStageSidecar(
    'tests',
    reportPath,
    {
      ...sidecar,
      executedCommands,
      status,
      coverage,
      backendChecks,
    },
    FactoryTestsSidecarSchema,
    'Não foi possível gravar os resultados dos Testes no sidecar de até 5 MB',
  );
}
