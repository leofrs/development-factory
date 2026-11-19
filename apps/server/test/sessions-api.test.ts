import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BackgroundSessionSummarySchema,
  type BackgroundSessionSummary,
} from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Tempo limite excedido aguardando condição no teste de API de sessões.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }
}

test('API REST /api/sessions valida origem, lista sessões por ordem recente, detalha e encerra sessões', async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-sessions-api-'));
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

  const { server, sessionManager, shutdown } = createReviewServer({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await shutdown();
    process.env.PATH = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Origem ausente ou não permitida deve ser recusada com 403.
  const noOriginRes = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(noOriginRes.status, 403);
  assert.equal(noOriginRes.headers.get('cache-control'), 'no-store');
  const noOriginBody = (await noOriginRes.json()) as { error: { code: string; message: string } };
  assert.equal(noOriginBody.error.code, 'ORIGIN_FORBIDDEN');

  const badOriginRes = await fetch(`${baseUrl}/api/sessions`, {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(badOriginRes.status, 403);

  // Preflight CORS OPTIONS permitido.
  const optionsRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'OPTIONS',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(optionsRes.headers.get('cache-control'), 'no-store');

  // Lista inicialmente vazia.
  const emptyListRes = await fetch(`${baseUrl}/api/sessions`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(emptyListRes.status, 200);
  assert.equal(emptyListRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(emptyListRes.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await emptyListRes.json(), { sessions: [] });

  // Cria duas sessões em momentos distintos para validar ordenação da mais recente para a mais antiga.
  const olderSession = await sessionManager.startReviewSession({
    targetType: 'pr',
    identifier: '401',
    repoPath: repoDir,
    reportDirectory: rootDir,
    cols: 80,
    rows: 24,
  });
  await new Promise(resolve => {
    setTimeout(resolve, 25);
  });
  const newerSession = await sessionManager.startFactorySession({
    inputType: 'title',
    value: 'Sessão mais recente',
    repoPath: repoDir,
    cols: 80,
    rows: 24,
  });

  await waitFor(
    () =>
      olderSession.buffer.replay().includes('READY:') &&
      newerSession.buffer.replay().includes('READY:'),
  );

  // GET /api/sessions retorna ordenação decrescente e payloads validados.
  const listRes = await fetch(`${baseUrl}/api/sessions`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { sessions: BackgroundSessionSummary[] };
  assert.equal(listBody.sessions.length, 2);
  const validatedList = BackgroundSessionSummarySchema.array().parse(listBody.sessions);
  assert.equal(validatedList[0]?.sessionId, newerSession.sessionId);
  assert.equal(validatedList[1]?.sessionId, olderSession.sessionId);

  // GET /api/sessions/:id retorna detalhes da sessão existente.
  const detailRes = await fetch(`${baseUrl}/api/sessions/${olderSession.sessionId}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(detailRes.headers.get('cache-control'), 'no-store');
  const detailBody = (await detailRes.json()) as { session: BackgroundSessionSummary };
  const validatedDetail = BackgroundSessionSummarySchema.parse(detailBody.session);
  assert.equal(validatedDetail.sessionId, olderSession.sessionId);
  assert.equal(validatedDetail.mode, 'review');
  assert.equal(validatedDetail.status, 'running');

  // GET /api/sessions/:id inexistente retorna 404.
  const missingId = randomUUID();
  const missingDetailRes = await fetch(`${baseUrl}/api/sessions/${missingId}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(missingDetailRes.status, 404);
  const missingDetailBody = (await missingDetailRes.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(missingDetailBody.error.code, 'SESSION_NOT_FOUND');

  // POST /api/sessions/:id/stop inexistente retorna 404.
  const missingStopRes = await fetch(`${baseUrl}/api/sessions/${missingId}/stop`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(missingStopRes.status, 404);
  const missingStopBody = (await missingStopRes.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(missingStopBody.error.code, 'SESSION_NOT_FOUND');

  // POST /api/sessions/:id/stop encerra sessão ativa e retorna resumo atualizado.
  const stopRes = await fetch(`${baseUrl}/api/sessions/${olderSession.sessionId}/stop`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(stopRes.status, 200);
  assert.equal(stopRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(stopRes.headers.get('cache-control'), 'no-store');
  const stopBody = (await stopRes.json()) as { session: BackgroundSessionSummary };
  const validatedStopped = BackgroundSessionSummarySchema.parse(stopBody.session);
  assert.equal(validatedStopped.sessionId, olderSession.sessionId);
  assert.equal(validatedStopped.status, 'cancelled');
  assert.notEqual(validatedStopped.finishedAt, null);
  assert.equal(olderSession.ptyProcess, undefined);

  // Encerrar a outra sessão também via REST para garantir limpeza explícita.
  const stopNewerRes = await fetch(`${baseUrl}/api/sessions/${newerSession.sessionId}/stop`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(stopNewerRes.status, 200);
  const stopNewerBody = (await stopNewerRes.json()) as { session: BackgroundSessionSummary };
  assert.equal(stopNewerBody.session.status, 'cancelled');

  // Parâmetro com encoding inválido retorna 400 e rota desconhecida retorna 404.
  const invalidParamRes = await fetch(`${baseUrl}/api/sessions/%ZZ`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(invalidParamRes.status, 400);

  const unknownSubrouteRes = await fetch(`${baseUrl}/api/sessions/${olderSession.sessionId}/unknown`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(unknownSubrouteRes.status, 404);
});
