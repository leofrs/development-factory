import { existsSync, statSync } from 'node:fs';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { ClientMessageSchema, type ServerMessage } from '@development-factory/shared';
import { buildCodeReviewPrompt } from '../prompts/code-review.js';
import { createReviewHistory } from '../history.js';

export function handleTerminalConnection(ws: WebSocket): () => void {
  let ptyProcess: pty.IPty | undefined;
  let subscriptions: pty.IDisposable[] = [];
  let history: ReturnType<typeof createReviewHistory> | undefined;

  const send = (message: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const stop = () => {
    const current = ptyProcess;
    ptyProcess = undefined;
    subscriptions.forEach(subscription => subscription.dispose());
    subscriptions = [];
    if (current) {
      try { current.kill(); } catch { /* O processo já pode ter terminado. */ }
    }
    history?.finish('sessão encerrada pelo usuário ou conexão fechada');
    history = undefined;
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      send({ type: 'error', message: 'Envie mensagens JSON de texto.' });
      return;
    }
    let value: unknown;
    try { value = JSON.parse(raw.toString()); }
    catch {
      send({ type: 'error', message: 'JSON inválido.' });
      return;
    }
    const result = ClientMessageSchema.safeParse(value);
    if (!result.success) {
      send({ type: 'error', message: `Mensagem inválida: ${result.error.issues.map(issue => issue.message).join('; ')}` });
      return;
    }
    const msg = result.data;
    try {
      if (msg.type === 'start_review') {
        if (!existsSync(msg.repoPath) || !statSync(msg.repoPath).isDirectory()) {
          send({ type: 'error', message: 'O caminho do repositório não existe ou não é um diretório no WSL.' });
          return;
        }
        stop();
        const reviewHistory = createReviewHistory(msg,
          state => send({ type: 'history', reportPath: reviewHistory.reportPath, sessionPath: reviewHistory.sessionPath, state }),
          message => send({ type: 'error', message }));
        history = reviewHistory;
        send({ type: 'history', reportPath: reviewHistory.reportPath, sessionPath: reviewHistory.sessionPath, state: 'pending' });
        const child = pty.spawn('claude', [buildCodeReviewPrompt(msg.targetType, msg.identifier, reviewHistory.reportPath)], {
          name: 'xterm-256color',
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.repoPath,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        });
        ptyProcess = child;
        subscriptions = [
          child.onData(data => { if (ptyProcess === child) { reviewHistory.record(data); send({ type: 'output', data }); } }),
          child.onExit(({ exitCode }) => {
            if (ptyProcess !== child) return;
            ptyProcess = undefined;
            subscriptions.forEach(subscription => subscription.dispose());
            subscriptions = [];
            reviewHistory.finish(`processo finalizado com código ${exitCode}`);
            history = undefined;
            send({ type: 'status', state: 'exited', exitCode });
          }),
        ];
        send({ type: 'status', state: 'running' });
      } else if (!ptyProcess) {
        send({ type: 'error', message: 'Nenhuma sessão PTY ativa. Abra uma nova sessão.' });
      } else if (msg.type === 'input') {
        ptyProcess.write(msg.data);
      } else {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch (error) {
      if (msg.type === 'start_review') stop();
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      send({ type: 'error', message: `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.` });
    }
  });
  ws.once('close', stop);
  ws.once('error', () => { stop(); ws.terminate(); });
  return stop;
}
