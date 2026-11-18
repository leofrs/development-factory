import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FINAL_REVIEW_STATES, REVIEW_TRANSITIONS, ReviewDomainError, ReviewExecutionSchema,
  ReviewResultSchema, ReviewSchema, ReviewStageSchema, ReviewTargetSchema,
  canTransitionReview, isFinalReviewState, transitionReview,
  type Review, type ReviewState,
} from '@development-factory/shared';

const reviewId = '00000000-0000-4000-8000-000000000001';
const executionId = '00000000-0000-4000-8000-000000000002';
const resultId = '00000000-0000-4000-8000-000000000003';
const createdAt = '2026-11-18T12:00:00.000Z';
const analyzingAt = '2026-11-18T12:00:01.000Z';
const finishedAt = '2026-11-18T12:00:02.000Z';
const error = { contractVersion: 1 as const, code: 'EXECUTION_INTERRUPTED', message: 'A execução foi interrompida', occurredAt: finishedAt, retryable: true };
const result = ReviewResultSchema.parse({
  contractVersion: 1, id: resultId, reviewId, executionId, createdAt: analyzingAt,
  status: 'validated', validatedAt: finishedAt, summary: 'Análise encerrada',
  verdict: 'changes_requested', limitations: [],
});

function preparing(): Review {
  return ReviewSchema.parse({
    contractVersion: 1, id: reviewId,
    target: { contractVersion: 1, type: 'pr', identifier: '123', repoPath: '/tmp/repo' },
    state: 'preparing', createdAt, updatedAt: createdAt, finishedAt: null,
    currentExecutionId: executionId, transitions: [], result: null, error: null,
  });
}

function inState(state: ReviewState): Review {
  const initial = preparing();
  if (state === 'preparing') return initial;
  const analyzing = transitionReview(initial, { to: 'analyzing', at: analyzingAt, reason: 'Ambiente preparado' });
  if (state === 'analyzing') return analyzing;
  return transitionReview(analyzing, { to: state, at: finishedAt, reason: 'Estado de teste', result, error });
}

const expected: Record<ReviewState, readonly ReviewState[]> = {
  preparing: ['analyzing', 'waiting_action', 'incomplete', 'failed', 'cancelled'],
  analyzing: ['waiting_action', 'completed', 'incomplete', 'failed', 'cancelled'],
  waiting_action: ['preparing', 'analyzing', 'incomplete', 'failed', 'cancelled'],
  completed: [], incomplete: [], failed: [], cancelled: [],
};

test('máquina aceita somente as transições legais e mantém estados finais imutáveis', () => {
  assert.deepEqual(REVIEW_TRANSITIONS, expected);
  for (const from of Object.keys(expected) as ReviewState[]) {
    assert.equal(isFinalReviewState(from), FINAL_REVIEW_STATES.includes(from));
    for (const to of Object.keys(expected) as ReviewState[]) {
      const review = inState(from);
      const before = structuredClone(review);
      const command = { to, at: '2026-11-18T12:00:03.000Z', reason: 'Mudança solicitada', result, error };
      const allowed = expected[from].includes(to);
      assert.equal(canTransitionReview(from, to), allowed);
      if (allowed) {
        const updated = transitionReview(review, command);
        assert.equal(updated.state, to);
        assert.equal(updated.finishedAt, isFinalReviewState(to) ? command.at : null);
        assert.deepEqual(updated.transitions.at(-1), { from, to, at: command.at, reason: command.reason });
      } else {
        assert.throws(() => transitionReview(review, command), (caught: unknown) =>
          caught instanceof ReviewDomainError && caught.code === 'REVIEW_INVALID_TRANSITION');
      }
      assert.deepEqual(review, before);
    }
  }
});

test('saída zero ou sinal encerra apenas o processo, sem concluir a revisão', () => {
  const review = inState('analyzing');
  for (const process of [
    { status: 'exited', exitCode: 0, signal: null },
    { status: 'exited', exitCode: null, signal: 'SIGTERM' },
  ]) {
    const execution = ReviewExecutionSchema.parse({
      contractVersion: 1, id: executionId, reviewId, createdAt, updatedAt: finishedAt,
      startedAt: analyzingAt, finishedAt, process,
    });
    assert.equal(execution.process.status, 'exited');
    assert.equal(review.state, 'analyzing');
    assert.throws(() => transitionReview(review, { to: 'completed', at: finishedAt, reason: 'Processo encerrado' }),
      (caught: unknown) => caught instanceof ReviewDomainError && caught.code === 'REVIEW_INVALID_CONTRACT');
  }
  assert.equal(transitionReview(review, { to: 'incomplete', at: finishedAt, reason: 'Sem parecer válido', error }).state, 'incomplete');
});

test('conclusão exige resultado validado vinculado ao review e à execução atual', () => {
  const review = inState('analyzing');
  const partial = { contractVersion: 1 as const, id: resultId, reviewId, executionId,
    createdAt: analyzingAt, status: 'partial' as const, summary: 'Análise parcial', limitations: ['Sem critérios de aceite'] };
  for (const invalid of [partial, { ...result, reviewId: resultId }, { ...result, executionId: resultId }]) {
    assert.throws(() => transitionReview(review, { to: 'completed', at: finishedAt, reason: 'Parecer recebido', result: invalid }));
  }
  const completed = transitionReview(review, { to: 'completed', at: finishedAt, reason: 'Parecer validado', result });
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.result, result);
});

test('contratos recusam versão desconhecida, alvo inválido, dados técnicos incoerentes e histórico adulterado', () => {
  const review = preparing();
  for (const invalid of [
    { ...review, contractVersion: 2 },
    { ...review, id: '' },
    { ...review, state: 'completed' },
    { ...review, updatedAt: finishedAt },
    { ...review, finishedAt },
    { ...review, transitions: [{ from: 'analyzing', to: 'waiting_action', at: createdAt, reason: 'Teste' }] },
  ]) assert.equal(ReviewSchema.safeParse(invalid).success, false);
  for (const target of [
    { ...review.target, identifier: '0' }, { ...review.target, repoPath: 'relativo' },
    { ...review.target, type: 'branch', identifier: 'branch\ncomando' },
  ]) assert.equal(ReviewTargetSchema.safeParse(target).success, false);
  assert.equal(ReviewTargetSchema.safeParse({ ...review.target, type: 'branch', identifier: 'feature/review' }).success, true);
  const execution = { contractVersion: 1, id: executionId, reviewId, createdAt, updatedAt: finishedAt,
    startedAt: analyzingAt, finishedAt, process: { status: 'exited', exitCode: 0, signal: null } };
  for (const invalid of [
    { ...execution, finishedAt: null }, { ...execution, startedAt: null },
    { ...execution, process: { status: 'exited', exitCode: null, signal: null } },
    { ...execution, process: { status: 'running', pid: 42 } },
  ]) assert.equal(ReviewExecutionSchema.safeParse(invalid).success, false);
});

test('motivo, cronologia e diagnóstico de falhas são obrigatórios nas transições', () => {
  const review = inState('analyzing');
  for (const command of [
    { to: 'waiting_action', at: finishedAt, reason: ' ' },
    { to: 'waiting_action', at: createdAt, reason: 'Tempo anterior' },
    { to: 'failed', at: finishedAt, reason: 'Falhou' },
    { to: 'incomplete', at: finishedAt, reason: 'Faltou informação' },
  ] as const) assert.throws(() => transitionReview(review, command));
});

test('etapas representam as cinco fases e exigem motivo quando incompletas', () => {
  const stage = { contractVersion: 1, id: resultId, reviewId, executionId, name: 'task_understanding',
    state: 'pending', createdAt, updatedAt: createdAt, startedAt: null, finishedAt: null, error: null };
  assert.equal(ReviewStageSchema.safeParse(stage).success, true);
  assert.equal(ReviewStageSchema.safeParse({ ...stage, state: 'incomplete', finishedAt: createdAt }).success, false);
  assert.equal(ReviewStageSchema.safeParse({ ...stage, state: 'running', finishedAt: createdAt }).success, false);
});
