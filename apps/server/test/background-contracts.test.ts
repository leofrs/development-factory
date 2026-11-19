import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppEventSchema,
  BackgroundSessionHistoryStateSchema,
  BackgroundSessionModeSchema,
  BackgroundSessionStatusSchema,
  BackgroundSessionSummarySchema,
  type AppEvent,
  type BackgroundSessionSummary,
} from '@development-factory/shared';

const sessionId = '00000000-0000-4000-8000-000000000010';
const reviewId = '00000000-0000-4000-8000-000000000011';
const executionId = '00000000-0000-4000-8000-000000000012';
const startedAt = '2026-11-19T12:00:00.000Z';
const finishedAt = '2026-11-19T12:05:00.000Z';

function createValidSummary(): BackgroundSessionSummary {
  return {
    sessionId,
    mode: 'review',
    title: 'PR #142',
    repoPath: '/home/user/repo',
    status: 'running',
    historyState: 'pending',
    startedAt,
    finishedAt: null,
  };
}

test('valida modos, status e estados de histórico permitidos', () => {
  assert.equal(BackgroundSessionModeSchema.parse('review'), 'review');
  assert.equal(BackgroundSessionModeSchema.parse('factory'), 'factory');
  assert.equal(BackgroundSessionModeSchema.safeParse('other').success, false);

  for (const status of ['running', 'exited', 'failed', 'cancelled'] as const) {
    assert.equal(BackgroundSessionStatusSchema.parse(status), status);
  }
  assert.equal(BackgroundSessionStatusSchema.safeParse('completed').success, false);

  for (const historyState of ['pending', 'saved', 'incomplete'] as const) {
    assert.equal(BackgroundSessionHistoryStateSchema.parse(historyState), historyState);
  }
  assert.equal(BackgroundSessionHistoryStateSchema.safeParse('unknown').success, false);
});

test('BackgroundSessionSummarySchema valida entradas mínimas e completas', () => {
  const minimal = BackgroundSessionSummarySchema.parse(createValidSummary());
  assert.equal(minimal.sessionId, sessionId);
  assert.equal(minimal.finishedAt, null);

  const complete = BackgroundSessionSummarySchema.parse({
    ...createValidSummary(),
    mode: 'factory',
    status: 'exited',
    historyState: 'saved',
    reportPath: '/home/user/repo/.code-reviews/plan.md',
    sessionPath: '/home/user/repo/.code-reviews/session.log',
    reviewId,
    executionId,
    finishedAt,
    exitCode: 0,
    error: null,
  });
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.reviewId, reviewId);
});

test('BackgroundSessionSummarySchema rejeita campos extras e valores inválidos', () => {
  const base = createValidSummary();

  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, extraField: true }).success,
    false,
  );
  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, sessionId: 'not-a-uuid' }).success,
    false,
  );
  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, repoPath: 'relative/path' }).success,
    false,
  );
  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, title: '   ' }).success,
    false,
  );
  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, startedAt: 'invalid-date' }).success,
    false,
  );
  assert.equal(
    BackgroundSessionSummarySchema.safeParse({ ...base, exitCode: 1.5 }).success,
    false,
  );
});

test('AppEventSchema valida todos os eventos de sessão e rejeita payloads inválidos', () => {
  const summary = createValidSummary();
  const eventTypes: AppEvent['type'][] = [
    'session.started',
    'session.updated',
    'session.history_saved',
    'session.finished',
  ];

  for (const type of eventTypes) {
    const parsed = AppEventSchema.parse({ type, session: summary });
    assert.equal(parsed.type, type);
    assert.equal(parsed.session.sessionId, sessionId);
  }

  assert.equal(
    AppEventSchema.safeParse({ type: 'session.unknown', session: summary }).success,
    false,
  );
  assert.equal(
    AppEventSchema.safeParse({ type: 'session.started', session: summary, extra: 'nope' }).success,
    false,
  );
  assert.equal(
    AppEventSchema.safeParse({
      type: 'session.finished',
      session: { ...summary, status: 'invalid' },
    }).success,
    false,
  );
});
