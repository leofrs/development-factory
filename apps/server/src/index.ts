import { createReviewServer } from './server.js';

const { server, shutdown } = createReviewServer();
server.on('error', error => { console.error('Falha no servidor:', error.message); process.exitCode = 1; });
server.listen(3001, '127.0.0.1', () => console.log('Backend: http://127.0.0.1:3001 — WebSocket: /ws/terminal'));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
