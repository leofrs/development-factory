import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { DirectoryListing } from '@development-factory/shared';

export async function listDirectories(requestedPath?: string): Promise<DirectoryListing> {
  const input = requestedPath || homedir();
  if (!isAbsolute(input) || input.includes('\0')) throw new Error('Use um caminho absoluto do WSL.');
  const path = await realpath(input);
  const entries = await readdir(path, { withFileTypes: true });
  const directories = await Promise.all(entries.map(async entry => {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) return { name: entry.name, path: childPath };
    if (entry.isSymbolicLink()) {
      try { if ((await stat(childPath)).isDirectory()) return { name: entry.name, path: childPath }; }
      catch { /* Links inacessíveis não são navegáveis. */ }
    }
    return undefined;
  }));
  return {
    path,
    parentPath: dirname(path) === path ? null : dirname(path),
    directories: directories.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
