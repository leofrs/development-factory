import { WebSocket } from 'ws';
import { ClientMessageSchema, type ServerMessage } from '@development-factory/shared';
import { SessionManagerError, type SessionManager } from '../session-manager.js';

export function handleTerminalConnection(ws: WebSocket, sessionManager: SessionManager): () => void {
  let attachedSessionId: string | undefined;
  let closed = false;
  let operationChain: Promise<void> = Promise.resolve();

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const detachCurrentSession = (): void => {
    if (attachedSessionId) {
      sessionManager.detachClient(attachedSessionId, ws);
      attachedSessionId = undefined;
    }
  };

  const closeConnection = (): void => {
    closed = true;
    detachCurrentSession();
  };

  const enqueue = (task: () => Promise<void>): void => {
    operationChain = operationChain.then(task).catch(error => {
      if (error instanceof SessionManagerError) {
        send({ type: 'error', message: error.message });
        return;
      }
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      send({
        type: 'error',
        message: `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
      });
    });
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      send({ type: 'error', message: 'Envie mensagens JSON de texto.' });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw.toString()) as unknown;
    } catch {
      send({ type: 'error', message: 'JSON inválido.' });
      return;
    }

    const result = ClientMessageSchema.safeParse(value);
    if (!result.success) {
      send({
        type: 'error',
        message: `Mensagem inválida: ${result.error.issues.map(issue => issue.message).join('; ')}`,
      });
      return;
    }

    const msg = result.data;
    enqueue(async () => {
      if (closed) {
        return;
      }

      if (msg.type === 'start_review') {
        detachCurrentSession();
        const session = await sessionManager.startReviewSession(msg);
        if (closed) {
          return;
        }
        attachedSessionId = session.sessionId;
        sessionManager.attachClient(session.sessionId, ws);
        return;
      }

      if (msg.type === 'start_factory') {
        detachCurrentSession();
        const session = await sessionManager.startFactorySession(msg);
        if (closed) {
          return;
        }
        attachedSessionId = session.sessionId;
        sessionManager.attachClient(session.sessionId, ws);
        return;
      }

      if (msg.type === 'attach_session') {
        const target = sessionManager.getSession(msg.sessionId);
        if (!target) {
          send({ type: 'error', message: `Sessão ${msg.sessionId} não encontrada.` });
          return;
        }
        detachCurrentSession();
        attachedSessionId = msg.sessionId;
        sessionManager.attachClient(msg.sessionId, ws);
        if (target.status === 'running') {
          sessionManager.resizeSession(msg.sessionId, msg.cols, msg.rows);
        }
        return;
      }

      if (msg.type === 'stop_session') {
        await sessionManager.stopSession(msg.sessionId);
        return;
      }

      if (!attachedSessionId) {
        send({ type: 'error', message: 'Nenhuma sessão PTY ativa. Abra uma nova sessão.' });
        return;
      }

      if (msg.type === 'input') {
        sessionManager.writeInput(attachedSessionId, msg.data);
      } else if (msg.type === 'resize') {
        sessionManager.resizeSession(attachedSessionId, msg.cols, msg.rows);
      }
    });
  });

  ws.once('close', closeConnection);
  ws.once('error', () => {
    closeConnection();
    ws.terminate();
  });

  return closeConnection;
}
