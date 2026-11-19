import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppEventSchema, type AppEvent } from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

interface ParsedSseMessage {
  readonly event?: string;
  readonly data: string;
}

function parseSseFrames(buffer: string): { frames: ParsedSseMessage[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: ParsedSseMessage[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) {
      continue;
    }

    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }

    if (dataLines.length > 0) {
      frames.push({
        ...(eventName !== undefined ? { event: eventName } : {}),
        data: dataLines.join('\n'),
      });
    }
  }

  return { frames, rest };
}

test('GET /api/events valida origem, envia heartbeat inicial e transmite AppEvents em tempo real via SSE', async context => {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-events-api-'));
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

  const abortController = new AbortController();

  context.after(async () => {
    abortController.abort();
    await shutdown();
    process.env.PATH = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  });

  // Origem ausente ou não permitida deve ser recusada com 403.
  const noOriginRes = await fetch(`${baseUrl}/api/events`);
  assert.equal(noOriginRes.status, 403);

  const badOriginRes = await fetch(`${baseUrl}/api/events`, {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(badOriginRes.status, 403);

  // Método não-GET deve retornar 405.
  const postRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { Origin: ALLOWED_ORIGIN },
  });
  assert.equal(postRes.status, 405);

  // Conecta ao stream SSE.
  const sseRes = await fetch(`${baseUrl}/api/events`, {
    headers: { Origin: ALLOWED_ORIGIN },
    signal: abortController.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(sseRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert(sseRes.body);

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';
  let sawHeartbeat = false;
  const receivedEvents: AppEvent[] = [];

  const readUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Tempo limite excedido aguardando eventos SSE.');
      }
      const chunkResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout lendo chunk SSE.')), remaining);
        }),
      ]);
      if (chunkResult.done) {
        break;
      }
      rawBuffer += decoder.decode(chunkResult.value, { stream: true });
      const parsed = parseSseFrames(rawBuffer);
      rawBuffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.event === 'heartbeat') {
          const heartbeat = JSON.parse(frame.data) as { connectedAt?: string };
          assert.equal(typeof heartbeat.connectedAt, 'string');
          sawHeartbeat = true;
          continue;
        }
        const appEvent = AppEventSchema.parse(JSON.parse(frame.data));
        receivedEvents.push(appEvent);
      }
    }
  };

  // Deve receber o evento inicial de heartbeat imediatamente.
  await readUntil(() => sawHeartbeat);
  assert.equal(sawHeartbeat, true);

  // Inicia uma sessão que salva o relatório automaticamente e encerra com código 0.
  const session = await sessionManager.startReviewSession({
    targetType: 'pr',
    identifier: '502',
    repoPath: repoDir,
    reportDirectory: rootDir,
    cols: 80,
    rows: 24,
  });

  const ptyProcess = session.ptyProcess;
  assert(ptyProcess);

  const readyDeadline = Date.now() + 4000;
  while (!session.buffer.replay().includes('READY:')) {
    if (Date.now() > readyDeadline) {
      throw new Error('Tempo limite excedido aguardando READY: no PTY.');
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
  }

  ptyProcess.write('SAVE');
  await readUntil(() => receivedEvents.some(event => event.type === 'session.history_saved'));

  ptyProcess.write('EXIT0');
  await readUntil(() => receivedEvents.some(event => event.type === 'session.finished'));

  const types = receivedEvents.map(event => event.type);
  assert(types.includes('session.started'));
  assert(types.includes('session.history_saved'));
  assert(types.includes('session.finished'));

  const finishedEvent = receivedEvents.find(event => event.type === 'session.finished');
  assert(finishedEvent);
  assert.equal(finishedEvent.session.sessionId, session.sessionId);
  assert.equal(finishedEvent.session.status, 'exited');
  assert.equal(finishedEvent.session.historyState, 'saved');
  assert.equal(finishedEvent.session.exitCode, 0);
  assert(finishedEvent.session.reportPath);

  await reader.cancel();
});
