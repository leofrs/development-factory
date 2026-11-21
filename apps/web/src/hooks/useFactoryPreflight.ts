import { useEffect, useMemo, useState } from 'react';
import type { FactoryFlowInputType, FactoryPreflightResponse } from '@development-factory/shared';
import { fetchFactoryPreflight } from '../api/factory-flows.js';

type FactoryPreflightState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'failed'; message: string }
  | { status: 'checked'; result: FactoryPreflightResponse };

export interface FactoryPreflight {
  state: FactoryPreflightState;
  revalidate: () => void;
}

export function useFactoryPreflight(
  repoPath: string,
  inputType: FactoryFlowInputType,
): FactoryPreflight {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(
    () => ({ input: { repoPath, inputType }, attempt }),
    [repoPath, inputType, attempt],
  );
  const [completed, setCompleted] = useState<{
    request: typeof request;
    state: FactoryPreflightState;
  }>();

  useEffect(() => {
    if (!request.input.repoPath) {
      return;
    }

    const controller = new AbortController();
    fetchFactoryPreflight(request.input, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setCompleted({ request, state: { status: 'checked', result } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message =
            error instanceof Error ? error.message : 'Falha ao verificar o ambiente da Factory.';
          setCompleted({ request, state: { status: 'failed', message } });
        }
      });

    return () => controller.abort();
  }, [request]);

  let state: FactoryPreflightState = { status: 'idle' };
  if (repoPath) {
    state = completed?.request === request ? completed.state : { status: 'checking' };
  }
  return { state, revalidate: () => setAttempt(current => current + 1) };
}
