import { spawn } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { FactoryDevelopmentSidecarSchema } from '@development-factory/shared';
import type { FactoryDevelopmentChecks, FactoryRepositoryProfile } from '@development-factory/shared';
import { FactoryStageArtifactError, getFactoryStageSidecarPath } from './factory-stage-runners.js';
import { maxHistoryBytes } from './history-reader.js';
import { validateFactoryStageArtifacts } from './history.js';
import { SessionOutputBuffer } from './session-buffer.js';

type DevelopmentCommand = FactoryRepositoryProfile['commands']['typecheck'];
const DIAGNOSTIC_SAMPLE_BYTES = 8 * 1024;

function runDevelopmentCheck(
  command: DevelopmentCommand,
  cwd: string,
  signal: AbortSignal,
): Promise<FactoryDevelopmentChecks['typecheck']> {
  if (!command) {
    return Promise.resolve(null);
  }
  signal.throwIfAborted();
  const [executable, ...args] = command;

  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const diagnostics = new SessionOutputBuffer(DIAGNOSTIC_SAMPLE_BYTES);
    const collect = (chunk: string) => diagnostics.append(chunk);
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);

    const abort = () => {
      if (child.pid !== undefined) {
        try {
          // No WSL, o grupo inclui os subprocessos criados por wrappers como npm.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // O grupo pode ter terminado antes do cancelamento.
        }
      }
    };
    signal.addEventListener('abort', abort, { once: true });

    let launchError: NodeJS.ErrnoException | undefined;
    child.once('error', (error: NodeJS.ErrnoException) => {
      launchError = error;
    });
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      // Em uma falha de spawn, o Node pode devolver um código interno negativo.
      const exitCode = launchError ? null : code;
      let errorSummary: string | null = null;
      if (launchError) {
        errorSummary = `Não foi possível iniciar o comando (${launchError.code ?? 'erro de execução'}).`;
      } else if (exitSignal) {
        errorSummary = `O comando foi encerrado pelo sinal ${exitSignal}.`;
      } else if (exitCode !== 0) {
        // Preserva diagnósticos estruturados sem persistir a saída arbitrária do processo.
        const output = stripVTControlCharacters(diagnostics.replay());
        const codes = new Set(
          Array.from(
            output.matchAll(/\b(?:error|erro) +([A-Z]{1,4}\d{3,5})(?=:)/g),
            match => match[1],
          ).filter(code => code !== undefined),
        );
        errorSummary = `O comando encerrou com código ${exitCode ?? 'indisponível'}.`;
        if (codes.size > 0) {
          errorSummary += ` Diagnósticos ${[...codes].slice(0, 10).join(', ')}.`;
        }
      }
      resolve({ command, exitCode, errorSummary });
    });
  });
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
  const backendChecks = {
    typecheck: await runDevelopmentCheck(commands.typecheck, worktreePath, signal),
    lint: await runDevelopmentCheck(commands.lint, worktreePath, signal),
  };
  signal.throwIfAborted();

  const sidecarPath = getFactoryStageSidecarPath(reportPath);
  try {
    const validated = FactoryDevelopmentSidecarSchema.parse({ ...sidecar, backendChecks });
    const content = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(content) > maxHistoryBytes) {
      throw new Error('O sidecar com as verificações excede o limite de 5 MB.');
    }
    const temporaryDirectory = mkdtempSync(join(dirname(sidecarPath), '.development-checks-'));
    try {
      const temporaryPath = join(temporaryDirectory, 'sidecar.json');
      writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, sidecarPath);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  } catch {
    throw new FactoryStageArtifactError(
      'FACTORY_SIDECAR_WRITE_FAILED',
      'development',
      sidecarPath,
      'Não foi possível gravar as verificações de Desenvolvimento no sidecar de até 5 MB',
    );
  }
  return getFactoryDevelopmentChecksError(reportPath, backendChecks);
}
