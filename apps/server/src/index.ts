import { createReviewServer } from './server.js';

const { server, shutdown } = createReviewServer();
server.on('error', error => { console.error('Falha no servidor:', error.message); process.exitCode = 1; });
server.listen(3001, '127.0.0.1', () => console.log('Backend: http://127.0.0.1:3001 — WebSocket: /ws/terminal'));
const handleShutdownSignal = (): void => {
  shutdown().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Falha ao encerrar servidor:', message);
    process.exitCode = 1;
  });
};

process.once('SIGINT', handleShutdownSignal);
process.once('SIGTERM', handleShutdownSignal);
