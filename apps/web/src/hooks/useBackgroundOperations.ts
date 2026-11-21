import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdvanceFactoryStageRequest,
  AppEvent,
  BackgroundSessionHistoryState,
  BackgroundSessionMode,
  BackgroundSessionStatus,
  BackgroundSessionSummary,
  CancelFactoryFlowRequest,
  CreateFactoryFlowRequest,
  FactoryFlow,
  FactoryRequest,
  FactoryStageName,
  RerunFactoryStageRequest,
  ReturnFactoryStageRequest,
  ReviewRequest,
} from '@development-factory/shared';
import {
  advanceFactoryFlowStage,
  cancelFactoryFlow,
  createFactoryFlow,
  fetchFactoryFlows,
  rerunFactoryFlowStage,
  returnFactoryFlowStage,
  type AdvanceFactoryFlowResult,
  type CreateFactoryFlowResult,
  type RerunFactoryFlowResult,
} from '../api/factory-flows';
import {
  fetchSessions,
  getEventsStreamUrl,
  parseAppEventMessage,
  stopSessionRequest,
} from '../api/sessions';
import { getFactoryStageLabel } from '../utils/factory-flow-status';

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
  sessionId: string | null;
  flowId?: string | null;
  stage?: FactoryStageName | null;
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
  factoryFlows: FactoryFlow[];
  factoryFlowsById: ReadonlyMap<string, FactoryFlow>;
  activeTerminalSession: ActiveTerminalSession | null;
  notifications: AppNotification[];
  loadingSessions: boolean;
  sessionsError: string | null;
  loadingFactoryFlows: boolean;
  factoryFlowsError: string | null;
  startReview: (request: ReviewRequest) => void;
  startFactory: (request: FactoryRequest) => void;
  createFlow: (request: CreateFactoryFlowRequest) => Promise<CreateFactoryFlowResult>;
  advanceFlowStage: (
    flowId: string,
    request?: AdvanceFactoryStageRequest,
  ) => Promise<AdvanceFactoryFlowResult>;
  rerunFlowStage: (
    flowId: string,
    request?: RerunFactoryStageRequest,
  ) => Promise<RerunFactoryFlowResult>;
  returnFlowStage: (
    flowId: string,
    request: ReturnFactoryStageRequest,
  ) => Promise<AdvanceFactoryFlowResult>;
  cancelFlow: (flowId: string, request?: CancelFactoryFlowRequest) => Promise<FactoryFlow>;
  openTerminal: (sessionId: string) => void;
  openFlowTerminal: (flowId: string) => boolean;
  minimizeTerminal: () => void;
  bindActiveSessionId: (sessionId: string) => void;
  stopSession: (sessionId: string) => Promise<BackgroundSessionSummary>;
  refreshSessions: () => Promise<void>;
  refreshFactoryFlows: () => Promise<void>;
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

function sortFactoryFlowsByRecent(flowsMap: ReadonlyMap<string, FactoryFlow>): FactoryFlow[] {
  return Array.from(flowsMap.values()).sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

const REPORT_STAGE_NOTIFICATION_LABELS: Partial<
  Record<
    FactoryStageName,
    {
      readonly saved: string;
      readonly completed: string;
    }
  >
> = {
  development: {
    saved: 'Relatório de implementação salvo',
    completed: 'Desenvolvimento concluído',
  },
  tests: {
    saved: 'Relatório de testes salvo',
    completed: 'Testes concluídos',
  },
  review: {
    saved: 'Relatório de code review salvo',
    completed: 'Code review concluído',
  },
  pr: {
    saved: 'Resumo do PR salvo',
    completed: 'Etapa PR concluída',
  },
};

export function buildNotification(
  session: BackgroundSessionSummary,
  kind: 'history_saved' | 'finished',
): AppNotification {
  const id = `${session.sessionId}:${kind}`;
  const reportPath =
    session.mode === 'factory' || session.historyState === 'saved'
      ? (session.reportPath ?? null)
      : null;
  const flowId = session.flowId ?? null;
  const stage = session.stage ?? null;
  const reportLabels =
    session.mode === 'factory' && stage ? REPORT_STAGE_NOTIFICATION_LABELS[stage] : undefined;

  if (kind === 'history_saved') {
    const message =
      session.mode === 'factory'
        ? (reportLabels?.saved ?? 'Plano salvo')
        : 'Parecer salvo';
    return {
      id,
      sessionId: session.sessionId,
      flowId,
      stage,
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
      flowId,
      stage,
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
      flowId,
      stage,
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
      flowId,
      stage,
      mode: session.mode,
      title: session.title,
      kind,
      status: session.status,
      historyState: session.historyState,
      reportPath,
      message:
        session.mode === 'factory'
          ? reportLabels
            ? 'Relatório incompleto'
            : 'Plano incompleto'
          : 'Parecer incompleto',
      severity: 'warning',
      createdAt: session.finishedAt ?? new Date().toISOString(),
    };
  }

  return {
    id,
    sessionId: session.sessionId,
    flowId,
    stage,
    mode: session.mode,
    title: session.title,
    kind,
    status: session.status,
    historyState: session.historyState,
    reportPath,
    message:
      session.mode === 'factory'
        ? (reportLabels?.completed ?? 'Plano salvo')
        : 'Parecer salvo',
    severity: 'success',
    createdAt: session.finishedAt ?? new Date().toISOString(),
  };
}

function buildFlowNotification(
  flow: FactoryFlow,
  linkedSession?: BackgroundSessionSummary,
): AppNotification {
  const stageLabel = getFactoryStageLabel(flow.currentStage);

  if (flow.state === 'failed') {
    return {
      id: `flow:${flow.id}:finished`,
      sessionId: linkedSession?.sessionId ?? flow.currentSessionId,
      flowId: flow.id,
      stage: flow.currentStage,
      mode: 'factory',
      title: flow.title,
      kind: 'finished',
      status: 'failed',
      historyState: linkedSession?.historyState ?? 'incomplete',
      reportPath: linkedSession?.reportPath ?? null,
      message: `Falha na etapa ${stageLabel}`,
      severity: 'error',
      createdAt: flow.finishedAt ?? flow.updatedAt,
    };
  }

  if (flow.state === 'cancelled') {
    return {
      id: `flow:${flow.id}:finished`,
      sessionId: linkedSession?.sessionId ?? flow.currentSessionId,
      flowId: flow.id,
      stage: flow.currentStage,
      mode: 'factory',
      title: flow.title,
      kind: 'finished',
      status: 'cancelled',
      historyState: linkedSession?.historyState ?? 'incomplete',
      reportPath: linkedSession?.reportPath ?? null,
      message: 'Fluxo cancelado',
      severity: 'warning',
      createdAt: flow.finishedAt ?? flow.updatedAt,
    };
  }

  return {
    id: `flow:${flow.id}:finished`,
    sessionId: linkedSession?.sessionId ?? flow.currentSessionId,
    flowId: flow.id,
    stage: flow.currentStage,
    mode: 'factory',
    title: flow.title,
    kind: 'finished',
    status: 'exited',
    historyState: linkedSession?.historyState ?? 'saved',
    reportPath: linkedSession?.reportPath ?? null,
    message: `Fluxo concluído (${stageLabel})`,
    severity: 'success',
    createdAt: flow.finishedAt ?? flow.updatedAt,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Gerencia o estado global das operações em background (sessões e fluxos da Factory),
 * stream SSE de eventos, sessão ativa no TerminalModal e fila de notificações in-app.
 */
export function useBackgroundOperations(): BackgroundOperationsState {
  const [sessionsMap, setSessionsMap] = useState<Map<string, BackgroundSessionSummary>>(
    () => new Map(),
  );
  const [factoryFlowsMap, setFactoryFlowsMap] = useState<Map<string, FactoryFlow>>(
    () => new Map(),
  );
  const [activeTerminalSession, setActiveTerminalSession] =
    useState<ActiveTerminalSession | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [loadingFactoryFlows, setLoadingFactoryFlows] = useState(true);
  const [factoryFlowsError, setFactoryFlowsError] = useState<string | null>(null);

  const sessionsMapRef = useRef(sessionsMap);
  useEffect(() => {
    sessionsMapRef.current = sessionsMap;
  }, [sessionsMap]);

  const factoryFlowsMapRef = useRef(factoryFlowsMap);
  useEffect(() => {
    factoryFlowsMapRef.current = factoryFlowsMap;
  }, [factoryFlowsMap]);

  const activeTerminalRef = useRef(activeTerminalSession);
  useEffect(() => {
    activeTerminalRef.current = activeTerminalSession;
  }, [activeTerminalSession]);

  const notifiedMilestonesRef = useRef<Set<string>>(new Set());

  const upsertSession = useCallback((session: BackgroundSessionSummary) => {
    setSessionsMap((current) => {
      const next = new Map(current);
      next.set(session.sessionId, session);
      sessionsMapRef.current = next;
      return next;
    });
  }, []);

  const upsertFactoryFlow = useCallback((flow: FactoryFlow) => {
    setFactoryFlowsMap((current) => {
      const next = new Map(current);
      next.set(flow.id, flow);
      factoryFlowsMapRef.current = next;
      return next;
    });
  }, []);

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
      sessionsMapRef.current = next;
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

  const hydrateFactoryFlows = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchFactoryFlows(undefined, signal);
      if (signal?.aborted) {
        return;
      }

      const next = new Map<string, FactoryFlow>();
      for (const item of list) {
        next.set(item.id, item);
      }
      factoryFlowsMapRef.current = next;
      setFactoryFlowsMap(next);
      setFactoryFlowsError(null);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        return;
      }
      setFactoryFlowsError(
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar os fluxos da Factory.',
      );
    } finally {
      if (!signal?.aborted) {
        setLoadingFactoryFlows(false);
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

  const maybeNotifyFlowFinished = useCallback((flow: FactoryFlow) => {
    const flowMilestoneKey = `flow:${flow.id}:finished`;
    if (notifiedMilestonesRef.current.has(flowMilestoneKey)) {
      return;
    }

    if (
      flow.currentSessionId &&
      (notifiedMilestonesRef.current.has(`${flow.currentSessionId}:finished`) ||
        activeTerminalRef.current?.sessionId === flow.currentSessionId)
    ) {
      notifiedMilestonesRef.current.add(flowMilestoneKey);
      return;
    }

    notifiedMilestonesRef.current.add(flowMilestoneKey);
    const linkedSession = flow.currentSessionId
      ? sessionsMapRef.current.get(flow.currentSessionId)
      : undefined;
    const notification = buildFlowNotification(flow, linkedSession);
    setNotifications((current) => [notification, ...current]);
  }, []);

  const maybeNotifyFlowAttention = useCallback((flow: FactoryFlow) => {
    if (flow.state !== 'waiting_action') {
      return;
    }

    if (flow.loopPausedReason) {
      const milestoneKey = `flow:${flow.id}:loop_paused:${flow.iteration}:${flow.updatedAt}`;
      if (notifiedMilestonesRef.current.has(milestoneKey)) {
        return;
      }
      notifiedMilestonesRef.current.add(milestoneKey);
      setNotifications((current) => [
        {
          id: milestoneKey,
          sessionId: null,
          flowId: flow.id,
          stage: flow.currentStage,
          mode: 'factory',
          title: flow.title,
          kind: 'finished',
          status: 'exited',
          historyState: 'saved',
          reportPath: null,
          message: flow.loopPausedReason ?? 'Loop automático pausado para intervenção humana',
          severity: 'warning',
          createdAt: flow.updatedAt,
        },
        ...current,
      ]);
      return;
    }

    if (flow.currentStage === 'pr') {
      const milestoneKey = `flow:${flow.id}:ready_for_pr:${flow.updatedAt}`;
      if (notifiedMilestonesRef.current.has(milestoneKey)) {
        return;
      }
      notifiedMilestonesRef.current.add(milestoneKey);
      setNotifications((current) => [
        {
          id: milestoneKey,
          sessionId: null,
          flowId: flow.id,
          stage: 'pr',
          mode: 'factory',
          title: flow.title,
          kind: 'finished',
          status: 'exited',
          historyState: 'saved',
          reportPath: null,
          message: 'Code Review aprovado; etapa PR pronta para disparo manual',
          severity: 'success',
          createdAt: flow.updatedAt,
        },
        ...current,
      ]);
    }
  }, []);

  const handleAppEvent = useCallback(
    (event: AppEvent) => {
      if (
        event.type === 'factory_flow.created' ||
        event.type === 'factory_flow.updated' ||
        event.type === 'factory_flow.finished'
      ) {
        upsertFactoryFlow(event.flow);
        if (event.type === 'factory_flow.updated') {
          maybeNotifyFlowAttention(event.flow);
        }
        if (event.type === 'factory_flow.finished') {
          maybeNotifyFlowFinished(event.flow);
        }
        return;
      }

      const { session } = event;
      upsertSession(session);

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
    [maybeNotify, maybeNotifyFlowAttention, maybeNotifyFlowFinished, upsertFactoryFlow, upsertSession],
  );

  useEffect(() => {
    const abortController = new AbortController();
    void hydrateSessions(abortController.signal);
    void hydrateFactoryFlows(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [hydrateFactoryFlows, hydrateSessions]);

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
          void hydrateFactoryFlows(reconnectAbortController.signal);
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
  }, [handleAppEvent, hydrateFactoryFlows, hydrateSessions]);

  const startReview = useCallback((request: ReviewRequest) => {
    setActiveTerminalSession({ mode: 'review', request });
  }, []);

  const startFactory = useCallback((request: FactoryRequest) => {
    setActiveTerminalSession({ mode: 'factory', request });
  }, []);

  const createFlow = useCallback(
    async (request: CreateFactoryFlowRequest): Promise<CreateFactoryFlowResult> => {
      const result = await createFactoryFlow(request);
      upsertFactoryFlow(result.flow);
      if (result.session) {
        upsertSession(result.session);
      }
      return result;
    },
    [upsertFactoryFlow, upsertSession],
  );

  const advanceFlowStage = useCallback(
    async (
      flowId: string,
      request?: AdvanceFactoryStageRequest,
    ): Promise<AdvanceFactoryFlowResult> => {
      const result = await advanceFactoryFlowStage(flowId, request);
      upsertFactoryFlow(result.flow);
      if (result.session) {
        upsertSession(result.session);
      }
      return result;
    },
    [upsertFactoryFlow, upsertSession],
  );

  const rerunFlowStage = useCallback(
    async (
      flowId: string,
      request?: RerunFactoryStageRequest,
    ): Promise<RerunFactoryFlowResult> => {
      const result = await rerunFactoryFlowStage(flowId, request);
      upsertFactoryFlow(result.flow);
      upsertSession(result.session);
      return result;
    },
    [upsertFactoryFlow, upsertSession],
  );

  const returnFlowStage = useCallback(
    async (
      flowId: string,
      request: ReturnFactoryStageRequest,
    ): Promise<AdvanceFactoryFlowResult> => {
      const result = await returnFactoryFlowStage(flowId, request);
      upsertFactoryFlow(result.flow);
      if (result.session) {
        upsertSession(result.session);
      }
      return result;
    },
    [upsertFactoryFlow, upsertSession],
  );

  const cancelFlow = useCallback(
    async (flowId: string, request?: CancelFactoryFlowRequest): Promise<FactoryFlow> => {
      const updated = await cancelFactoryFlow(flowId, request);
      upsertFactoryFlow(updated);
      return updated;
    },
    [upsertFactoryFlow],
  );

  const openTerminal = useCallback((sessionId: string) => {
    const existing = sessionsMapRef.current.get(sessionId);
    if (!existing) {
      return;
    }
    setActiveTerminalSession({ mode: existing.mode, sessionId: existing.sessionId });
  }, []);

  const openFlowTerminal = useCallback(
    (flowId: string): boolean => {
      const flow = factoryFlowsMapRef.current.get(flowId);
      if (flow?.currentSessionId && sessionsMapRef.current.has(flow.currentSessionId)) {
        openTerminal(flow.currentSessionId);
        return true;
      }

      const matchingSession = sortSessionsByRecent(sessionsMapRef.current).find(
        (item) => item.flowId === flowId,
      );
      if (!matchingSession) {
        return false;
      }

      openTerminal(matchingSession.sessionId);
      return true;
    },
    [openTerminal],
  );

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

  const stopSession = useCallback(
    async (sessionId: string): Promise<BackgroundSessionSummary> => {
      const updated = await stopSessionRequest(sessionId);
      upsertSession(updated);
      return updated;
    },
    [upsertSession],
  );

  const refreshSessions = useCallback(async () => {
    await hydrateSessions();
  }, [hydrateSessions]);

  const refreshFactoryFlows = useCallback(async () => {
    await hydrateFactoryFlows();
  }, [hydrateFactoryFlows]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const sessions = useMemo(() => sortSessionsByRecent(sessionsMap), [sessionsMap]);
  const factoryFlows = useMemo(() => sortFactoryFlowsByRecent(factoryFlowsMap), [factoryFlowsMap]);

  return {
    sessions,
    sessionsById: sessionsMap,
    factoryFlows,
    factoryFlowsById: factoryFlowsMap,
    activeTerminalSession,
    notifications,
    loadingSessions,
    sessionsError,
    loadingFactoryFlows,
    factoryFlowsError,
    startReview,
    startFactory,
    createFlow,
    advanceFlowStage,
    rerunFlowStage,
    returnFlowStage,
    cancelFlow,
    openTerminal,
    openFlowTerminal,
    minimizeTerminal,
    bindActiveSessionId,
    stopSession,
    refreshSessions,
    refreshFactoryFlows,
    dismissNotification,
    clearAllNotifications,
  };
}
