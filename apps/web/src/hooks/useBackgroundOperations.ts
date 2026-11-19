import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppEvent,
  BackgroundSessionHistoryState,
  BackgroundSessionMode,
  BackgroundSessionStatus,
  BackgroundSessionSummary,
  FactoryRequest,
  ReviewRequest,
} from '@development-factory/shared';
import {
  fetchSessions,
  getEventsStreamUrl,
  parseAppEventMessage,
  stopSessionRequest,
} from '../api/sessions';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

/** Sessão atualmente aberta no TerminalModal. */
export type ActiveTerminalSession =
  | { mode: 'review'; request: ReviewRequest; sessionId?: string }
  | { mode: 'factory'; request: FactoryRequest; sessionId?: string }
  | { mode: BackgroundSessionMode; sessionId: string };

/** Notificação in-app gerada por marcos das operações em background. */
export interface AppNotification {
  id: string;
  sessionId: string;
  mode: BackgroundSessionMode;
  title: string;
  kind: 'history_saved' | 'finished';
  status: BackgroundSessionStatus;
  historyState: BackgroundSessionHistoryState;
  reportPath: string | null;
  message: string;
  severity: 'success' | 'warning' | 'error' | 'info';
  createdAt: string;
}

/** Estado e ações expostos por `useBackgroundOperations`. */
export interface BackgroundOperationsState {
  sessions: BackgroundSessionSummary[];
  sessionsById: ReadonlyMap<string, BackgroundSessionSummary>;
  activeTerminalSession: ActiveTerminalSession | null;
  notifications: AppNotification[];
  loadingSessions: boolean;
  sessionsError: string | null;
  startReview: (request: ReviewRequest) => void;
  startFactory: (request: FactoryRequest) => void;
  openTerminal: (sessionId: string) => void;
  minimizeTerminal: () => void;
  bindActiveSessionId: (sessionId: string) => void;
  stopSession: (sessionId: string) => Promise<BackgroundSessionSummary>;
  refreshSessions: () => Promise<void>;
  dismissNotification: (id: string) => void;
  clearAllNotifications: () => void;
}

function sortSessionsByRecent(
  sessionsMap: ReadonlyMap<string, BackgroundSessionSummary>,
): BackgroundSessionSummary[] {
  return Array.from(sessionsMap.values()).sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

function buildNotification(
  session: BackgroundSessionSummary,
  kind: 'history_saved' | 'finished',
): AppNotification {
  const id = `${session.sessionId}:${kind}`;
  const reportPath = session.mode === 'factory' || session.historyState === 'saved' ? session.reportPath ?? null : null;

  if (kind === 'history_saved') {
    const message = session.mode === 'factory' ? 'Plano salvo' : 'Parecer salvo';
    return {
      id,
      sessionId: session.sessionId,
      mode: session.mode,
      title: session.title,
      kind,
      status: session.status,
      historyState: session.historyState,
      reportPath,
      message,
      severity: 'success',
      createdAt: new Date().toISOString(),
    };
  }

  if (session.status === 'failed') {
    return {
      id,
      sessionId: session.sessionId,
      mode: session.mode,
      title: session.title,
      kind,
      status: session.status,
      historyState: session.historyState,
      reportPath,
      message: 'Falha na execução',
      severity: 'error',
      createdAt: session.finishedAt ?? new Date().toISOString(),
    };
  }

  if (session.status === 'cancelled') {
    return {
      id,
      sessionId: session.sessionId,
      mode: session.mode,
      title: session.title,
      kind,
      status: session.status,
      historyState: session.historyState,
      reportPath,
      message: 'Execução cancelada',
      severity: 'warning',
      createdAt: session.finishedAt ?? new Date().toISOString(),
    };
  }

  if (session.historyState !== 'saved') {
    return {
      id,
      sessionId: session.sessionId,
      mode: session.mode,
      title: session.title,
      kind,
      status: session.status,
      historyState: session.historyState,
      reportPath,
      message: session.mode === 'factory' ? 'Plano incompleto' : 'Parecer incompleto',
      severity: 'warning',
      createdAt: session.finishedAt ?? new Date().toISOString(),
    };
  }

  return {
    id,
    sessionId: session.sessionId,
    mode: session.mode,
    title: session.title,
    kind,
    status: session.status,
    historyState: session.historyState,
    reportPath,
    message: session.mode === 'factory' ? 'Plano salvo' : 'Parecer salvo',
    severity: 'success',
    createdAt: session.finishedAt ?? new Date().toISOString(),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Gerencia o estado global das operações em background, stream SSE de eventos,
 * sessão ativa no TerminalModal e fila de notificações in-app.
 */
export function useBackgroundOperations(): BackgroundOperationsState {
  const [sessionsMap, setSessionsMap] = useState<Map<string, BackgroundSessionSummary>>(
    () => new Map(),
  );
  const [activeTerminalSession, setActiveTerminalSession] =
    useState<ActiveTerminalSession | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const sessionsMapRef = useRef(sessionsMap);
  useEffect(() => {
    sessionsMapRef.current = sessionsMap;
  }, [sessionsMap]);

  const activeTerminalRef = useRef(activeTerminalSession);
  useEffect(() => {
    activeTerminalRef.current = activeTerminalSession;
  }, [activeTerminalSession]);

  const notifiedMilestonesRef = useRef<Set<string>>(new Set());

  const hydrateSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchSessions(signal);
      if (signal?.aborted) {
        return;
      }

      const next = new Map<string, BackgroundSessionSummary>();
      for (const item of list) {
        next.set(item.sessionId, item);
      }
      setSessionsMap(next);
      setSessionsError(null);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        return;
      }
      setSessionsError(
        error instanceof Error ? error.message : 'Não foi possível carregar as sessões.',
      );
    } finally {
      if (!signal?.aborted) {
        setLoadingSessions(false);
      }
    }
  }, []);

  const maybeNotify = useCallback(
    (session: BackgroundSessionSummary, kind: 'history_saved' | 'finished') => {
      const milestoneKey = `${session.sessionId}:${kind}`;
      if (notifiedMilestonesRef.current.has(milestoneKey)) {
        return;
      }

      if (activeTerminalRef.current?.sessionId === session.sessionId) {
        return;
      }

      notifiedMilestonesRef.current.add(milestoneKey);
      const notification = buildNotification(session, kind);
      setNotifications((current) => [notification, ...current]);
    },
    [],
  );

  const handleAppEvent = useCallback(
    (event: AppEvent) => {
      if (!('session' in event)) {
        return;
      }
      const { session } = event;
      setSessionsMap((current) => {
        const next = new Map(current);
        next.set(session.sessionId, session);
        return next;
      });

      if (event.type === 'session.started') {
        setActiveTerminalSession((current) => {
          if (
            current &&
            !current.sessionId &&
            'request' in current &&
            current.mode === session.mode &&
            current.request.repoPath === session.repoPath
          ) {
            return { ...current, sessionId: session.sessionId };
          }
          return current;
        });
        return;
      }

      if (event.type === 'session.history_saved') {
        maybeNotify(session, 'history_saved');
        return;
      }

      if (event.type === 'session.finished') {
        maybeNotify(session, 'finished');
      }
    },
    [maybeNotify],
  );

  useEffect(() => {
    const abortController = new AbortController();
    void hydrateSessions(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [hydrateSessions]);

  useEffect(() => {
    let disposed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let hasDisconnected = false;
    let reconnectAbortController: AbortController | null = null;

    const connect = () => {
      if (disposed) {
        return;
      }

      const source = new EventSource(getEventsStreamUrl());
      eventSource = source;

      source.onopen = () => {
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        if (hasDisconnected) {
          hasDisconnected = false;
          reconnectAbortController?.abort();
          reconnectAbortController = new AbortController();
          void hydrateSessions(reconnectAbortController.signal);
        }
      };

      source.onmessage = (messageEvent: MessageEvent<string>) => {
        const appEvent = parseAppEventMessage(messageEvent.data);
        if (appEvent) {
          handleAppEvent(appEvent);
        }
      };

      source.onerror = () => {
        hasDisconnected = true;
        if (source.readyState !== EventSource.CLOSED) {
          return;
        }

        source.close();
        if (disposed) {
          return;
        }

        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimer = setTimeout(() => {
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      reconnectAbortController?.abort();
      eventSource?.close();
    };
  }, [handleAppEvent, hydrateSessions]);

  const startReview = useCallback((request: ReviewRequest) => {
    setActiveTerminalSession({ mode: 'review', request });
  }, []);

  const startFactory = useCallback((request: FactoryRequest) => {
    setActiveTerminalSession({ mode: 'factory', request });
  }, []);

  const openTerminal = useCallback((sessionId: string) => {
    const existing = sessionsMapRef.current.get(sessionId);
    if (!existing) {
      return;
    }
    setActiveTerminalSession({ mode: existing.mode, sessionId: existing.sessionId });
  }, []);

  const minimizeTerminal = useCallback(() => {
    setActiveTerminalSession(null);
  }, []);

  const bindActiveSessionId = useCallback((sessionId: string) => {
    setActiveTerminalSession((current) => {
      if (!current || current.sessionId === sessionId) {
        return current;
      }
      return { ...current, sessionId };
    });
  }, []);

  const stopSession = useCallback(async (sessionId: string): Promise<BackgroundSessionSummary> => {
    const updated = await stopSessionRequest(sessionId);
    setSessionsMap((current) => {
      const next = new Map(current);
      next.set(updated.sessionId, updated);
      return next;
    });
    return updated;
  }, []);

  const refreshSessions = useCallback(async () => {
    await hydrateSessions();
  }, [hydrateSessions]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const sessions = useMemo(() => sortSessionsByRecent(sessionsMap), [sessionsMap]);

  return {
    sessions,
    sessionsById: sessionsMap,
    activeTerminalSession,
    notifications,
    loadingSessions,
    sessionsError,
    startReview,
    startFactory,
    openTerminal,
    minimizeTerminal,
    bindActiveSessionId,
    stopSession,
    refreshSessions,
    dismissNotification,
    clearAllNotifications,
  };
}
