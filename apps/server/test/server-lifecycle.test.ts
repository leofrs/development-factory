import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReviewServer } from '../src/server.js';
import { SqliteReviewRepository } from '../src/storage/index.js';

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição no teste de ciclo de vida.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

test('createReviewServer expõe sessionManager e shutdown encerra PTYs ativos antes do repositório', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-server-lifecycle-'));
  const binDir = join(rootDir, 'bin');
  const repoDir = join(rootDir, 'repo');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoDir);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;

  const { sessionManager, shutdown } = createReviewServer({ dbPath });

  try {
    const reviewSession = await sessionManager.startReviewSession({
      targetType: 'pr',
      identifier: '300',
      repoPath: repoDir,
      cols: 80,
      rows: 24,
    });
    const factorySession = await sessionManager.startFactorySession({
      inputType: 'title',
      value: 'Teste de shutdown limpo',
      repoPath: repoDir,
      cols: 80,
      rows: 24,
    });

    await waitFor(
      () =>
        reviewSession.buffer.replay().includes('READY:') &&
        factorySession.buffer.replay().includes('READY:'),
    );

    await shutdown();
    // Segunda chamada deve ser idempotente.
    await shutdown();

    assert.equal(reviewSession.status, 'cancelled');
    assert.equal(reviewSession.ptyProcess, undefined);
    assert.equal(factorySession.status, 'cancelled');
    assert.equal(factorySession.ptyProcess, undefined);

    const reviewId = reviewSession.activeReviewSession?.reviewId;
    assert.ok(reviewId);

    const reopenedRepo = SqliteReviewRepository.open({ dbPath });
    try {
      const persisted = reopenedRepo.getReviewById(reviewId);
      assert.ok(persisted);
      assert.equal(persisted.state, 'cancelled');
    } finally {
      reopenedRepo.close();
    }
  } finally {
    await shutdown();
    process.env.PATH = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
