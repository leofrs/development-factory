import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DirectoryListingSchema } from '@development-factory/shared';
import { listDirectories } from '../src/directories.js';

test('lista pastas, caminhos com espaços e links navegáveis sem incluir arquivos', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'review-picker-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'meu projeto'));
  await mkdir(join(directory, '.pasta-oculta'));
  await writeFile(join(directory, 'arquivo.txt'), 'arquivo');
  await symlink(join(directory, 'meu projeto'), join(directory, 'link-pasta'));
  await symlink(join(directory, 'arquivo.txt'), join(directory, 'link-arquivo'));
  await symlink(join(directory, 'inexistente'), join(directory, 'link-quebrado'));
  const listing = DirectoryListingSchema.parse(await listDirectories(directory));
  assert.equal(listing.path, directory);
  assert.equal(listing.parentPath, dirname(directory));
  assert.deepEqual(listing.directories.map(entry => entry.name).sort(), ['.pasta-oculta', 'link-pasta', 'meu projeto']);
  const linked = await listDirectories(join(directory, 'link-pasta'));
  assert.equal(linked.path, join(directory, 'meu projeto'));
  assert.deepEqual(linked.directories, []);
});

test('raiz não tem pai e caminhos relativos ou inexistentes são recusados', async () => {
  assert.equal((await listDirectories('/')).parentPath, null);
  await assert.rejects(listDirectories('../repo'), /caminho absoluto/);
  await assert.rejects(listDirectories('/tmp/\0invalid'), /caminho absoluto/);
  await assert.rejects(listDirectories('/tmp/development-factory-inexistente/nested'));
});
