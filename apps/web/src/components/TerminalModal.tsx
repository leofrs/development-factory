import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Compass,
  Copy,
  FileText,
  GitBranch,
  GitPullRequest,
  Minimize2,
  Square,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  ServerMessageSchema,
  type BackgroundSessionMode,
  type BackgroundSessionSummary,
  type ClientMessage,
  type FactoryRequest,
  type ReviewRequest,
  type ServerMessage,
} from '@development-factory/shared';
import '@xterm/xterm/css/xterm.css';
import { terminalThemes, type Theme } from '../theme';
import { ThemeToggle } from './ThemeToggle';

type Status = 'connecting' | 'running' | 'exited';
const labels: Record<Status, string> = {
  connecting: 'Conectando',
  running: 'Em execução',
  exited: 'Encerrado',
};

export type TerminalSession =
  | { mode: 'review'; request: ReviewRequest; sessionId?: string }
  | { mode: 'factory'; request: FactoryRequest; sessionId?: string }
  | { mode: BackgroundSessionMode; sessionId: string };

export function TerminalModal({
  session,
  sessionSummary,
  onMinimize,
  onStopSession,
  onBindSessionId,
  theme,
  onToggleTheme,
  onSavedReport,
  onViewMarkdown,
}: {
  session: TerminalSession;
  sessionSummary?: BackgroundSessionSummary;
  onMinimize: () => void;
  onStopSession?: (sessionId: string) => Promise<BackgroundSessionSummary>;
  onBindSessionId?: (sessionId: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onSavedReport?: (reportPath: string) => void;
  onViewMarkdown?: (reportPath: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const themeRef = useRef(theme);
  const onSavedReportRef = useRef(onSavedReport);
  const onBindSessionIdRef = useRef(onBindSessionId);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<Status>('connecting');
  const [exitCode, setExitCode] = useState<number>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachedSession, setAttachedSession] = useState<BackgroundSessionSummary>();
  const [history, setHistory] = useState<Extract<ServerMessage, { type: 'history' }>>();

  const sessionRequest = 'request' in session ? session.request : undefined;
  const attachSessionId = 'request' in session ? undefined : session.sessionId;
  const effectiveSummary = attachedSession ?? sessionSummary;
  const effectiveSessionId = attachedSession?.sessionId ?? session.sessionId ?? sessionSummary?.sessionId;

  useEffect(() => {
    onSavedReportRef.current = onSavedReport;
  }, [onSavedReport]);

  useEffect(() => {
    onBindSessionIdRef.current = onBindSessionId;
  }, [onBindSessionId]);

  useEffect(() => {
    themeRef.current = theme;
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalThemes[theme];
    }
  }, [theme]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = oldOverflow;
      clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | undefined;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let started = false;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners: { dispose(): void }[] = [];
    const send = (message: ClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    // StrictMode desmonta o primeiro efeito antes de iniciar qualquer conexão.
    const initTimer = setTimeout(() => {
      if (disposed || !containerRef.current) {
        return;
      }
      setStatus('connecting');
      setError('');
      setStopping(false);
      setAttachedSession(undefined);
      setHistory(undefined);
      const terminal = new Terminal({
        cursorBlink: true,
        scrollback: 15000,
        fontFamily: '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        theme: terminalThemes[themeRef.current],
      });
      term = terminal;
      terminalRef.current = terminal;
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerRef.current);
      const fit = () => {
        if (disposed || !containerRef.current?.clientWidth || !containerRef.current.clientHeight) {
          return;
        }
        fitAddon.fit();
        // Mantém as dimensões dentro dos limites do protocolo em telas muito grandes.
        if (terminal.cols > 500 || terminal.rows > 300) {
          terminal.resize(Math.min(terminal.cols, 500), Math.min(terminal.rows, 300));
        }
      };
      fit();
      ws = new WebSocket('ws://127.0.0.1:3001/ws/terminal');
      wsRef.current = ws;
      connectionTimer = setTimeout(() => {
        if (!disposed && ws?.readyState === WebSocket.CONNECTING) {
          setError('O backend não respondeu. Verifique se npm run dev está em execução no WSL.');
          setStatus('exited');
          ws.close();
        }
      }, 10000);

      ws.onopen = () => {
        if (disposed) {
          return;
        }
        clearTimeout(connectionTimer);
        fit();
        if (sessionRequest) {
          if ('targetType' in sessionRequest) {
            send({ type: 'start_review', ...sessionRequest, cols: terminal.cols, rows: terminal.rows });
          } else {
            send({ type: 'start_factory', ...sessionRequest, cols: terminal.cols, rows: terminal.rows });
          }
        } else if (attachSessionId) {
          send({
            type: 'attach_session',
            sessionId: attachSessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
        terminal.focus();
      };
      ws.onmessage = event => {
        if (disposed) {
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch {
          setError('Resposta inválida do backend.');
          return;
        }
        const parsed = ServerMessageSchema.safeParse(value);
        if (!parsed.success) {
          setError('Resposta incompatível com o protocolo do terminal.');
          return;
        }
        const message = parsed.data;
        if (message.type === 'session_attached') {
          setAttachedSession(message.session);
          onBindSessionIdRef.current?.(message.session.sessionId);
          if (message.replay.length > 0) {
            terminal.write(message.replay);
          }
          if (message.session.status === 'failed' && message.session.error) {
            setError(message.session.error);
          }
        } else if (message.type === 'output') {
          terminal.write(message.data);
        } else if (message.type === 'status') {
          started = message.state === 'running';
          setStatus(message.state);
          setExitCode(message.exitCode);
          if (message.state === 'exited') {
            setStopping(false);
          }
          if (message.sessionId) {
            onBindSessionIdRef.current?.(message.sessionId);
          }
          if (started) {
            send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
          }
        } else if (message.type === 'history') {
          setHistory(message);
          if (message.state === 'saved') {
            onSavedReportRef.current?.(message.reportPath);
          }
        } else if (message.type === 'review' || message.type === 'factory_flow') {
          // Eventos de ciclo de vida do review/fluxo (mantidos para compatibilidade).
        } else if (message.type === 'error') {
          setError(message.message);
          setStopping(false);
          if (!started) {
            setStatus('exited');
          }
        }
      };
      ws.onerror = () => {
        if (!disposed) {
          setError('Não foi possível conectar ao backend em 127.0.0.1:3001. Verifique se ele está em execução.');
        }
      };
      ws.onclose = () => {
        clearTimeout(connectionTimer);
        if (disposed) {
          return;
        }
        if (started) {
          setError('A conexão com o backend foi interrompida. Reabra o terminal para continuar.');
        }
        started = false;
        setStopping(false);
        setStatus('exited');
      };
      listeners.push(terminal.onData(data => { if (started) send({ type: 'input', data }); }));
      listeners.push(terminal.onResize(({ cols, rows }) => { if (started) send({ type: 'resize', cols, rows }); }));
      observer = new ResizeObserver(fit);
      observer.observe(containerRef.current);

      terminal.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === 'c' && terminal.hasSelection()) {
          event.preventDefault();
          void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
            if (!disposed) setError('Não foi possível copiar a seleção. Autorize o clipboard no navegador.');
          });
          return false;
        }
        if ((event.ctrlKey || event.metaKey) && key === 'v') {
          event.preventDefault();
          void navigator.clipboard.readText().then(text => { if (!disposed && started) terminal.paste(text); }).catch(() => {
            if (!disposed) setError('Não foi possível ler o clipboard. Autorize a colagem no navegador.');
          });
          return false;
        }
        return true;
      });
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(initTimer);
      clearTimeout(connectionTimer);
      observer?.disconnect();
      listeners.forEach(listener => listener.dispose());
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      }
      term?.dispose();
      terminalRef.current = null;
    };
  }, [attachSessionId, sessionRequest]);

  async function copyOutput() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    let text = '';
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      if (index > 0 && !line.isWrapped) text += '\n';
      text += line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
    }
    try {
      await navigator.clipboard.writeText(text.trimEnd());
      if (!terminalRef.current) return;
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { if (terminalRef.current) setError('Não foi possível copiar a saída. Autorize o clipboard no navegador.'); }
  }

  async function handleStopProcess() {
    if (!effectiveSessionId || stopping || status === 'exited') {
      return;
    }
    setStopping(true);
    setError('');
    try {
      if (onStopSession) {
        const updated = await onStopSession(effectiveSessionId);
        setAttachedSession(updated);
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        const stopMessage: ClientMessage = { type: 'stop_session', sessionId: effectiveSessionId };
        wsRef.current.send(JSON.stringify(stopMessage));
      } else {
        setError('Conexão indisponível para encerrar o processo.');
        setStopping(false);
      }
    } catch (stopError) {
      setError(
        stopError instanceof Error
          ? stopError.message
          : 'Não foi possível encerrar o processo no servidor.',
      );
      setStopping(false);
    }
  }

  const TargetIcon = session.mode === 'factory'
    ? Compass
    : sessionRequest
      ? 'targetType' in sessionRequest && sessionRequest.targetType === 'pr'
        ? GitPullRequest
        : GitBranch
      : effectiveSummary?.title.startsWith('PR #')
        ? GitPullRequest
        : GitBranch;
  const sessionTitle = sessionRequest
    ? 'targetType' in sessionRequest
      ? sessionRequest.targetType === 'pr'
        ? `PR #${sessionRequest.identifier}`
        : sessionRequest.identifier
      : sessionRequest.value
    : effectiveSummary?.title ?? 'Sessão em background';
  const repoPath = sessionRequest?.repoPath ?? effectiveSummary?.repoPath ?? '';
  const savedLabel = session.mode === 'factory'
    ? history?.state === 'saved'
      ? 'Plano salvo'
      : history?.state === 'incomplete'
        ? 'Plano incompleto'
        : 'Plano em elaboração'
    : history?.state === 'saved'
      ? 'Parecer salvo'
      : history?.state === 'incomplete'
        ? 'Parecer incompleto'
        : 'Parecer em elaboração';

  return <dialog ref={dialogRef} onCancel={event => event.preventDefault()} aria-labelledby="terminal-title" className="terminal-dialog h-[88dvh] max-h-[100dvh] w-[calc(100%-1rem)] max-w-6xl overflow-hidden rounded-xl border border-line-strong bg-terminal p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-elevated px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3"><span className="hidden rounded-lg border border-line p-2 sm:block"><TerminalIcon size={17} className="text-accent" /></span><div className="min-w-0"><h2 id="terminal-title" className="flex items-center gap-2 text-sm font-medium"><TargetIcon size={14} className="shrink-0 text-muted" /><span className="truncate" title={sessionTitle}>{sessionTitle}</span></h2>{repoPath && <p className="mt-1 truncate font-mono text-[10px] text-muted" title={repoPath}>{repoPath}</p>}</div></div>
        <span role="status" className="flex items-center gap-2 text-[11px] text-muted"><span className={`size-1.5 rounded-full ${status === 'running' ? 'bg-accent' : status === 'connecting' ? 'animate-pulse bg-warning' : 'bg-slate-500'}`} />{labels[status]}{exitCode !== undefined && ` · ${exitCode}`}</span>
        <div className="flex flex-wrap gap-2">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button type="button" className="modal-button" onClick={() => void copyOutput()}>{copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? 'Copiado!' : 'Copiar saída'}</span></button>
          <button type="button" className="modal-button" onClick={onMinimize} title="Fechar janela e manter execução em segundo plano"><Minimize2 size={13} /><span>{status === 'exited' ? 'Fechar' : 'Segundo plano'}</span></button>
          {status !== 'exited' && (
            <button type="button" className="modal-button border-danger/20 text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={!effectiveSessionId || stopping} aria-busy={stopping} onClick={() => void handleStopProcess()}><Square size={11} /><span>{stopping ? 'Encerrando...' : 'Encerrar processo'}</span></button>
          )}
        </div>
      </header>
      {error && <div role="alert" className="border-b border-danger/15 bg-danger/5 px-5 py-3 text-xs leading-5 text-danger">{error}</div>}
      {history && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2 text-[11px] leading-5 text-muted" role="status">
        <div className="min-w-0 flex-1">
          <p className="break-all"><span className={history.state === 'saved' ? 'text-accent' : ''}>{savedLabel}:</span> <span className="font-mono">{history.reportPath}</span></p>
          {history.sessionPath && (
            <p className="break-all">Registro automático da sessão: <span className="font-mono">{history.sessionPath}</span></p>
          )}
        </div>
        {history.state === 'saved' && onViewMarkdown && (
          <button type="button" className="modal-button border-accent/40 text-accent hover:bg-selected" onClick={() => onViewMarkdown(history.reportPath)}>
            <FileText size={13} />
            Ver Markdown
          </button>
        )}
      </div>}
      <div className="min-h-0 flex-1 p-3 sm:p-5"><div ref={containerRef} className="h-full w-full overflow-hidden" aria-label="Terminal interativo do Claude Code" /></div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle px-5 py-2.5 text-[10px] text-muted"><span>Claude Code · PTY local · MCPs do ambiente</span><span>Ctrl+C copia seleção ou interrompe · Ctrl+V cola · Esc controla a TUI</span></footer>
    </div>
  </dialog>;
}
