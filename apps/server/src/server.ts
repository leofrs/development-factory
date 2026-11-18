import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleTerminalConnection } from './ws/terminal-handler.js';
import { listDirectories } from './directories.js';
import { listHistory, readHistoryFile } from './history-reader.js';
import { SqliteReviewRepository, type ReviewRepositoryOptions } from './storage/index.js';

const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
export function createReviewServer(options?: ReviewRepositoryOptions) {
  const reviewRepository = SqliteReviewRepository.open(options);
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:3001');
    if (req.method === 'GET' && ['/api/directories', '/api/history', '/api/history/file'].includes(url.pathname)) {
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) {
        res.writeHead(403).end(JSON.stringify({ error: 'Origem não permitida.' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
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
  return { server, shutdown, reviewRepository };
}
