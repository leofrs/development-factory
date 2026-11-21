import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { FactoryRepositoryProfileSchema } from '@development-factory/shared';
import type { FactoryRepositoryProfile } from '@development-factory/shared';

const MANIFEST_FILENAME = '.development-factory.json';
const MANIFEST_MAX_KIB = 256;
const MANIFEST_MAX_BYTES = MANIFEST_MAX_KIB * 1024;

export type FactoryRepositoryProfileErrorCode =
  | 'INVALID_REPO_PATH'
  | 'FACTORY_MANIFEST_READ_FAILED'
  | 'INVALID_FACTORY_MANIFEST_JSON'
  | 'INVALID_FACTORY_MANIFEST';

export class FactoryRepositoryProfileError extends Error {
  constructor(
    public readonly code: FactoryRepositoryProfileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FactoryRepositoryProfileError';
  }
}

export interface LoadedFactoryRepositoryProfile {
  readonly source: 'manifest' | 'defaults';
  readonly profile: FactoryRepositoryProfile;
}

async function readManifest(manifestPath: string): Promise<Buffer | null> {
  try {
    const handle = await open(
      manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile()) {
        throw new FactoryRepositoryProfileError(
          'INVALID_FACTORY_MANIFEST',
          `O manifesto ${MANIFEST_FILENAME} precisa ser um arquivo regular.`,
        );
      }

      const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      if (offset > MANIFEST_MAX_BYTES) {
        throw new FactoryRepositoryProfileError(
          'INVALID_FACTORY_MANIFEST',
          `O manifesto ${MANIFEST_FILENAME} excede o limite de ${MANIFEST_MAX_KIB} KiB.`,
        );
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FactoryRepositoryProfileError) {
      throw error;
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw new FactoryRepositoryProfileError(
      'FACTORY_MANIFEST_READ_FAILED',
      `Não foi possível ler ${MANIFEST_FILENAME}. Confira as permissões e use um arquivo regular sem link simbólico.`,
      { cause: error },
    );
  }
}

export async function loadFactoryRepositoryProfile(
  repoRoot: string,
): Promise<LoadedFactoryRepositoryProfile> {
  const invalidRootMessage = 'Informe o caminho absoluto da raiz do repositório no WSL.';
  if (!isAbsolute(repoRoot) || repoRoot.includes('\0')) {
    throw new FactoryRepositoryProfileError('INVALID_REPO_PATH', invalidRootMessage);
  }
  const directory = resolve(repoRoot);
  const root = await stat(directory).catch((cause: unknown) => {
    throw new FactoryRepositoryProfileError('INVALID_REPO_PATH', invalidRootMessage, { cause });
  });
  if (!root.isDirectory()) {
    throw new FactoryRepositoryProfileError('INVALID_REPO_PATH', invalidRootMessage);
  }

  const content = await readManifest(join(directory, MANIFEST_FILENAME));
  if (content === null) {
    return { source: 'defaults', profile: FactoryRepositoryProfileSchema.parse({}) };
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } catch {
    throw new FactoryRepositoryProfileError(
      'INVALID_FACTORY_MANIFEST_JSON',
      `O manifesto ${MANIFEST_FILENAME} contém JSON inválido. Confira a sintaxe e a codificação UTF-8.`,
    );
  }

  const result = FactoryRepositoryProfileSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const field = issue.path.join('.') || 'raiz do manifesto';
      return `${field} (${issue.message})`;
    });
    throw new FactoryRepositoryProfileError(
      'INVALID_FACTORY_MANIFEST',
      `Campos inválidos em ${MANIFEST_FILENAME}.\n${details.join('\n')}`,
    );
  }

  return { source: 'manifest', profile: result.data };
}
