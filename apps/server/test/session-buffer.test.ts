import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundSessionSummarySchema } from '@development-factory/shared';
import {
  DEFAULT_SESSION_BUFFER_MAX_BYTES,
  SessionOutputBuffer,
  toBackgroundSessionSummary,
  type ManagedSession,
} from '../src/session-buffer.js';

test('SessionOutputBuffer valida maxBytes e usa 256 KB por padrão', () => {
  const defaultBuffer = new SessionOutputBuffer();
  assert.equal(defaultBuffer.maxBytes, DEFAULT_SESSION_BUFFER_MAX_BYTES);
  assert.equal(defaultBuffer.maxBytes, 256 * 1024);
  assert.equal(defaultBuffer.byteLength, 0);
  assert.equal(defaultBuffer.truncated, false);
  assert.equal(defaultBuffer.replay(), '');

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new SessionOutputBuffer(invalid), /maxBytes deve ser um inteiro positivo/);
  }
});

test('SessionOutputBuffer acumula chunks dentro do limite e ignora chunks vazios', () => {
  const buffer = new SessionOutputBuffer(64);
  buffer.append('');
  buffer.append('linha 1\r\n');
  buffer.append('\x1b[32mok\x1b[0m\r\n');

  assert.equal(buffer.truncated, false);
  assert.equal(buffer.replay(), 'linha 1\r\n\x1b[32mok\x1b[0m\r\n');
  assert.equal(buffer.byteLength, Buffer.byteLength(buffer.replay(), 'utf8'));
});

test('SessionOutputBuffer descarta chunks mais antigos ao ultrapassar o teto', () => {
  const buffer = new SessionOutputBuffer(12);
  buffer.append('aaaa');
  buffer.append('bbbb');
  buffer.append('cccc');
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.byteLength, 12);
  assert.equal(buffer.replay(), 'aaaabbbbcccc');

  buffer.append('dddd');
  assert.equal(buffer.truncated, true);
  assert.equal(buffer.byteLength, 12);
  assert.equal(buffer.replay(), 'bbbbccccdddd');

  buffer.append('eeeeee');
  assert.equal(buffer.byteLength, 10);
  assert.equal(buffer.replay(), 'ddddeeeeee');
});

test('SessionOutputBuffer recorta chunk maior que o teto sem quebrar UTF-8', () => {
  const buffer = new SessionOutputBuffer(8);
  // Cada emoji ocupa 4 bytes em UTF-8; 'ab' + '😀😀😀' = 2 + 12 = 14 bytes.
  buffer.append('ab😀😀😀');

  assert.equal(buffer.truncated, true);
  assert.ok(buffer.byteLength <= 8);
  const replayed = buffer.replay();
  assert.equal(replayed.includes('\uFFFD'), false);
  assert.equal(replayed, '😀😀');
  assert.equal(Buffer.byteLength(replayed, 'utf8'), 8);
});

test('SessionOutputBuffer mantém ordem sequencial após compactação interna e limpa com clear()', () => {
  const buffer = new SessionOutputBuffer(20);
  for (let index = 0; index < 150; index += 1) {
    buffer.append(`[${String(index).padStart(3, '0')}]`);
  }

  assert.equal(buffer.truncated, true);
  assert.equal(buffer.byteLength, 20);
  assert.equal(buffer.replay(), '[146][147][148][149]');

  buffer.clear();
  assert.equal(buffer.byteLength, 0);
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.replay(), '');
});

test('toBackgroundSessionSummary gera resumo compatível com BackgroundSessionSummarySchema', () => {
  const session: ManagedSession = {
    sessionId: '00000000-0000-4000-8000-000000000101',
    mode: 'review',
    title: 'PR #42',
    repoPath: '/home/user/repo',
    status: 'running',
    historyState: 'pending',
    reportPath: '/home/user/.local/share/reports/report.md',
    sessionPath: null,
    ptyProcess: undefined,
    subscriptions: [],
    history: undefined,
    activeReviewSession: {
      reviewId: '00000000-0000-4000-8000-000000000102',
      executionId: '00000000-0000-4000-8000-000000000103',
      reportArtifactId: '00000000-0000-4000-8000-000000000104',
      draft: {
        path: '/tmp/draft.md',
        watch() {},
        async publish() { return false; },
        dispose() {},
      },
    },
    activeFactorySession: undefined,
    subscribers: new Set(),
    buffer: new SessionOutputBuffer(),
    startedAt: '2026-11-19T12:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
  };

  const summary = toBackgroundSessionSummary(session);
  const parsed = BackgroundSessionSummarySchema.parse(summary);
  assert.equal(parsed.sessionId, session.sessionId);
  assert.equal(parsed.reviewId, session.activeReviewSession?.reviewId);
  assert.equal(parsed.executionId, session.activeReviewSession?.executionId);
  assert.equal(parsed.finishedAt, null);
});
