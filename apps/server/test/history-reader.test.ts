import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HistoryFileSchema, HistoryListingSchema } from '@development-factory/shared';
import { listHistory, maxHistoryBytes, readHistoryFile } from '../src/history-reader.js';

test('histórico abre .code-reviews e lista Markdown por data sem arquivos externos', async context => {
  const repo = await mkdtemp(join(tmpdir(), 'review-reader-'));
  context.after(() => rm(repo, { recursive: true, force: true }));
  const directory = join(repo, '.code-reviews');
  await mkdir(directory);
  await mkdir(join(directory, 'subpasta'));
  await writeFile(join(directory, 'antigo.md'), '# Antigo');
  await utimes(join(directory, 'antigo.md'), new Date('2020-01-01'), new Date('2020-01-01'));
  await writeFile(join(directory, 'novo.session.md'), '# Registro');
  await writeFile(join(directory, 'parecer.MD'), '# Parecer');
  await writeFile(join(directory, 'ignorar.txt'), 'texto');
  await writeFile(join(repo, 'fora.md'), 'fora');
  await symlink(join(repo, 'fora.md'), join(directory, 'link.md'));
  const listing = HistoryListingSchema.parse(await listHistory(repo, true));
  assert.equal(listing.path, directory);
  assert(listing.directories.some(entry => entry.name === 'subpasta'));
  assert.deepEqual(listing.files.map(file => file.name).sort(), ['antigo.md', 'novo.session.md', 'parecer.MD']);
  assert.equal(listing.files.at(-1)?.name, 'antigo.md');
  assert.equal((await listHistory(repo)).path, repo);
  assert.equal((await listHistory(join(directory, 'subpasta'), true)).files.length, 0);
});

test('leitura preserva UTF-8 e Markdown incluindo HTML como texto', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'review-reader-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const content = '# Revisão\n\n**AJUSTES NECESSÁRIOS**\n\n<script>alert("texto")</script>\n';
  await writeFile(join(directory, 'PR 123.md'), content);
  const file = HistoryFileSchema.parse(await readHistoryFile(directory, 'PR 123.md'));
  assert.equal(file.content, content);
  assert.equal(file.path, join(directory, 'PR 123.md'));
  assert.equal(file.size, Buffer.byteLength(content));
  await writeFile(join(directory, 'vazio.md'), '');
  assert.equal((await readHistoryFile(directory, 'vazio.md')).content, '');
});

test('recusa travessia, links, diretórios e arquivos fora dos limites de leitura', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'review-reader-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'arquivo.txt'), 'texto');
  await mkdir(join(directory, 'pasta.md'));
  await symlink(join(directory, 'arquivo.txt'), join(directory, 'link.md'));
  for (const name of ['../fora.md', '/tmp/fora.md', '..\\fora.md', 'arquivo.txt', 'invalid\0.md', 'pasta.md', 'link.md']) {
    await assert.rejects(readHistoryFile(directory, name));
  }
  await assert.rejects(readHistoryFile('relative', 'review.md'));
  const handle = await open(join(directory, 'grande.md'), 'w');
  await handle.truncate(maxHistoryBytes + 1);
  await handle.close();
  await assert.rejects(readHistoryFile(directory, 'grande.md'), /5 MB/);
});
