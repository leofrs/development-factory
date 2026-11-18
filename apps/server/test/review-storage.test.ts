import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  REVIEW_CONTRACT_VERSION,
  ReviewDomainError,
  ReviewExecutionSchema,
  ReviewResultSchema,
  ReviewSchema,
  type Review,
  type ReviewExecution,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';
import {
  REVIEW_MIGRATIONS,
  ReviewStorageError,
  SqliteReviewRepository,
  resolveReviewDbPath,
  type Migration,
} from '../src/storage/index.js';

function makeReview(overrides: Partial<Review> = {}): Review {
  const id = overrides.id ?? randomUUID();
  const createdAt = overrides.createdAt ?? '2026-11-18T12:00:00.000Z';
  return ReviewSchema.parse({
    contractVersion: REVIEW_CONTRACT_VERSION,
    id,
    target: {
      contractVersion: REVIEW_CONTRACT_VERSION,
      type: 'pr',
      identifier: '42',
      repoPath: '/tmp/analyzed-repo',
    },
    state: 'preparing',
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    currentExecutionId: null,
    transitions: [],
    result: null,
    error: null,
    ...overrides,
  });
}

function makeExecution(reviewId: string, overrides: Partial<ReviewExecution> = {}): ReviewExecution {
  const createdAt = overrides.createdAt ?? '2026-11-18T12:00:00.000Z';
  return ReviewExecutionSchema.parse({
    contractVersion: REVIEW_CONTRACT_VERSION,
    id: overrides.id ?? randomUUID(),
    reviewId,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    process: { status: 'pending' },
    ...overrides,
  });
}

test('resolveReviewDbPath define localização padrão fora do código analisado e valida entradas', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-db-config-'));
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevDb = process.env.REVIEW_DB_PATH;
  context.after(async () => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevDb === undefined) delete process.env.REVIEW_DB_PATH;
    else process.env.REVIEW_DB_PATH = prevDb;
    await rm(sandbox, { recursive: true, force: true });
  });

  delete process.env.REVIEW_DB_PATH;
  process.env.XDG_DATA_HOME = join(sandbox, 'xdg-data');
  const defaultPath = resolveReviewDbPath();
  assert.equal(defaultPath, join(sandbox, 'xdg-data', 'development-factory', 'reviews.db'));
  assert.equal(existsSync(join(sandbox, 'xdg-data', 'development-factory')), true);

  assert.throws(
    () => resolveReviewDbPath('relative/reviews.db'),
    (error: unknown) => error instanceof ReviewStorageError && error.code === 'STORAGE_CONFIGURATION_ERROR',
  );
});

test('reiniciar o servidor preserva reviews, execuções, transições e eventos', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-db-restart-'));
  const dbPath = join(sandbox, 'reviews.db');
  context.after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  const reviewId = randomUUID();
  const executionId = randomUUID();
  const resultId = randomUUID();
  const createdAt = '2026-11-18T12:00:00.000Z';
  const analyzingAt = '2026-11-18T12:00:01.000Z';
  const finishedAt = '2026-11-18T12:00:05.000Z';

  const firstBoot = createReviewServer({ dbPath });
  try {
    const review = makeReview({ id: reviewId, createdAt, updatedAt: createdAt, currentExecutionId: executionId });
    const execution = makeExecution(reviewId, { id: executionId, createdAt });
    firstBoot.reviewRepository.createReview(review, { execution });
    firstBoot.reviewRepository.saveReviewTransition(reviewId, {
      to: 'analyzing',
      at: analyzingAt,
      reason: 'Ambiente validado',
    });
    firstBoot.reviewRepository.updateExecution(
      ReviewExecutionSchema.parse({
        ...execution,
        updatedAt: finishedAt,
        startedAt: analyzingAt,
        finishedAt,
        process: { status: 'exited', exitCode: 0, signal: null },
      }),
      { type: 'execution.exited', occurredAt: finishedAt, payload: { exitCode: 0 } },
    );
    const validatedResult = ReviewResultSchema.parse({
      contractVersion: REVIEW_CONTRACT_VERSION,
      id: resultId,
      reviewId,
      executionId,
      createdAt: analyzingAt,
      status: 'validated',
      validatedAt: finishedAt,
      summary: 'Revisão concluída sem bloqueios',
      verdict: 'approved',
      limitations: [],
    });
    firstBoot.reviewRepository.saveReviewTransition(reviewId, {
      to: 'completed',
      at: finishedAt,
      reason: 'Parecer validado',
      result: validatedResult,
    });
  } finally {
    firstBoot.shutdown();
  }

  const secondBoot = createReviewServer({ dbPath });
  try {
    const persisted = secondBoot.reviewRepository.getReviewById(reviewId);
    assert(persisted);
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.result?.id, resultId);
    assert.equal(persisted.transitions.length, 2);

    const executions = secondBoot.reviewRepository.listExecutionsByReviewId(reviewId);
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.process.status, 'exited');

    const events = secondBoot.reviewRepository.listEventsByReviewId(reviewId);
    assert.deepEqual(
      events.map(event => [event.sequence, event.type]),
      [
        [1, 'review.created'],
        [2, 'review.transitioned'],
        [3, 'execution.exited'],
        [4, 'review.transitioned'],
      ],
    );
    assert.equal(secondBoot.reviewRepository.getAppliedMigrations().length, REVIEW_MIGRATIONS.length);
  } finally {
    secondBoot.shutdown();
  }
});

test('escritas concorrentes no mesmo processo e entre conexões não corrompem estados nem sequências', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-db-concurrency-'));
  const dbPath = join(sandbox, 'reviews.db');
  const repoA = SqliteReviewRepository.open({ dbPath });
  const repoB = SqliteReviewRepository.open({ dbPath });
  context.after(async () => {
    repoA.close();
    repoB.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const review = makeReview();
  repoA.createReview(review);

  // Escritas concorrentes no mesmo processo usando withWriteLock
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repoA.withWriteLock(() =>
        repoA.appendEvent({
          contractVersion: REVIEW_CONTRACT_VERSION,
          id: randomUUID(),
          reviewId: review.id,
          executionId: null,
          type: 'analysis.progress',
          occurredAt: '2026-11-18T12:00:01.000Z',
          payload: { step: index + 1 },
        }),
      ),
    ),
  );

  // Disputa de transição entre duas conexões independentes com trava otimista
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() =>
      repoA.saveReviewTransition(
        review.id,
        { to: 'analyzing', at: '2026-11-18T12:00:02.000Z', reason: 'Conexão A' },
        { expectedUpdatedAt: review.updatedAt },
      ),
    ),
    Promise.resolve().then(() =>
      repoB.saveReviewTransition(
        review.id,
        { to: 'analyzing', at: '2026-11-18T12:00:03.000Z', reason: 'Conexão B' },
        { expectedUpdatedAt: review.updatedAt },
      ),
    ),
  ]);

  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const [rejectedOutcome] = rejected;
  assert(rejectedOutcome);
  assert(rejectedOutcome.reason instanceof ReviewStorageError);
  assert.equal(rejectedOutcome.reason.code, 'STORAGE_CONFLICT');

  const current = repoB.getReviewById(review.id);
  assert(current);
  assert.equal(current.state, 'analyzing');
  assert.equal(current.transitions.length, 1);

  const events = repoB.listEventsByReviewId(review.id);
  assert.equal(events.length, 14);
  assert.deepEqual(
    events.map(event => event.sequence),
    Array.from({ length: 14 }, (_, index) => index + 1),
  );

  // Transição ilegal recusada sem corromper o registro
  assert.throws(
    () => repoA.saveReviewTransition(review.id, { to: 'preparing', at: '2026-11-18T12:00:04.000Z', reason: 'Volta inválida' }),
    (error: unknown) => error instanceof ReviewDomainError && error.code === 'REVIEW_INVALID_TRANSITION',
  );
  assert.equal(repoA.getReviewById(review.id)?.state, 'analyzing');
});

test('falha na migration impede início do servidor com diagnóstico claro e sem apagar dados', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-db-migration-fail-'));
  const dbPath = join(sandbox, 'reviews.db');
  context.after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  const review = makeReview();
  const initial = createReviewServer({ dbPath });
  initial.reviewRepository.createReview(review);
  initial.shutdown();

  const nextVersion = REVIEW_MIGRATIONS.length + 1;
  const brokenMigration: Migration = {
    version: nextVersion,
    name: 'broken_migration_step',
    up(db) {
      db.exec('CREATE TABLE temp_before_failure (id TEXT PRIMARY KEY) STRICT;');
      db.exec('INSERT INTO non_existent_table VALUES (1);');
    },
  };

  assert.throws(
    () => createReviewServer({ dbPath, migrations: [...REVIEW_MIGRATIONS, brokenMigration] }),
    (error: unknown) =>
      error instanceof ReviewStorageError &&
      error.code === 'STORAGE_MIGRATION_FAILED' &&
      error.message.includes(`v${nextVersion}`) &&
      error.message.includes('broken_migration_step'),
  );

  // Dados anteriores preservados e tabela parcial da migration com falha revertida
  const recovered = SqliteReviewRepository.open({ dbPath });
  try {
    const persisted = recovered.getReviewById(review.id);
    assert.deepEqual(persisted, review);
    assert.equal(recovered.getAppliedMigrations().length, REVIEW_MIGRATIONS.length);
  } finally {
    recovered.close();
  }
});
