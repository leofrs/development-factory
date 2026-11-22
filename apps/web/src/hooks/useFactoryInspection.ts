import { useEffect, useState } from 'react';

type InspectionResult<T> = { data: T } | { error: string };

export function useFactoryInspection<T>(
  request: (signal: AbortSignal) => Promise<T>,
  revision?: string,
) {
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{
    request: typeof request;
    attempt: number;
    revision?: string;
    result: InspectionResult<T>;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request(controller.signal)
      .then(data => {
        if (!controller.signal.aborted) {
          setResponse({ request, attempt, revision, result: { data } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error
            ? error.message
            : 'Não foi possível carregar a comparação do fluxo.';
          setResponse({ request, attempt, revision, result: { error: message } });
        }
      });
    return () => controller.abort();
  }, [request, attempt, revision]);

  return {
    result: response?.request === request && response.attempt === attempt && response.revision === revision
      ? response.result
      : null,
    reload: () => setAttempt(value => value + 1),
  };
}
