import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { REVIEW_CONTRACT_VERSION, type ReviewApiErrorResponse } from '@development-factory/shared';
import { handleTerminalConnection } from './ws/terminal-handler.js';
import { listDirectories } from './directories.js';
import { listHistory, readHistoryFile } from './history-reader.js';
import { ReviewService, ReviewServiceError } from './review-service.js';
import { SqliteReviewRepository, type ReviewRepositoryOptions } from './storage/index.js';

const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const MAX_JSON_BODY_BYTES = 64 * 1024;

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

export function createReviewServer(options?: ReviewRepositoryOptions) {
  const reviewRepository = SqliteReviewRepository.open(options);
  const reviewService = new ReviewService(reviewRepository);
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

    if (req.method === 'GET' && ['/api/directories', '/api/history', '/api/history/file'].includes(url.pathname)) {
      if (!applyCorsHeaders(req, res)) {
        res.writeHead(403).end(JSON.stringify({ error: 'Origem não permitida.' }));
        return;
      }
      try {
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
    sessions.set(ws, handleTerminalConnection(ws));
    ws.once('close', () => sessions.delete(ws));
  });
  const shutdown = () => {
    for (const [ws, stop] of sessions) { stop(); ws.terminate(); }
    wss.close();
    server.close();
    reviewRepository.close();
  };
  return { server, shutdown, reviewRepository, reviewService };
}
