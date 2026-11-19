import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AppEventSchema,
  BackgroundSessionSummarySchema,
  REVIEW_CONTRACT_VERSION,
  ReviewDestinationSchema,
  type AppEvent,
  type ReviewApiErrorResponse,
} from '@development-factory/shared';
import { defaultReviewReportDirectory } from './artifacts.js';
import { handleTerminalConnection } from './ws/terminal-handler.js';
import { listDirectories } from './directories.js';
import { listHistory, readHistoryFile } from './history-reader.js';
import { ReviewService, ReviewServiceError } from './review-service.js';
import { SessionManager, SessionManagerError } from './session-manager.js';
import { SqliteReviewRepository, type ReviewRepositoryOptions } from './storage/index.js';

const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

function sendApiError(
  res: ServerResponse,
  statusCode: number,
  error: ReviewApiErrorResponse['error'],
): void {
  const payload: ReviewApiErrorResponse = {
    contractVersion: REVIEW_CONTRACT_VERSION,
    error,
  };
  res.writeHead(statusCode).end(JSON.stringify(payload));
}

function sendSessionError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  res.writeHead(statusCode).end(JSON.stringify({ error: { code, message } }));
}

function decodeRouteParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function handleSessionApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionManager: SessionManager,
): Promise<void> {
  if (!applyCorsHeaders(req, res)) {
    sendSessionError(res, 403, 'ORIGIN_FORBIDDEN', 'Origem não permitida.');
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const sessions = BackgroundSessionSummarySchema.array().parse(sessionManager.listSessions());
      res.writeHead(200).end(JSON.stringify({ sessions }));
      return;
    }

    const sessionIdMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && sessionIdMatch?.[1] !== undefined) {
      const sessionId = decodeRouteParam(sessionIdMatch[1]);
      if (sessionId === null) {
        sendSessionError(res, 400, 'SESSION_INVALID_INPUT', 'Identificador de sessão inválido.');
        return;
      }

      const summary = sessionManager.getSessionSummary(sessionId);
      if (!summary) {
        sendSessionError(res, 404, 'SESSION_NOT_FOUND', `Sessão ${sessionId} não encontrada.`);
        return;
      }

      const session = BackgroundSessionSummarySchema.parse(summary);
      res.writeHead(200).end(JSON.stringify({ session }));
      return;
    }

    const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
    if (req.method === 'POST' && stopMatch?.[1] !== undefined) {
      const sessionId = decodeRouteParam(stopMatch[1]);
      if (sessionId === null) {
        sendSessionError(res, 400, 'SESSION_INVALID_INPUT', 'Identificador de sessão inválido.');
        return;
      }

      const summary = await sessionManager.stopSession(sessionId);
      const session = BackgroundSessionSummarySchema.parse(summary);
      res.writeHead(200).end(JSON.stringify({ session }));
      return;
    }

    sendSessionError(res, 404, 'SESSION_NOT_FOUND', 'Rota de sessão não encontrada.');
  } catch (error) {
    if (error instanceof SessionManagerError) {
      sendSessionError(res, error.statusCode, error.code, error.message);
      return;
    }
    sendSessionError(
      res,
      500,
      'SESSION_INTERNAL_ERROR',
      'Erro interno inesperado ao processar a requisição de sessão.',
    );
  }
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): string | null {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    return null;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  return origin;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'O corpo da requisição excede o limite máximo permitido.',
        413,
      );
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) {
    throw new ReviewServiceError(
      'REVIEW_INVALID_INPUT',
      'O corpo da requisição JSON é obrigatório.',
      400,
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ReviewServiceError(
      'REVIEW_INVALID_INPUT',
      'O corpo da requisição não contém JSON válido.',
      400,
    );
  }
}

function parseListReviewsQuery(searchParams: URLSearchParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const state = searchParams.get('state');
  const repoPath = searchParams.get('repoPath');
  const limitRaw = searchParams.get('limit');

  if (state !== null) {
    filter.state = state;
  }
  if (repoPath !== null) {
    filter.repoPath = repoPath;
  }
  if (limitRaw !== null) {
    const parsedLimit = Number(limitRaw);
    filter.limit = limitRaw.trim() !== '' && Number.isFinite(parsedLimit) ? parsedLimit : NaN;
  }
  return filter;
}

function getIdempotencyHeader(req: IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  if (Array.isArray(value)) {
    if (value.length > 1) {
      throw new ReviewServiceError(
        'REVIEW_INVALID_INPUT',
        'Cabeçalho Idempotency-Key duplicado.',
        400,
      );
    }
    return value[0];
  }
  return value;
}

function handleEventsStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  sseClients: Set<() => void>,
): void {
  if (req.method !== 'GET') {
    if (!applyCorsHeaders(req, res)) {
      sendSessionError(res, 403, 'ORIGIN_FORBIDDEN', 'Origem não permitida.');
      return;
    }
    sendSessionError(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido para /api/events.');
    return;
  }

  if (!applyCorsHeaders(req, res)) {
    sendSessionError(res, 403, 'ORIGIN_FORBIDDEN', 'Origem não permitida.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const writeSseChunk = (chunk: string): void => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(chunk);
    }
  };

  writeSseChunk(`event: heartbeat\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  const unsubscribe = sessionManager.onEvent((event: AppEvent) => {
    const validated = AppEventSchema.parse(event);
    writeSseChunk(`data: ${JSON.stringify(validated)}\n\n`);
  });

  const heartbeatTimer = setInterval(() => {
    writeSseChunk(': heartbeat\n\n');
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  let closed = false;
  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
    sseClients.delete(cleanup);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  };

  sseClients.add(cleanup);
  req.once('close', cleanup);
  res.once('close', cleanup);
  res.once('error', cleanup);
}

export function createReviewServer(options?: ReviewRepositoryOptions) {
  const reviewRepository = SqliteReviewRepository.open(options);
  const reviewService = new ReviewService(reviewRepository);
  const sessionManager = new SessionManager(reviewService);
  const sseClients = new Set<() => void>();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:3001');

    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      if (!applyCorsHeaders(req, res)) {
        sendApiError(res, 403, { code: 'ORIGIN_FORBIDDEN', message: 'Origem não permitida.' });
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === '/api/reviews' || url.pathname.startsWith('/api/reviews/')) {
      if (!applyCorsHeaders(req, res)) {
        sendApiError(res, 403, { code: 'ORIGIN_FORBIDDEN', message: 'Origem não permitida.' });
        return;
      }

      try {
        if (req.method === 'POST' && url.pathname === '/api/reviews') {
          const body = await readJsonBody(req);
          const idempotencyKey = getIdempotencyHeader(req);
          const result = await reviewService.createReview(body, { idempotencyKey });
          res.writeHead(result.replayed ? 200 : 201).end(JSON.stringify(result));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/reviews') {
          const result = reviewService.listReviews(parseListReviewsQuery(url.searchParams));
          res.writeHead(200).end(JSON.stringify(result));
          return;
        }

        const reviewIdMatch = /^\/api\/reviews\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && reviewIdMatch?.[1] !== undefined) {
          const reviewId = decodeURIComponent(reviewIdMatch[1]);
          const result = reviewService.getReview(reviewId);
          res.writeHead(200).end(JSON.stringify(result));
          return;
        }

        const transitionMatch = /^\/api\/reviews\/([^/]+)\/transitions$/.exec(url.pathname);
        if (req.method === 'POST' && transitionMatch?.[1] !== undefined) {
          const reviewId = decodeURIComponent(transitionMatch[1]);
          const body = await readJsonBody(req);
          const review = await reviewService.transitionReview(reviewId, body);
          res.writeHead(200).end(JSON.stringify({
            contractVersion: REVIEW_CONTRACT_VERSION,
            review,
          }));
          return;
        }

        const artifactsMatch = /^\/api\/reviews\/([^/]+)\/artifacts$/.exec(url.pathname);
        if (artifactsMatch?.[1] !== undefined) {
          const reviewId = decodeURIComponent(artifactsMatch[1]);
          if (req.method === 'GET') {
            const executionId = url.searchParams.get('executionId') ?? undefined;
            const result = reviewService.listArtifacts(reviewId, executionId);
            res.writeHead(200).end(JSON.stringify(result));
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const result = await reviewService.registerArtifact(reviewId, body);
            res.writeHead(201).end(JSON.stringify(result));
            return;
          }
        }

        const prepareArtifactsMatch = /^\/api\/reviews\/([^/]+)\/artifacts\/prepare$/.exec(url.pathname);
        if (req.method === 'POST' && prepareArtifactsMatch?.[1] !== undefined) {
          const reviewId = decodeURIComponent(prepareArtifactsMatch[1]);
          const body = await readJsonBody(req);
          const result = await reviewService.prepareExecutionArtifacts(reviewId, body);
          res.writeHead(201).end(JSON.stringify(result));
          return;
        }

        sendApiError(res, 404, { code: 'REVIEW_NOT_FOUND', message: 'Rota de review não encontrada.' });
      } catch (error) {
        if (error instanceof ReviewServiceError) {
          sendApiError(res, error.statusCode, {
            code: error.code,
            message: error.message,
            ...(error.details && error.details.length > 0 ? { details: [...error.details] } : {}),
          });
          return;
        }
        sendApiError(res, 500, {
          code: 'REVIEW_INTERNAL_ERROR',
          message: 'Erro interno inesperado ao processar a requisição de review.',
        });
      }
      return;
    }

    if (url.pathname === '/api/events') {
      handleEventsStreamRequest(req, res, sessionManager, sseClients);
      return;
    }

    if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
      await handleSessionApiRequest(req, res, url, sessionManager);
      return;
    }

    if (req.method === 'GET' && [
      '/api/directories', '/api/history', '/api/history/file', '/api/history/reports', '/api/review-destination',
    ].includes(url.pathname)) {
      if (!applyCorsHeaders(req, res)) {
        res.writeHead(403).end(JSON.stringify({ error: 'Origem não permitida.' }));
        return;
      }
      try {
        if (url.pathname === '/api/history/reports') {
          res.writeHead(200).end(JSON.stringify(reviewRepository.listSavedReports()));
          return;
        }
        if (url.pathname === '/api/review-destination') {
          const destination = ReviewDestinationSchema.parse({ path: defaultReviewReportDirectory() });
          res.writeHead(200).end(JSON.stringify(destination));
          return;
        }
        const path = url.searchParams.get('path') ?? undefined;
        const result = url.pathname === '/api/history/file'
          ? await readHistoryFile(path ?? '', url.searchParams.get('name') ?? '')
          : url.pathname === '/api/history'
            ? await listHistory(path, url.searchParams.get('preferReviews') === '1')
            : await listDirectories(path);
        res.writeHead(200).end(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error && !('code' in error)
          ? error.message
          : 'Não foi possível abrir esta pasta ou arquivo no WSL. Verifique se existe e se você tem permissão de leitura.';
        res.writeHead(400).end(JSON.stringify({ error: message }));
      }
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const sessions = new Map<WebSocket, () => void>();

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/terminal') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    sessions.set(ws, handleTerminalConnection(ws, sessionManager));
    ws.once('close', () => sessions.delete(ws));
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      await sessionManager.shutdownAll();
      for (const closeSse of sseClients) {
        closeSse();
      }
      for (const [ws, stop] of sessions) {
        stop();
        ws.terminate();
      }
      wss.close();
      server.close();
      reviewRepository.close();
    })();
    return shutdownPromise;
  };
  return { server, shutdown, reviewRepository, reviewService, sessionManager };
}
