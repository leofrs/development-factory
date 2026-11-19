import {
  AppEventSchema,
  BackgroundSessionSummarySchema,
  type AppEvent,
  type BackgroundSessionSummary,
} from '@development-factory/shared';

const API_BASE_URL = 'http://127.0.0.1:3001';

/** Erro tipado retornado pela API de sessões em background. */
export class SessionApiError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'SESSION_API_ERROR', statusCode = 500) {
    super(message);
    this.name = 'SessionApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SessionApiError(
      'Resposta inválida recebida do servidor.',
      'SESSION_INVALID_RESPONSE',
      response.status,
    );
  }
}

function extractApiError(payload: unknown, statusCode: number, fallbackMessage: string): SessionApiError {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    const code = typeof payload.error.code === 'string' ? payload.error.code : 'SESSION_API_ERROR';
    return new SessionApiError(payload.error.message, code, statusCode);
  }
  return new SessionApiError(fallbackMessage, 'SESSION_API_ERROR', statusCode);
}

function toSessionRequestError(error: unknown, fallbackMessage: string): SessionApiError {
  if (error instanceof SessionApiError) {
    return error;
  }
  if (error instanceof TypeError) {
    return new SessionApiError(
      'Não foi possível conectar ao WSL. Verifique se o backend está em execução.',
      'SESSION_NETWORK_ERROR',
      0,
    );
  }
  if (error instanceof Error) {
    return new SessionApiError(error.message, 'SESSION_API_ERROR', 500);
  }
  return new SessionApiError(fallbackMessage, 'SESSION_API_ERROR', 500);
}

/** Retorna a URL do stream SSE de eventos globais de sessão. */
export function getEventsStreamUrl(): string {
  return `${API_BASE_URL}/api/events`;
}

/** Faz o parse e a validação estrita de uma mensagem JSON recebida via SSE. */
export function parseAppEventMessage(rawData: string): AppEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawData);
  } catch {
    return null;
  }

  const parsed = AppEventSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/** Busca todas as sessões em andamento e recentes no backend. */
export async function fetchSessions(signal?: AbortSignal): Promise<BackgroundSessionSummary[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sessions`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível listar as sessões.');
    }

    if (!isRecord(payload)) {
      throw new SessionApiError(
        'Formato inesperado ao listar as sessões.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsed = BackgroundSessionSummarySchema.array().safeParse(payload.sessions);
    if (!parsed.success) {
      throw new SessionApiError(
        'Formato inesperado ao listar as sessões.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toSessionRequestError(error, 'Não foi possível listar as sessões.');
  }
}

/** Busca os detalhes atualizados de uma sessão específica. */
export async function fetchSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<BackgroundSessionSummary> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível consultar a sessão.');
    }

    if (!isRecord(payload)) {
      throw new SessionApiError(
        'Formato inesperado ao consultar a sessão.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsed = BackgroundSessionSummarySchema.safeParse(payload.session);
    if (!parsed.success) {
      throw new SessionApiError(
        'Formato inesperado ao consultar a sessão.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toSessionRequestError(error, 'Não foi possível consultar a sessão.');
  }
}

/** Solicita o encerramento explícito de uma sessão em background. */
export async function stopSessionRequest(
  sessionId: string,
  signal?: AbortSignal,
): Promise<BackgroundSessionSummary> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: 'POST',
        cache: 'no-store',
        signal,
      },
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível encerrar a sessão.');
    }

    if (!isRecord(payload)) {
      throw new SessionApiError(
        'Formato inesperado ao encerrar a sessão.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsed = BackgroundSessionSummarySchema.safeParse(payload.session);
    if (!parsed.success) {
      throw new SessionApiError(
        'Formato inesperado ao encerrar a sessão.',
        'SESSION_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toSessionRequestError(error, 'Não foi possível encerrar a sessão.');
  }
}
