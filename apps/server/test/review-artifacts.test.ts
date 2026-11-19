import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  REVIEW_CONTRACT_VERSION,
  ReviewArtifactListResponseSchema,
  ReviewArtifactSchema,
  ReviewDetailsSchema,
} from '@development-factory/shared';
import { defaultReviewReportDirectory } from '../src/artifacts.js';
import { listHistory, readHistoryFile } from '../src/history-reader.js';
import { ReviewService, ReviewServiceError } from '../src/review-service.js';
import { createReviewServer } from '../src/server.js';
import { SqliteReviewRepository } from '../src/storage/index.js';

const TEST_ORIGIN = 'http://localhost:5173';

function createTempPaths(prefix: string): {
  rootDir: string;
  repoDir: string;
  dbPath: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const repoDir = join(rootDir, 'repo');
  mkdirSync(repoDir);
  return {
    rootDir,
    repoDir,
    dbPath: join(rootDir, 'reviews.db'),
  };
}

test('contrato de artefato exige formato compatível e motivo quando falho ou incompleto', () => {
  const base = {
    contractVersion: REVIEW_CONTRACT_VERSION,
    id: randomUUID(),
    reviewId: randomUUID(),
    executionId: randomUUID(),
    kind: 'structured_result' as const,
    format: 'json' as const,
    path: '/tmp/repo/.code-reviews/review.result.json',
    version: 1,
    status: 'pending' as const,
    createdAt: '2026-11-18T12:00:00.000Z',
    updatedAt: '2026-11-18T12:00:00.000Z',
    error: null,
  };

  assert.equal(ReviewArtifactSchema.safeParse(base).success, true);

  assert.equal(
    ReviewArtifactSchema.safeParse({ ...base, format: 'markdown' }).success,
    false,
  );
  assert.equal(
    ReviewArtifactSchema.safeParse({ ...base, status: 'failed', error: null }).success,
    false,
  );
  assert.equal(
    ReviewArtifactSchema.safeParse({ ...base, status: 'incomplete', error: null }).success,
    false,
  );
  assert.equal(
    ReviewArtifactSchema.safeParse({
      ...base,
      updatedAt: '2026-11-18T11:59:59.000Z',
    }).success,
    false,
  );
});

test('prepara apenas a referência do parecer e reutiliza o registro em chamadas repetidas', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-ok-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);
  const created = await service.createReview({
    target: { type: 'pr', identifier: '42', repoPath: repoDir },
  });

  const [first, second] = await Promise.all([
    service.prepareExecutionArtifacts(created.review.id, { reportDirectory: rootDir }),
    service.prepareExecutionArtifacts(created.review.id, { reportDirectory: rootDir }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.artifacts.length, 1);
  const report = first.artifacts[0];
  assert.ok(report);
  assert.equal(report.kind, 'report');
  assert.equal(report.reviewId, created.review.id);
  assert.equal(report.executionId, created.execution.id);
  assert.equal(report.version, 1);
  assert.equal(report.status, 'pending');
  assert.match(report.path, /-pr-42-.*\.md$/);
  assert.equal(existsSync(report.path), false);
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(ReviewDetailsSchema.parse(service.getReview(created.review.id)).artifacts.length, 1);
});

test('recusa pasta interna, link para o repositório e destino inexistente antes de preparar o parecer', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-invalid-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const link = join(rootDir, 'link');
  symlinkSync(repoDir, link);

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);
  const created = await service.createReview({
    target: { type: 'pr', identifier: '99', repoPath: repoDir },
  });

  for (const reportDirectory of [repoDir, link, join(rootDir, 'inexistente')]) {
    await assert.rejects(
      () => service.prepareExecutionArtifacts(created.review.id, { reportDirectory }),
      error => error instanceof ReviewServiceError && error.code === 'REVIEW_ARTIFACT_FAILED' && error.statusCode === 400,
    );
  }
  assert.deepEqual(service.getReview(created.review.id).artifacts, []);
});

test('cria a pasta padrão em XDG_DATA_HOME somente se o destino estiver fora do repositório', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-default-');
  const previous = process.env.XDG_DATA_HOME;
  context.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);
  const created = await service.createReview({
    target: { type: 'branch', identifier: 'feat/default', repoPath: repoDir },
  });

  process.env.XDG_DATA_HOME = join(repoDir, 'dados');
  await assert.rejects(() => service.prepareExecutionArtifacts(created.review.id), /fora do repositório/);
  assert.equal(existsSync(defaultReviewReportDirectory()), false);

  process.env.XDG_DATA_HOME = join(rootDir, 'dados');
  const expected = join(rootDir, 'dados', 'development-factory', 'reviews');
  assert.equal(defaultReviewReportDirectory(), expected);
  const prepared = await service.prepareExecutionArtifacts(created.review.id);
  assert.equal(existsSync(expected), true);
  assert.ok(prepared.artifacts[0]?.path.startsWith(`${expected}/`));
});

test('históricos Markdown anteriores continuam legíveis junto com artefatos novos', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-legacy-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const reviewsDir = join(repoDir, '.code-reviews');
  mkdirSync(reviewsDir);
  const legacyContent = '# Code review antigo\n\n- Alvo: "PR #1"\n\nParecer legado.\n';
  writeFileSync(join(reviewsDir, '2026-01-01T00-00-00-000Z-pr-1.md'), legacyContent);

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);

  const created = await service.createReview({
    target: { type: 'pr', identifier: '2', repoPath: repoDir },
  });
  await service.prepareExecutionArtifacts(created.review.id, { reportDirectory: rootDir });

  const listing = await listHistory(repoDir, true);
  assert.equal(listing.files.some(file => file.name === '2026-01-01T00-00-00-000Z-pr-1.md'), true);
  assert.equal(listing.files.some(file => file.name.endsWith('.result.json')), false);

  const legacyRead = await readHistoryFile(reviewsDir, '2026-01-01T00-00-00-000Z-pr-1.md');
  assert.equal(legacyRead.content, legacyContent);
});

test('API HTTP registra, prepara e lista artefatos associados ao review e à execução', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-api-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { server, reviewRepository } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    reviewRepository.close();
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const createRes = await fetch(`${baseUrl}/api/reviews`, {
    method: 'POST',
    headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { type: 'pr', identifier: '77', repoPath: repoDir } }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as {
    review: { id: string };
    execution: { id: string };
  };

  const prepareRes = await fetch(`${baseUrl}/api/reviews/${created.review.id}/artifacts/prepare`, {
    method: 'POST',
    headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportDirectory: rootDir }),
  });
  assert.equal(prepareRes.status, 201);

  const registerRes = await fetch(`${baseUrl}/api/reviews/${created.review.id}/artifacts`, {
    method: 'POST',
    headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executionId: created.execution.id,
      kind: 'report',
      path: join(repoDir, '.code-reviews', 'custom-v2.md'),
      status: 'ready',
    }),
  });
  assert.equal(registerRes.status, 201);
  const registered = (await registerRes.json()) as { artifact: { version: number; status: string } };
  assert.equal(registered.artifact.version, 2);
  assert.equal(registered.artifact.status, 'ready');

  const listRes = await fetch(`${baseUrl}/api/reviews/${created.review.id}/artifacts`, {
    headers: { Origin: TEST_ORIGIN },
  });
  assert.equal(listRes.status, 200);
  const listed = ReviewArtifactListResponseSchema.parse(await listRes.json());
  assert.equal(listed.artifacts.length, 2);
});
