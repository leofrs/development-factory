import { existsSync, statSync } from 'node:fs';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  REVIEW_CONTRACT_VERSION,
  type ReviewError,
  type ReviewProcess,
  type ServerMessage,
} from '@development-factory/shared';
import { buildCodeReviewPrompt } from '../prompts/code-review.js';
import { buildFactoryPlanPrompt } from '../prompts/factory-plan.js';
import { createFactoryHistory, createReviewHistory } from '../history.js';
import { ReviewServiceError, type ReviewService } from '../review-service.js';

interface ActiveSession {
  readonly reviewId: string;
  readonly executionId: string;
  readonly reportArtifactId: string;
  readonly sessionArtifactId: string;
  reportSaved: boolean;
}

function buildReviewError(code: string, message: string, retryable: boolean): ReviewError {
  return {
    contractVersion: REVIEW_CONTRACT_VERSION,
    code,
    message,
    occurredAt: new Date().toISOString(),
    retryable,
  };
}

export function handleTerminalConnection(ws: WebSocket, reviewService: ReviewService): () => void {
  let ptyProcess: pty.IPty | undefined;
  let subscriptions: pty.IDisposable[] = [];
  let history: ReturnType<typeof createReviewHistory> | undefined;
  let activeSession: ActiveSession | undefined;
  let closed = false;
  let operationChain: Promise<void> = Promise.resolve();

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const disposePty = (killProcess: boolean): void => {
    const current = ptyProcess;
    ptyProcess = undefined;
    subscriptions.forEach(subscription => subscription.dispose());
    subscriptions = [];
    if (killProcess && current) {
      try {
        current.kill();
      } catch {
        // O processo já pode ter terminado.
      }
    }
  };

  const enqueue = (task: () => Promise<void>, swallowErrors = false): void => {
    operationChain = operationChain.then(task).catch(error => {
      if (swallowErrors) {
        return;
      }
      const detail = error instanceof Error ? error.message : 'Falha desconhecida';
      send({
        type: 'error',
        message: `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
      });
    });
  };

  const stopActiveSession = async (reason: string, interruptedByUser: boolean): Promise<void> => {
    disposePty(true);
    const currentHistory = history;
    history = undefined;
    const session = activeSession;
    activeSession = undefined;

    currentHistory?.finish(reason);

    if (!session) {
      return;
    }

    try {
      await reviewService.updateArtifactStatus(
        session.reviewId,
        session.sessionArtifactId,
        'ready',
        null,
        'review.session_log_saved',
      );
      if (!session.reportSaved) {
        await reviewService.updateArtifactStatus(
          session.reviewId,
          session.reportArtifactId,
          'incomplete',
          buildReviewError('REVIEW_INTERRUPTED', reason, true),
        );
      }
      const finished = await reviewService.finishExecution(session.reviewId, session.executionId, {
        process: { status: 'exited', exitCode: null, signal: 'SIGTERM' },
        targetState: 'cancelled',
        reason: interruptedByUser ? 'Sessão PTY interrompida pelo usuário ou conexão fechada.' : reason,
        eventType: 'review.session_interrupted',
      });
      send({
        type: 'review',
        reviewId: finished.review.id,
        executionId: finished.execution.id,
        state: finished.review.state,
      });
    } catch {
      // O repositório pode já estar encerrado durante o shutdown do servidor.
    }
  };

  const closeConnection = (): void => {
    closed = true;
    disposePty(true);
    enqueue(() => stopActiveSession('sessão encerrada pelo usuário ou conexão fechada', true), true);
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
        if (!existsSync(msg.repoPath) || !statSync(msg.repoPath).isDirectory()) {
          send({ type: 'error', message: 'O caminho do repositório não existe ou não é um diretório no WSL.' });
          return;
        }

        await stopActiveSession('sessão encerrada pelo usuário ou conexão fechada', true);

        const created = await reviewService.createReview({
          target: {
            type: msg.targetType,
            identifier: msg.identifier,
            repoPath: msg.repoPath,
          },
        });

        let preparedArtifacts;
        try {
          preparedArtifacts = await reviewService.prepareExecutionArtifacts(created.review.id, {
            executionId: created.execution.id,
            includeStructuredResult: false,
          });
        } catch (error) {
          const message = error instanceof ReviewServiceError
            ? error.message
            : 'Não foi possível preparar os arquivos do review.';
          send({ type: 'error', message });
          return;
        }

        const reportArtifact = preparedArtifacts.artifacts.find(item => item.kind === 'report');
        const sessionArtifact = preparedArtifacts.artifacts.find(item => item.kind === 'session_log');
        if (!reportArtifact || !sessionArtifact) {
          send({ type: 'error', message: 'Os artefatos obrigatórios do review não foram preparados.' });
          return;
        }

        if (closed) {
          await reviewService.finishExecution(created.review.id, created.execution.id, {
            process: { status: 'exited', exitCode: null, signal: 'SIGTERM' },
            targetState: 'cancelled',
            reason: 'Conexão fechada antes de iniciar o processo PTY.',
            eventType: 'review.session_interrupted',
          });
          return;
        }

        const session: ActiveSession = {
          reviewId: created.review.id,
          executionId: created.execution.id,
          reportArtifactId: reportArtifact.id,
          sessionArtifactId: sessionArtifact.id,
          reportSaved: false,
        };
        activeSession = session;

        const reviewHistory = createReviewHistory(
          msg,
          state => {
            if (state === 'saved') {
              session.reportSaved = true;
              enqueue(async () => {
                await reviewService.updateArtifactStatus(
                  session.reviewId,
                  session.reportArtifactId,
                  'ready',
                  null,
                  'review.report_file_saved',
                );
              }, true);
            }
            send({
              type: 'history',
              reportPath: reportArtifact.path,
              sessionPath: sessionArtifact.path,
              state,
            });
          },
          message => send({ type: 'error', message }),
          {
            reviewId: created.review.id,
            executionId: created.execution.id,
            prepared: {
              reportPath: reportArtifact.path,
              sessionPath: sessionArtifact.path,
              startedAt: created.execution.createdAt,
            },
          },
        );
        history = reviewHistory;

        send({
          type: 'review',
          reviewId: created.review.id,
          executionId: created.execution.id,
          state: created.review.state,
        });
        send({
          type: 'history',
          reportPath: reportArtifact.path,
          sessionPath: sessionArtifact.path,
          state: 'pending',
        });

        let child: pty.IPty;
        try {
          child = pty.spawn(
            'claude',
            [buildCodeReviewPrompt(msg.targetType, msg.identifier, reportArtifact.path)],
            {
              name: 'xterm-256color',
              cols: msg.cols,
              rows: msg.rows,
              cwd: msg.repoPath,
              env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
            },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Falha desconhecida';
          history = undefined;
          activeSession = undefined;
          reviewHistory.finish(`falha ao iniciar processo PTY: ${detail}`);

          const spawnError = buildReviewError(
            'PTY_SPAWN_FAILED',
            `Não foi possível iniciar o processo Claude: ${detail}`,
            true,
          );
          await reviewService.updateArtifactStatus(
            session.reviewId,
            session.sessionArtifactId,
            'ready',
            null,
            'review.session_log_saved',
          );
          await reviewService.updateArtifactStatus(
            session.reviewId,
            session.reportArtifactId,
            'incomplete',
            spawnError,
          );
          await reviewService.finishExecution(session.reviewId, session.executionId, {
            process: { status: 'failed', error: spawnError },
            targetState: 'failed',
            reason: `Falha ao iniciar o processo PTY: ${detail}`,
            error: spawnError,
          });
          send({
            type: 'error',
            message: `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
          });
          return;
        }

        ptyProcess = child;
        subscriptions = [
          child.onData(data => {
            if (ptyProcess === child) {
              reviewHistory.record(data);
              send({ type: 'output', data });
            }
          }),
          child.onExit(({ exitCode, signal }) => {
            if (ptyProcess !== child) {
              return;
            }
            disposePty(false);
            history = undefined;
            activeSession = undefined;
            reviewHistory.finish(`processo finalizado com código ${exitCode}`);
            send({ type: 'status', state: 'exited', exitCode });

            enqueue(async () => {
              const processExit: Extract<ReviewProcess, { status: 'exited' }> =
                typeof exitCode === 'number'
                  ? { status: 'exited', exitCode, signal: null }
                  : { status: 'exited', exitCode: null, signal: signal ? String(signal) : 'UNKNOWN' };

              const targetState = exitCode === 0 ? 'incomplete' : 'failed';
              const exitError = exitCode === 0
                ? buildReviewError(
                  'RESULT_NOT_VALIDATED',
                  'O processo PTY encerrou com código 0 sem resultado estruturado validado.',
                  true,
                )
                : buildReviewError(
                  'PTY_PROCESS_FAILED',
                  `Processo PTY encerrado com código ${exitCode}.`,
                  true,
                );

              await reviewService.updateArtifactStatus(
                session.reviewId,
                session.sessionArtifactId,
                'ready',
                null,
                'review.session_log_saved',
              );
              if (!session.reportSaved) {
                await reviewService.updateArtifactStatus(
                  session.reviewId,
                  session.reportArtifactId,
                  'incomplete',
                  buildReviewError(
                    'REPORT_NOT_SAVED',
                    'O parecer final não foi salvo antes do encerramento do processo.',
                    true,
                  ),
                );
              }
              const finished = await reviewService.finishExecution(session.reviewId, session.executionId, {
                process: processExit,
                targetState,
                reason: `Processo PTY finalizado com código ${exitCode}.`,
                error: exitError,
              });
              send({
                type: 'review',
                reviewId: finished.review.id,
                executionId: finished.execution.id,
                state: finished.review.state,
              });
            }, true);
          }),
        ];

        const started = await reviewService.startExecution(created.review.id, created.execution.id, child.pid);
        send({
          type: 'review',
          reviewId: started.review.id,
          executionId: started.execution.id,
          state: started.review.state,
        });
        send({ type: 'status', state: 'running' });
      } else if (msg.type === 'start_factory') {
        if (!existsSync(msg.repoPath) || !statSync(msg.repoPath).isDirectory()) {
          send({ type: 'error', message: 'O caminho do repositório não existe ou não é um diretório no WSL.' });
          return;
        }

        await stopActiveSession('sessão encerrada pelo usuário ou conexão fechada', true);

        let factoryHistory: ReturnType<typeof createFactoryHistory>;
        try {
          factoryHistory = createFactoryHistory(
            msg,
            state => {
              send({
                type: 'history',
                reportPath: factoryHistory.reportPath,
                sessionPath: factoryHistory.sessionPath,
                state,
              });
            },
            message => send({ type: 'error', message }),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Falha desconhecida';
          send({ type: 'error', message: `Não foi possível preparar os arquivos do planejamento: ${detail}` });
          return;
        }

        if (closed) {
          factoryHistory.finish('conexão fechada antes de iniciar o processo PTY');
          return;
        }

        history = factoryHistory;
        send({
          type: 'history',
          reportPath: factoryHistory.reportPath,
          sessionPath: factoryHistory.sessionPath,
          state: 'pending',
        });

        let child: pty.IPty;
        try {
          child = pty.spawn(
            'claude',
            [buildFactoryPlanPrompt(msg.inputType, msg.value, factoryHistory.reportPath)],
            {
              name: 'xterm-256color',
              cols: msg.cols,
              rows: msg.rows,
              cwd: msg.repoPath,
              env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
            },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Falha desconhecida';
          history = undefined;
          factoryHistory.finish(`falha ao iniciar processo PTY: ${detail}`);
          send({
            type: 'error',
            message: `Não foi possível operar o terminal: ${detail}. Verifique o caminho e se claude está no PATH do servidor.`,
          });
          return;
        }

        ptyProcess = child;
        subscriptions = [
          child.onData(data => {
            if (ptyProcess === child) {
              factoryHistory.record(data);
              send({ type: 'output', data });
            }
          }),
          child.onExit(({ exitCode }) => {
            if (ptyProcess !== child) {
              return;
            }
            disposePty(false);
            history = undefined;
            factoryHistory.finish(`processo finalizado com código ${exitCode}`);
            send({ type: 'status', state: 'exited', exitCode });
          }),
        ];
        send({ type: 'status', state: 'running' });
      } else if (!ptyProcess) {
        send({ type: 'error', message: 'Nenhuma sessão PTY ativa. Abra uma nova sessão.' });
      } else if (msg.type === 'input') {
        ptyProcess.write(msg.data);
      } else if (msg.type === 'resize') {
        ptyProcess.resize(msg.cols, msg.rows);
      } else {
        send({ type: 'error', message: 'Operação de sessão ainda não suportada pelo servidor.' });
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
