import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { ArtifactPreparationError, type ReviewArtifactFileWriter } from '../src/artifacts.js';
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

test('prepara parecer, resultado estruturado e registro de sessão vinculados ao review e execução', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-ok-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);

  const created = await service.createReview({
    target: { type: 'pr', identifier: '42', repoPath: repoDir },
  });

  const prepared = await service.prepareExecutionArtifacts(created.review.id);
  assert.equal(prepared.artifacts.length, 3);

  const kinds = prepared.artifacts.map(item => item.kind).sort();
  assert.deepEqual(kinds, ['report', 'session_log', 'structured_result']);

  for (const artifact of prepared.artifacts) {
    assert.equal(artifact.reviewId, created.review.id);
    assert.equal(artifact.executionId, created.execution.id);
    assert.equal(artifact.version, 1);
    assert.equal(artifact.status, 'pending');
    assert.equal(artifact.error, null);
  }

  const report = prepared.artifacts.find(item => item.kind === 'report');
  const session = prepared.artifacts.find(item => item.kind === 'session_log');
  const structured = prepared.artifacts.find(item => item.kind === 'structured_result');
  assert.ok(report && session && structured);

  const reportContent = readFileSync(report.path, 'utf8');
  assert.match(reportContent, new RegExp(`Review ID: ${created.review.id}`));
  assert.match(reportContent, new RegExp(`Execução ID: ${created.execution.id}`));
  assert.match(reportContent, /# Code review/);

  const sessionContent = readFileSync(session.path, 'utf8');
  assert.match(sessionContent, new RegExp(`Review ID: ${created.review.id}`));
  assert.match(sessionContent, /# Registro da sessão de code review/);

  const structuredContent = JSON.parse(readFileSync(structured.path, 'utf8')) as Record<string, unknown>;
  assert.equal(structuredContent.reviewId, created.review.id);
  assert.equal(structuredContent.executionId, created.execution.id);
  assert.equal(structuredContent.status, 'pending');

  const details = ReviewDetailsSchema.parse(service.getReview(created.review.id));
  assert.equal(details.artifacts.length, 3);
});

test('falha parcial na criação de artefatos registra motivo e impede review aparentemente ativo', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-partial-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());

  const failingWriter: ReviewArtifactFileWriter = {
    prepareExecutionFiles(review, execution) {
      const base = join(review.target.repoPath, '.code-reviews', execution.id);
      throw new ArtifactPreparationError(
        'Falha simulada ao criar o registro da sessão.',
        [
          { kind: 'report', format: 'markdown', path: `${base}.md` },
          { kind: 'session_log', format: 'markdown', path: `${base}.session.md` },
          { kind: 'structured_result', format: 'json', path: `${base}.result.json` },
        ],
        new Set(['report']),
        'session_log',
      );
    },
  };

  const service = new ReviewService(repo, { artifactWriter: failingWriter });
  const created = await service.createReview({
    target: { type: 'branch', identifier: 'feat/artifacts', repoPath: repoDir },
  });

  await assert.rejects(
    () => service.prepareExecutionArtifacts(created.review.id),
    error => error instanceof ReviewServiceError && error.code === 'REVIEW_ARTIFACT_FAILED',
  );

  const details = service.getReview(created.review.id);
  assert.equal(details.review.state, 'failed');
  assert.ok(details.review.finishedAt !== null);
  assert.equal(details.review.error?.code, 'ARTIFACT_CREATION_FAILED');
  assert.match(details.review.error?.message ?? '', /sessão/);

  assert.equal(details.artifacts.length, 3);
  const report = details.artifacts.find(item => item.kind === 'report');
  const session = details.artifacts.find(item => item.kind === 'session_log');
  const structured = details.artifacts.find(item => item.kind === 'structured_result');
  assert.equal(report?.status, 'incomplete');
  assert.equal(report?.error?.code, 'ARTIFACT_CREATION_FAILED');
  assert.equal(session?.status, 'failed');
  assert.equal(session?.error?.code, 'ARTIFACT_CREATION_FAILED');
  assert.equal(structured?.status, 'failed');
  assert.equal(structured?.error?.code, 'ARTIFACT_CREATION_FAILED');

  assert.ok(details.events.some(event => event.type === 'review_artifact_creation_failed'));
});

test('diretório .code-reviews inválido falha preparação e marca review como failed', async context => {
  const { rootDir, repoDir, dbPath } = createTempPaths('review-artifacts-symlink-');
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const externalDir = join(rootDir, 'external');
  mkdirSync(externalDir);
  symlinkSync(externalDir, join(repoDir, '.code-reviews'));

  const repo = SqliteReviewRepository.open({ dbPath });
  context.after(() => repo.close());
  const service = new ReviewService(repo);

  const created = await service.createReview({
    target: { type: 'pr', identifier: '99', repoPath: repoDir },
  });

  await assert.rejects(
    () => service.prepareExecutionArtifacts(created.review.id),
    error => error instanceof ReviewServiceError && error.code === 'REVIEW_ARTIFACT_FAILED',
  );

  const details = service.getReview(created.review.id);
  assert.equal(details.review.state, 'failed');
  assert.equal(details.review.error?.code, 'ARTIFACT_CREATION_FAILED');
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
  await service.prepareExecutionArtifacts(created.review.id);

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
    body: JSON.stringify({}),
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
  assert.equal(listed.artifacts.length, 4);
});
