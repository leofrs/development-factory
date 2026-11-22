import { spawn } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { z } from 'zod';
import type {
  FactoryBackendCommandCheck,
  FactoryRepositoryProfile,
  FactoryStageName,
} from '@development-factory/shared';
import { FactoryStageArtifactError, getFactoryStageSidecarPath } from './factory-stage-runners.js';
import { maxHistoryBytes } from './history-reader.js';
import { redactSecrets, redactSecretsInValue } from './secret-redaction.js';
import { SessionOutputBuffer } from './session-buffer.js';

export type ProfileCommand = FactoryRepositoryProfile['commands']['typecheck'];
export type BackendCommandStartListener = (command: NonNullable<ProfileCommand>) => void;

export interface BackendCommandCheckOptions {
  readonly maxOutputBytes?: number;
  readonly summarizeFailure?: (plainOutput: string, exitCode: number | null) => string | undefined;
  readonly onStart?: BackendCommandStartListener;
}

export interface BackendCommandCheckResult {
  readonly check: FactoryBackendCommandCheck | null;
  readonly output: string;
}

const DEFAULT_OUTPUT_BYTES = 8 * 1024;

/** Executa um comando configurado do perfil no worktree sem shell, capturando código de saída e saída final. */
export function runBackendCommandCheck(
  command: ProfileCommand,
  cwd: string,
  signal: AbortSignal,
  options: BackendCommandCheckOptions = {},
): Promise<BackendCommandCheckResult> {
  if (!command) {
    return Promise.resolve({ check: null, output: '' });
  }
  signal.throwIfAborted();
  const [executable, ...args] = command;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;

  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const outputBuffer = new SessionOutputBuffer(maxOutputBytes);
    const collect = (chunk: string) => outputBuffer.append(chunk);
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
    child.once('spawn', () => options.onStart?.(command));
    child.once('error', (error: NodeJS.ErrnoException) => {
      launchError = error;
    });
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      // Em uma falha de spawn, o Node pode devolver um código interno negativo.
      const exitCode = launchError ? null : code;
      const plainOutput = redactSecrets(stripVTControlCharacters(outputBuffer.replay()));
      let errorSummary: string | null = null;
      if (launchError) {
        errorSummary = `Não foi possível iniciar o comando (${launchError.code ?? 'erro de execução'}).`;
      } else if (exitSignal) {
        errorSummary = `O comando foi encerrado pelo sinal ${exitSignal}.`;
      } else if (exitCode !== 0) {
        const baseSummary = `O comando encerrou com código ${exitCode ?? 'indisponível'}.`;
        const extra = options.summarizeFailure?.(plainOutput, exitCode);
        errorSummary = extra ? `${baseSummary} ${extra}` : baseSummary;
      }
      const safeCommand = command.map(redactSecrets) as NonNullable<ProfileCommand>;
      resolve({
        check: {
          command: safeCommand,
          exitCode,
          errorSummary: errorSummary === null ? null : redactSecrets(errorSummary),
        },
        output: plainOutput,
      });
    });
  });
}

/** Valida e substitui atomicamente o sidecar JSON de uma etapa preservando permissão restrita e limite de 5 MB. */
export function writeValidatedStageSidecar<T>(
  stage: FactoryStageName,
  reportPath: string,
  payload: unknown,
  schema: z.ZodType<T>,
  writeErrorMessage: string,
): T {
  const sidecarPath = getFactoryStageSidecarPath(reportPath);
  try {
    const sanitizedPayload = redactSecretsInValue(payload);
    const validated = schema.parse(sanitizedPayload);
    const content = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(content) > maxHistoryBytes) {
      throw new Error('O sidecar com as verificações excede o limite de 5 MB.');
    }
    const temporaryDirectory = mkdtempSync(join(dirname(sidecarPath), `.${stage}-checks-`));
    try {
      const temporaryPath = join(temporaryDirectory, 'sidecar.json');
      writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, sidecarPath);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    return validated;
  } catch {
    throw new FactoryStageArtifactError('FACTORY_SIDECAR_WRITE_FAILED', stage, sidecarPath, writeErrorMessage);
  }
}
