import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { HistoryFile, HistoryListing } from '@development-factory/shared';
import { listDirectories } from './directories.js';

export const maxHistoryBytes = 5 * 1024 * 1024;

export async function listHistory(path?: string, preferReviews = false): Promise<HistoryListing> {
  let listing = await listDirectories(path);
  if (preferReviews && listing.directories.some(entry => entry.name === '.code-reviews')) {
    listing = await listDirectories(join(listing.path, '.code-reviews'));
  }
  const entries = await readdir(listing.path, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.md$/i.test(entry.name)).map(async entry => {
    try {
      const filePath = join(listing.path, entry.name);
      const info = await lstat(filePath);
      if (!info.isFile()) return undefined;
      return { name: entry.name, path: filePath, size: info.size, modifiedAt: info.mtime.toISOString() };
    } catch { return undefined; } // O arquivo pode ter sido removido durante a listagem.
  }));
  return {
    ...listing,
    files: files.filter((file): file is NonNullable<typeof file> => file !== undefined)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name)),
  };
}

export async function readHistoryFile(directory: string, name: string): Promise<HistoryFile> {
  if (!isAbsolute(directory) || directory.includes('\0') || !name || /[/\\\0]/.test(name) || !/\.md$/i.test(name)) {
    throw new Error('Selecione um arquivo Markdown da pasta atual.');
  }
  const path = join(await realpath(directory), name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Selecione um arquivo Markdown regular.');
    if (info.size > maxHistoryBytes) throw new Error('Este arquivo excede o limite de leitura de 5 MB. Abra-o no seu editor.');
    // Leitura limitada mesmo se a sessão continuar acrescentando saída ao arquivo.
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxHistoryBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxHistoryBytes) throw new Error('Este arquivo excede o limite de leitura de 5 MB. Abra-o no seu editor.');
    return { path, name, size: offset, modifiedAt: info.mtime.toISOString(), content: buffer.toString('utf8', 0, offset) };
  } finally { await handle.close(); }
}
