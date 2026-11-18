import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CreateReviewResponseSchema,
  ReviewApiErrorResponseSchema,
  ReviewDetailsSchema,
  ReviewListResponseSchema,
  TransitionReviewResponseSchema,
} from '@development-factory/shared';
import { ReviewService, ReviewServiceError } from '../src/review-service.js';
import { createReviewServer } from '../src/server.js';
import { SqliteReviewRepository } from '../src/storage/index.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

test('ReviewService centraliza criação, consulta, transições e idempotência sem depender do WebSocket', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-service-'));
  const repository = SqliteReviewRepository.open({ dbPath: join(sandbox, 'reviews.db') });
  context.after(async () => {
    repository.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const service = new ReviewService(repository);

  const first = await service.createReview(
    { target: { type: 'pr', identifier: '42', repoPath: '/tmp/repo-a' } },
    { idempotencyKey: 'idem-pr-42' },
  );
  assert.equal(first.replayed, false);
  assert.equal(first.review.state, 'preparing');
  assert.equal(first.review.currentExecutionId, first.execution.id);
  assert.equal(first.execution.process.status, 'pending');

  const replayed = await service.createReview(
    { target: { type: 'pr', identifier: '42', repoPath: '/tmp/repo-a' } },
    { idempotencyKey: 'idem-pr-42' },
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.review.id, first.review.id);
  assert.equal(replayed.execution.id, first.execution.id);

  await assert.rejects(
    () =>
      service.createReview(
        { target: { type: 'pr', identifier: '99', repoPath: '/tmp/repo-a' } },
        { idempotencyKey: 'idem-pr-42' },
      ),
    (error: unknown) =>
      error instanceof ReviewServiceError &&
      error.code === 'REVIEW_IDEMPOTENCY_CONFLICT' &&
      error.statusCode === 409,
  );

  // Concorrência com a mesma chave de idempotência cria apenas um review e uma execução
  const concurrent = await Promise.all([
    service.createReview(
      { target: { type: 'branch', identifier: 'feat/login', repoPath: '/tmp/repo-b' }, idempotencyKey: 'idem-concurrent' },
    ),
    service.createReview(
      { target: { type: 'branch', identifier: 'feat/login', repoPath: '/tmp/repo-b' }, idempotencyKey: 'idem-concurrent' },
    ),
  ]);
  assert.equal(concurrent[0].review.id, concurrent[1].review.id);
  assert.equal(concurrent[0].execution.id, concurrent[1].execution.id);
  assert.deepEqual(
    concurrent.map(item => item.replayed).sort(),
    [false, true],
  );

  const transitioned = await service.transitionReview(first.review.id, {
    to: 'analyzing',
    reason: 'Ambiente validado para iniciar análise',
    expectedUpdatedAt: first.review.updatedAt,
  });
  assert.equal(transitioned.state, 'analyzing');

  await assert.rejects(
    () =>
      service.transitionReview(first.review.id, {
        to: 'analyzing',
        reason: 'Tentativa concorrente obsoleta',
        expectedUpdatedAt: first.review.updatedAt,
      }),
    (error: unknown) =>
      error instanceof ReviewServiceError &&
      error.code === 'REVIEW_CONFLICT' &&
      error.statusCode === 409,
  );

  await assert.rejects(
    () =>
      service.transitionReview(first.review.id, {
        to: 'completed',
        reason: 'Sem resultado validado',
      }),
    (error: unknown) =>
      error instanceof ReviewServiceError &&
      error.code === 'REVIEW_INVALID_CONTRACT' &&
      error.statusCode === 400,
  );

  const details = service.getReview(first.review.id);
  assert.equal(details.review.state, 'analyzing');
  assert.equal(details.executions.length, 1);
  assert.equal(details.events.length, 2);

  const list = service.listReviews({ state: 'analyzing', limit: 10 });
  assert.equal(list.reviews.length, 1);
  assert.equal(list.reviews[0]?.id, first.review.id);
});

test('API HTTP de reviews valida origem, Zod, idempotência e persiste entre reinícios sem TUI', async context => {
  const sandbox = await mkdtemp(join(tmpdir(), 'review-api-'));
  const dbPath = join(sandbox, 'reviews.db');
  const boot1 = createReviewServer({ dbPath });
  let activeShutdown: (() => void) | undefined = boot1.shutdown;
  context.after(async () => {
    activeShutdown?.();
    await rm(sandbox, { recursive: true, force: true });
  });

  boot1.server.listen(0, '127.0.0.1');
  await once(boot1.server, 'listening');
  const address1 = boot1.server.address();
  assert(address1 && typeof address1 !== 'string');
  const baseUrl1 = `http://127.0.0.1:${address1.port}`;

  // Proteção de origem e preflight CORS
  const noOriginRes = await fetch(`${baseUrl1}/api/reviews`);
  assert.equal(noOriginRes.status, 403);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await noOriginRes.json()).error.code,
    'ORIGIN_FORBIDDEN',
  );

  const untrustedRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { type: 'pr', identifier: '10', repoPath: '/tmp/repo' } }),
  });
  assert.equal(untrustedRes.status, 403);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await untrustedRes.json()).error.code,
    'ORIGIN_FORBIDDEN',
  );

  const preflightRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, Idempotency-Key',
    },
  });
  assert.equal(preflightRes.status, 204);
  assert.equal(preflightRes.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert(preflightRes.headers.get('Access-Control-Allow-Headers')?.includes('Idempotency-Key'));

  // Validação Zod na criação
  const invalidPayloadRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { type: 'pr', identifier: '0', repoPath: 'relative/path' } }),
  });
  assert.equal(invalidPayloadRes.status, 400);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await invalidPayloadRes.json()).error.code,
    'REVIEW_INVALID_INPUT',
  );

  const invalidJsonRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: '{invalid-json',
  });
  assert.equal(invalidJsonRes.status, 400);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await invalidJsonRes.json()).error.code,
    'REVIEW_INVALID_INPUT',
  );

  const mismatchedKeyRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'key-header',
    },
    body: JSON.stringify({
      target: { type: 'pr', identifier: '10', repoPath: '/tmp/repo' },
      idempotencyKey: 'key-body',
    }),
  });
  assert.equal(mismatchedKeyRes.status, 400);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await mismatchedKeyRes.json()).error.code,
    'REVIEW_INVALID_INPUT',
  );

  // Criação com idempotência e consulta sem TUI
  const createPayload = {
    target: { type: 'pr', identifier: '77', repoPath: '/tmp/my-repo' },
  };
  const createRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'create-pr-77',
    },
    body: JSON.stringify(createPayload),
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  const created = CreateReviewResponseSchema.parse(await createRes.json());
  assert.equal(created.replayed, false);
  assert.equal(created.review.state, 'preparing');

  // Reenvio da mesma solicitação não cria execução duplicada
  const replayRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'create-pr-77',
    },
    body: JSON.stringify(createPayload),
  });
  assert.equal(replayRes.status, 200);
  const replayed = CreateReviewResponseSchema.parse(await replayRes.json());
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.review.id, created.review.id);
  assert.equal(replayed.execution.id, created.execution.id);

  // Conflito ao reutilizar chave com alvo diferente
  const conflictRes = await fetch(`${baseUrl1}/api/reviews`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'create-pr-77',
    },
    body: JSON.stringify({ target: { type: 'pr', identifier: '78', repoPath: '/tmp/my-repo' } }),
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await conflictRes.json()).error.code,
    'REVIEW_IDEMPOTENCY_CONFLICT',
  );

  // Consulta por ID e listagem
  const detailsRes = await fetch(`${baseUrl1}/api/reviews/${created.review.id}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(detailsRes.status, 200);
  const details = ReviewDetailsSchema.parse(await detailsRes.json());
  assert.equal(details.review.id, created.review.id);
  assert.equal(details.executions.length, 1);

  const listRes = await fetch(`${baseUrl1}/api/reviews?state=preparing&limit=5`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(listRes.status, 200);
  const listed = ReviewListResponseSchema.parse(await listRes.json());
  assert.equal(listed.reviews.length, 1);

  const notFoundRes = await fetch(`${baseUrl1}/api/reviews/${randomUUID()}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(notFoundRes.status, 404);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await notFoundRes.json()).error.code,
    'REVIEW_NOT_FOUND',
  );

  const badIdRes = await fetch(`${baseUrl1}/api/reviews/not-a-uuid`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(badIdRes.status, 400);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await badIdRes.json()).error.code,
    'REVIEW_INVALID_INPUT',
  );

  // Transição via API e rejeição de transição inválida
  const transitionRes = await fetch(`${baseUrl1}/api/reviews/${created.review.id}/transitions`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'cancelled', reason: 'Cancelado pelo usuário' }),
  });
  assert.equal(transitionRes.status, 200);
  const transitioned = TransitionReviewResponseSchema.parse(await transitionRes.json());
  assert.equal(transitioned.review.state, 'cancelled');

  const invalidTransitionRes = await fetch(`${baseUrl1}/api/reviews/${created.review.id}/transitions`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'analyzing', reason: 'Tentativa após cancelamento' }),
  });
  assert.equal(invalidTransitionRes.status, 409);
  assert.equal(
    ReviewApiErrorResponseSchema.parse(await invalidTransitionRes.json()).error.code,
    'REVIEW_INVALID_TRANSITION',
  );

  // Reinício do servidor preserva idempotência e estado
  boot1.shutdown();
  activeShutdown = undefined;

  const boot2 = createReviewServer({ dbPath });
  activeShutdown = boot2.shutdown;
  boot2.server.listen(0, '127.0.0.1');
  await once(boot2.server, 'listening');
  const address2 = boot2.server.address();
  assert(address2 && typeof address2 !== 'string');
  const baseUrl2 = `http://127.0.0.1:${address2.port}`;

  const replayAfterRestart = await fetch(`${baseUrl2}/api/reviews`, {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'create-pr-77',
    },
    body: JSON.stringify(createPayload),
  });
  assert.equal(replayAfterRestart.status, 200);
  const replayedAfterRestart = CreateReviewResponseSchema.parse(await replayAfterRestart.json());
  assert.equal(replayedAfterRestart.replayed, true);
  assert.equal(replayedAfterRestart.review.id, created.review.id);
  assert.equal(replayedAfterRestart.review.state, 'cancelled');
});
