import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ClientMessageSchema, DirectoryListingSchema, ReviewDetailsSchema, ServerMessageSchema, type ClientMessage, type ServerMessage } from '@development-factory/shared';
import { createReviewServer } from '../src/server.js';

async function until<T>(probe: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = probe();
    if (result !== undefined) return result;
    await delay(15);
  }
  throw new Error(`Timeout: ${label}`);
}

test('HTTP, origem, protocolo e ciclo completo com WebSocket e PTY reais', { timeout: 30000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'review-pty-'));
  const previousPath = process.env.PATH;
  const { server, shutdown } = createReviewServer({ dbPath: join(directory, 'reviews.db') });
  const sockets: WebSocket[] = [];
  context.after(async () => {
    sockets.forEach(socket => socket.terminate());
    shutdown();
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await copyFile(new URL('./fixtures/claude.ts', import.meta.url), join(directory, 'claude'));
  await chmod(join(directory, 'claude'), 0o755);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws/terminal`;
  assert.deepEqual(await (await fetch(`${httpUrl}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${httpUrl}/missing`)).status, 404);
  await mkdir(join(directory, 'projeto com espaços'));
  const directoryUrl = `${httpUrl}/api/directories?${new URLSearchParams({ path: directory })}`;
  assert.equal((await fetch(directoryUrl)).status, 403);
  assert.equal((await fetch(directoryUrl, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const listingResponse = await fetch(directoryUrl, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(listingResponse.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  const listing = DirectoryListingSchema.parse(await listingResponse.json());
  assert.equal(listing.path, directory);
  assert(listing.directories.some(entry => entry.path === join(directory, 'projeto com espaços')));
  assert(!listing.directories.some(entry => entry.name === 'claude'));
  assert.equal((await fetch(`${httpUrl}/api/directories?path=relative`, { headers: { Origin: 'http://127.0.0.1:5173' } })).status, 400);
  for (const route of ['/api/history', '/api/history/file']) {
    assert.equal((await fetch(`${httpUrl}${route}`)).status, 403);
    assert.equal((await fetch(`${httpUrl}${route}`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  }

  for (const [url, origin, status] of [
    [wsUrl, 'https://untrusted.example', 403],
    [wsUrl, undefined, 403],
    [wsUrl.replace('/ws/terminal', '/other'), 'http://localhost:5173', 404],
  ] as const) {
    const denied = new WebSocket(url, origin ? { origin } : {});
    await new Promise<void>((resolve, reject) => {
      denied.once('unexpected-response', (_req, response) => {
        try { assert.equal(response.statusCode, status); response.resume(); denied.terminate(); resolve(); }
        catch (error) { reject(error); }
      });
      denied.on('error', () => {});
      denied.once('open', () => { denied.terminate(); reject(new Error('Upgrade indevidamente permitido')); });
    });
  }

  const socket = new WebSocket(wsUrl, { origin: 'http://localhost:5173' });
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  let output = '';
  socket.on('message', raw => {
    const message = ServerMessageSchema.parse(JSON.parse(raw.toString()));
    messages.push(message);
    if (message.type === 'output') output += message.data;
  });
  await once(socket, 'open');
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  const take = (type: ServerMessage['type']) => until(() => {
    const index = messages.findIndex(message => message.type === type);
    return index >= 0 ? messages.splice(index, 1)[0] : undefined;
  }, type);
  socket.send('{invalid');
  assert.equal((await take('error')).type, 'error');
  socket.send(JSON.stringify({ type: 'resize', cols: -1, rows: 0 }));
  assert.equal((await take('error')).type, 'error');
  assert.equal(ClientMessageSchema.safeParse({ type: 'start_review', targetType: 'pr', identifier: '0', repoPath: directory, cols: 80, rows: 24 }).success, false);
  send({ type: 'start_review', targetType: 'pr', identifier: '42', repoPath: join(directory, 'missing'), cols: 80, rows: 24 });
  await take('error');
  const start = { type: 'start_review', targetType: 'branch', identifier: 'feat/test;$(touch SHOULD_NOT_EXIST)', repoPath: directory, cols: 80, rows: 24 } as const;
  send(start);
  assert.deepEqual(await take('status'), { type: 'status', state: 'running' });
  const initialHistory = await take('history');
  assert(initialHistory.type === 'history');
  assert.equal(initialHistory.state, 'pending');
  assert(initialHistory.reportPath.startsWith(join(directory, '.code-reviews')));
  assert(existsSync(initialHistory.reportPath));
  const ready = await until(() => output.match(/READY:([^\r\n]+)/)?.[1], 'PTY pronto');
  const info = JSON.parse(ready) as { pid: number; cwd: string; args: string[]; term: string; color: string; tty: boolean };
  assert.equal(info.cwd, directory);
  assert.equal(info.tty, true);
  assert.equal(info.term, 'xterm-256color');
  assert.equal(info.color, 'truecolor');
  assert.equal(info.args.length, 1);
  assert(info.args[0]?.includes(start.identifier));
  assert(info.args[0]?.includes('Etapa 5'));
  assert.equal(existsSync(join(directory, 'SHOULD_NOT_EXIST')), false);
  send({ type: 'input', data: 'olá PTY' });
  await until(() => output.includes('INPUT:olá PTY') ? true : undefined, 'entrada interativa');
  send({ type: 'resize', cols: 100, rows: 35 });
  await until(() => output.includes('SIZE:100x35') ? true : undefined, 'resize');

  output = '';
  send(start);
  await take('status');
  await until(() => { try { process.kill(info.pid, 0); return undefined; } catch { return true; } }, 'PTY anterior encerrado');
  await until(() => output.includes('READY:') ? true : undefined, 'PTY reiniciado');
  assert.match(readFileSync(initialHistory.reportPath, 'utf8'), /Code review incompleto/);
  assert.match(readFileSync(initialHistory.sessionPath, 'utf8'), /INPUT:olá PTY/);
  const secondHistory = await until(() => messages.find(message => message.type === 'history' && message.state === 'pending' && message.reportPath !== initialHistory.reportPath), 'novo histórico');
  assert(secondHistory.type === 'history');
  assert.notEqual(secondHistory.reportPath, initialHistory.reportPath);
  send({ type: 'input', data: 'SAVE' });
  await until(() => messages.find(message => message.type === 'history' && message.state === 'saved' && message.reportPath === secondHistory.reportPath), 'parecer salvo');
  send({ type: 'input', data: 'EXIT' });
  assert.deepEqual(await take('status'), { type: 'status', state: 'exited', exitCode: 7 });
  assert.equal(readFileSync(secondHistory.reportPath, 'utf8'), '# Parecer final\n\nAPROVADO\n');
  assert.match(readFileSync(secondHistory.sessionPath, 'utf8'), /código 7/);
  const historyResponse = await fetch(`${httpUrl}/api/history?${new URLSearchParams({ path: directory, preferReviews: '1' })}`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(historyResponse.status, 200);
  const fileResponse = await fetch(`${httpUrl}/api/history/file?${new URLSearchParams({ path: join(directory, '.code-reviews'), name: secondHistory.reportPath.split('/').at(-1)! })}`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(fileResponse.status, 200);
  assert.equal((await fileResponse.json() as { content: string }).content, '# Parecer final\n\nAPROVADO\n');

  output = '';
  send(start);
  await take('status');
  const next = JSON.parse(await until(() => output.match(/READY:([^\r\n]+)/)?.[1], 'PTY final')) as { pid: number };
  const finalHistory = await until(() => messages.find(message => message.type === 'history' && message.state === 'pending' && message.reportPath !== initialHistory.reportPath && message.reportPath !== secondHistory.reportPath), 'histórico final');
  assert(finalHistory.type === 'history');
  socket.close();
  await once(socket, 'close');
  await until(() => { try { process.kill(next.pid, 0); return undefined; } catch { return true; } }, 'PTY encerrado na desconexão');
  assert.match(readFileSync(finalHistory.reportPath, 'utf8'), /Code review incompleto/);
  assert.match(readFileSync(finalHistory.sessionPath, 'utf8'), /conexão fechada/);
});

test('executor PTY integra com ReviewService: ID persistente, artefatos, saída 0 sem conclusão automática e interrupção', { timeout: 30000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'review-pty-domain-'));
  const previousPath = process.env.PATH;
  const { server, shutdown } = createReviewServer({ dbPath: join(directory, 'reviews.db') });
  const sockets: WebSocket[] = [];
  context.after(async () => {
    sockets.forEach(socket => socket.terminate());
    shutdown();
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });

  await copyFile(new URL('./fixtures/claude.ts', import.meta.url), join(directory, 'claude'));
  await chmod(join(directory, 'claude'), 0o755);
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws/terminal`;

  const fetchReview = async (reviewId: string) => {
    const response = await fetch(`${httpUrl}/api/reviews/${reviewId}`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(response.status, 200);
    return ReviewDetailsSchema.parse(await response.json());
  };

  const socket = new WebSocket(wsUrl, { origin: 'http://localhost:5173' });
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  let output = '';
  socket.on('message', raw => {
    const message = ServerMessageSchema.parse(JSON.parse(raw.toString()));
    messages.push(message);
    if (message.type === 'output') {
      output += message.data;
    }
  });
  await once(socket, 'open');

  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  const takeWhere = (predicate: (message: ServerMessage) => boolean, label: string) => until(() => {
    const index = messages.findIndex(predicate);
    return index >= 0 ? messages.splice(index, 1)[0] : undefined;
  }, label);

  // 1. Início com ID persistente, artefatos vinculados, SAVE sem concluir e saída 0 -> incomplete.
  send({ type: 'start_review', targetType: 'pr', identifier: '88', repoPath: directory, cols: 80, rows: 24 });
  const analyzingMsg = await takeWhere(
    message => message.type === 'review' && message.state === 'analyzing',
    'review analyzing',
  );
  assert(analyzingMsg.type === 'review');
  const firstReviewId = analyzingMsg.reviewId;
  const firstExecutionId = analyzingMsg.executionId;

  const ready = await until(() => output.match(/READY:([^\r\n]+)/)?.[1], 'PTY pronto');
  const info = JSON.parse(ready) as { pid: number };

  const activeDetails = await fetchReview(firstReviewId);
  assert.equal(activeDetails.review.state, 'analyzing');
  assert.equal(activeDetails.executions[0]?.id, firstExecutionId);
  assert.deepEqual(activeDetails.executions[0]?.process, { status: 'running', pid: info.pid });
  assert.equal(activeDetails.artifacts.length, 2);
  assert(activeDetails.artifacts.some(item => item.kind === 'report' && item.status === 'pending'));
  assert(activeDetails.artifacts.some(item => item.kind === 'session_log' && item.status === 'pending'));

  // Salvar o arquivo de parecer atualiza o artefato para ready, mas NÃO conclui o review.
  send({ type: 'input', data: 'SAVE' });
  await takeWhere(message => message.type === 'history' && message.state === 'saved', 'parecer salvo');
  // Aguarda a persistência assíncrona do artefato ready.
  await delay(80);
  const detailsAfterSave = await fetchReview(firstReviewId);
  assert.equal(detailsAfterSave.review.state, 'analyzing');
  assert.equal(detailsAfterSave.artifacts.find(item => item.kind === 'report')?.status, 'ready');

  // Saída com código 0 sem resultado estruturado validado não conclui o review: vai para incomplete.
  send({ type: 'input', data: 'EXIT0' });
  const exitMsg = await takeWhere(message => message.type === 'status' && message.state === 'exited', 'exit 0');
  assert(exitMsg.type === 'status');
  assert.equal(exitMsg.exitCode, 0);
  const incompleteMsg = await takeWhere(
    message => message.type === 'review' && message.reviewId === firstReviewId && message.state === 'incomplete',
    'review incomplete',
  );
  assert(incompleteMsg.type === 'review');

  const finishedDetails = await fetchReview(firstReviewId);
  assert.equal(finishedDetails.review.state, 'incomplete');
  assert.equal(finishedDetails.review.error?.code, 'RESULT_NOT_VALIDATED');
  assert.deepEqual(finishedDetails.executions[0]?.process, { status: 'exited', exitCode: 0, signal: null });
  assert.equal(finishedDetails.artifacts.find(item => item.kind === 'session_log')?.status, 'ready');
  assert.equal(finishedDetails.artifacts.find(item => item.kind === 'report')?.status, 'ready');

  // 2. Nova sessão interrompida ao fechar o WebSocket -> cancelled + report incomplete.
  output = '';
  send({ type: 'start_review', targetType: 'branch', identifier: 'feat/interrupted', repoPath: directory, cols: 80, rows: 24 });
  const secondAnalyzing = await takeWhere(
    message => message.type === 'review' && message.reviewId !== firstReviewId && message.state === 'analyzing',
    'segundo review analyzing',
  );
  assert(secondAnalyzing.type === 'review');
  const secondReviewId = secondAnalyzing.reviewId;
  const secondReady = await until(() => output.match(/READY:([^\r\n]+)/)?.[1], 'segundo PTY pronto');
  const secondInfo = JSON.parse(secondReady) as { pid: number };

  socket.close();
  await once(socket, 'close');
  await until(() => {
    try {
      process.kill(secondInfo.pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, 'segundo PTY encerrado');

  // Aguarda a persistência da interrupção após o fechamento do socket.
  let interruptedDetails = await fetchReview(secondReviewId);
  const deadline = Date.now() + 3000;
  while (interruptedDetails.review.state !== 'cancelled' && Date.now() < deadline) {
    await delay(20);
    interruptedDetails = await fetchReview(secondReviewId);
  }
  assert.equal(interruptedDetails.review.state, 'cancelled');
  assert.equal(interruptedDetails.executions[0]?.process.status, 'exited');
  assert.equal(interruptedDetails.artifacts.find(item => item.kind === 'session_log')?.status, 'ready');
  const interruptedReport = interruptedDetails.artifacts.find(item => item.kind === 'report');
  assert.equal(interruptedReport?.status, 'incomplete');
  assert.equal(interruptedReport?.error?.code, 'REVIEW_INTERRUPTED');
  assert(interruptedDetails.events.some(event => event.type === 'review.session_interrupted'));
});
