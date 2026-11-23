import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FactoryMetricsPeriod,
  FactoryMetricsResponse,
} from '@development-factory/shared';
import { fetchFactoryMetrics } from '../api/factory-flows.js';

export type FactoryMetricsState =
  | { status: 'loading'; previous?: FactoryMetricsResponse }
  | { status: 'failed'; message: string; previous?: FactoryMetricsResponse }
  | { status: 'loaded'; data: FactoryMetricsResponse };

export interface FactoryMetricsController {
  state: FactoryMetricsState;
  repoPathFilter: string;
  periodFilter: FactoryMetricsPeriod;
  setRepoPathFilter: (repoPath: string) => void;
  setPeriodFilter: (period: FactoryMetricsPeriod) => void;
  refresh: () => void;
}

export function useFactoryMetrics(options: {
  enabled?: boolean;
  refreshKey?: string;
} = {}): FactoryMetricsController {
  const { enabled = true, refreshKey = '' } = options;
  const [repoPathFilter, setRepoPathFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState<FactoryMetricsPeriod>('all');
  const [attempt, setAttempt] = useState(0);

  const request = useMemo(
    () => ({
      repoPath: repoPathFilter,
      period: periodFilter,
      attempt,
      refreshKey,
    }),
    [repoPathFilter, periodFilter, attempt, refreshKey],
  );

  const lastLoadedRef = useRef<FactoryMetricsResponse | undefined>(undefined);
  const [completed, setCompleted] = useState<{
    request: typeof request;
    state: Exclude<FactoryMetricsState, { status: 'loading' }>;
  }>();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    fetchFactoryMetrics(
      {
        period: request.period,
        ...(request.repoPath ? { repoPath: request.repoPath } : {}),
      },
      controller.signal,
    )
      .then(data => {
        if (!controller.signal.aborted) {
          lastLoadedRef.current = data;
          setCompleted({ request, state: { status: 'loaded', data } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message =
            error instanceof Error
              ? error.message
              : 'Não foi possível carregar as métricas da Factory.';
          setCompleted({
            request,
            state: {
              status: 'failed',
              message,
              ...(lastLoadedRef.current ? { previous: lastLoadedRef.current } : {}),
            },
          });
        }
      });

    return () => controller.abort();
  }, [enabled, request]);

  const refresh = useCallback(() => {
    setAttempt(current => current + 1);
  }, []);

  const state: FactoryMetricsState =
    completed?.request === request
      ? completed.state
      : {
          status: 'loading',
          ...(lastLoadedRef.current ? { previous: lastLoadedRef.current } : {}),
        };

  return {
    state,
    repoPathFilter,
    periodFilter,
    setRepoPathFilter,
    setPeriodFilter,
    refresh,
  };
}
