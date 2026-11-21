import {
  BackgroundSessionSummarySchema,
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryFlowDetailsSchema,
  FactoryFlowListResponseSchema,
  FactoryFlowSchema,
  FactoryFlowStageSchema,
  FactoryPreflightResponseSchema,
  RollbackFactoryFlowCheckpointResponseSchema,
  TransitionFactoryFlowResponseSchema,
} from '@development-factory/shared';
import type {
  AdvanceFactoryStageRequest,
  BackgroundSessionSummary,
  CancelFactoryFlowRequest,
  CreateFactoryFlowRequest,
  FactoryFlow,
  FactoryFlowDetails,
  FactoryFlowStage,
  FactoryPreflightRequest,
  FactoryPreflightResponse,
  ListFactoryFlowsFilterInput,
  RerunFactoryStageRequest,
  ReturnFactoryStageRequest,
  RollbackFactoryFlowCheckpointRequest,
  RollbackFactoryFlowCheckpointResponse,
} from '@development-factory/shared';

const API_BASE_URL = 'http://127.0.0.1:3001';

/** Erro tipado retornado pela API de fluxos da Factory. */
export class FactoryFlowApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: string[];

  constructor(
    message: string,
    code = 'FACTORY_FLOW_API_ERROR',
    statusCode = 500,
    details?: string[],
  ) {
    super(message);
    this.name = 'FactoryFlowApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** Resultado da criação de um fluxo da Factory (com sessão opcional iniciada). */
export interface CreateFactoryFlowResult {
  flow: FactoryFlow;
  stages: FactoryFlowStage[];
  replayed: boolean;
  session?: BackgroundSessionSummary;
}

/** Resultado do avanço de etapa de um fluxo da Factory (com sessão opcional iniciada). */
export interface AdvanceFactoryFlowResult {
  flow: FactoryFlow;
  session?: BackgroundSessionSummary;
}

/** Resultado da execução/reexecução de uma etapa de um fluxo da Factory. */
export interface RerunFactoryFlowResult {
  flow: FactoryFlow;
  stages: FactoryFlowStage[];
  session: BackgroundSessionSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FactoryFlowApiError(
      'Resposta inválida recebida do servidor.',
      'FACTORY_FLOW_INVALID_RESPONSE',
      response.status,
    );
  }
}

function extractApiError(
  payload: unknown,
  statusCode: number,
  fallbackMessage: string,
): FactoryFlowApiError {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
    const code =
      typeof payload.error.code === 'string' ? payload.error.code : 'FACTORY_FLOW_API_ERROR';
    const details = Array.isArray(payload.error.details)
      ? payload.error.details.filter((item): item is string => typeof item === 'string')
      : undefined;
    return new FactoryFlowApiError(payload.error.message, code, statusCode, details);
  }
  return new FactoryFlowApiError(fallbackMessage, 'FACTORY_FLOW_API_ERROR', statusCode);
}

function toFactoryFlowRequestError(error: unknown, fallbackMessage: string): FactoryFlowApiError {
  if (error instanceof FactoryFlowApiError) {
    return error;
  }
  if (error instanceof TypeError) {
    return new FactoryFlowApiError(
      'Não foi possível conectar ao WSL. Verifique se o backend está em execução.',
      'FACTORY_FLOW_NETWORK_ERROR',
      0,
    );
  }
  if (error instanceof Error) {
    return new FactoryFlowApiError(error.message, 'FACTORY_FLOW_API_ERROR', 500);
  }
  return new FactoryFlowApiError(fallbackMessage, 'FACTORY_FLOW_API_ERROR', 500);
}

function parseOptionalSession(
  payload: Record<string, unknown>,
  statusCode: number,
  errorMessage: string,
): BackgroundSessionSummary | undefined {
  if (payload.session === undefined) {
    return undefined;
  }
  const parsed = BackgroundSessionSummarySchema.safeParse(payload.session);
  if (!parsed.success) {
    throw new FactoryFlowApiError(errorMessage, 'FACTORY_FLOW_INVALID_RESPONSE', statusCode);
  }
  return parsed.data;
}

export async function fetchFactoryPreflight(
  request: FactoryPreflightRequest,
  signal?: AbortSignal,
): Promise<FactoryPreflightResponse> {
  const fallbackMessage = 'Não foi possível verificar o ambiente da Factory.';
  try {
    const response = await fetch(`${API_BASE_URL}/api/factory/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, fallbackMessage);
    }

    const parsed = FactoryPreflightResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao verificar o ambiente da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, fallbackMessage);
  }
}

/** Lista fluxos da Factory persistidos no backend, com filtros opcionais. */
export async function fetchFactoryFlows(
  filters?: ListFactoryFlowsFilterInput,
  signal?: AbortSignal,
): Promise<FactoryFlow[]> {
  try {
    const params = new URLSearchParams();
    if (filters?.state) {
      params.set('state', filters.state);
    }
    if (filters?.stage) {
      params.set('stage', filters.stage);
    }
    if (filters?.repoPath) {
      params.set('repoPath', filters.repoPath);
    }
    if (filters?.limit !== undefined) {
      params.set('limit', String(filters.limit));
    }

    const query = params.toString();
    const url = `${API_BASE_URL}/api/factory/flows${query ? `?${query}` : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível listar os fluxos da Factory.');
    }

    const parsed = FactoryFlowListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao listar os fluxos da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data.flows;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, 'Não foi possível listar os fluxos da Factory.');
  }
}

/** Consulta os detalhes completos de um fluxo da Factory (etapas e artefatos). */
export async function fetchFactoryFlowDetails(
  flowId: string,
  signal?: AbortSignal,
): Promise<FactoryFlowDetails> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/factory/flows/${encodeURIComponent(flowId)}`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível consultar o fluxo da Factory.');
    }

    const parsed = FactoryFlowDetailsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao consultar o fluxo da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, 'Não foi possível consultar o fluxo da Factory.');
  }
}

/** Cria um novo fluxo da Factory e opcionalmente inicia a sessão da etapa inicial. */
export async function createFactoryFlow(
  request: CreateFactoryFlowRequest,
  signal?: AbortSignal,
): Promise<CreateFactoryFlowResult> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (request.idempotencyKey) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    const response = await fetch(`${API_BASE_URL}/api/factory/flows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível iniciar o fluxo da Factory.');
    }

    if (
      !isRecord(payload) ||
      payload.contractVersion !== FACTORY_FLOW_CONTRACT_VERSION ||
      typeof payload.replayed !== 'boolean'
    ) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao criar o fluxo da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsedFlow = FactoryFlowSchema.safeParse(payload.flow);
    const parsedStages = FactoryFlowStageSchema.array().safeParse(payload.stages);
    if (!parsedFlow.success || !parsedStages.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao criar o fluxo da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    const session = parseOptionalSession(
      payload,
      response.status,
      'Formato inesperado da sessão iniciada para o fluxo.',
    );

    return {
      flow: parsedFlow.data,
      stages: parsedStages.data,
      replayed: payload.replayed,
      ...(session ? { session } : {}),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, 'Não foi possível iniciar o fluxo da Factory.');
  }
}

async function postFlowStageTransition(
  flowId: string,
  action: 'advance' | 'return',
  request: AdvanceFactoryStageRequest | ReturnFactoryStageRequest,
  fallbackError: string,
  invalidFormatError: string,
  signal?: AbortSignal,
): Promise<AdvanceFactoryFlowResult> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/factory/flows/${encodeURIComponent(flowId)}/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal,
      },
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, fallbackError);
    }

    if (!isRecord(payload) || payload.contractVersion !== FACTORY_FLOW_CONTRACT_VERSION) {
      throw new FactoryFlowApiError(
        invalidFormatError,
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsedFlow = FactoryFlowSchema.safeParse(payload.flow);
    if (!parsedFlow.success) {
      throw new FactoryFlowApiError(
        invalidFormatError,
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    const session = parseOptionalSession(
      payload,
      response.status,
      'Formato inesperado da sessão iniciada na etapa.',
    );

    return {
      flow: parsedFlow.data,
      ...(session ? { session } : {}),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, fallbackError);
  }
}

/** Avança um fluxo da Factory para a próxima etapa e opcionalmente inicia sua sessão. */
export function advanceFactoryFlowStage(
  flowId: string,
  request: AdvanceFactoryStageRequest = {},
  signal?: AbortSignal,
): Promise<AdvanceFactoryFlowResult> {
  return postFlowStageTransition(
    flowId,
    'advance',
    request,
    'Não foi possível avançar a etapa do fluxo.',
    'Formato inesperado ao avançar a etapa do fluxo.',
    signal,
  );
}

/** Retorna um fluxo da Factory (ex.: do Code Review para Desenvolvimento ou Testes). */
export function returnFactoryFlowStage(
  flowId: string,
  request: ReturnFactoryStageRequest,
  signal?: AbortSignal,
): Promise<AdvanceFactoryFlowResult> {
  return postFlowStageTransition(
    flowId,
    'return',
    request,
    'Não foi possível retornar a etapa do fluxo.',
    'Formato inesperado ao retornar a etapa do fluxo.',
    signal,
  );
}

/** Inicia ou reexecuta uma etapa específica de um fluxo da Factory em segundo plano. */
export async function rerunFactoryFlowStage(
  flowId: string,
  request: RerunFactoryStageRequest = {},
  signal?: AbortSignal,
): Promise<RerunFactoryFlowResult> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/factory/flows/${encodeURIComponent(flowId)}/rerun`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal,
      },
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível executar a etapa do fluxo.');
    }

    if (!isRecord(payload) || payload.contractVersion !== FACTORY_FLOW_CONTRACT_VERSION) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao executar a etapa do fluxo.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    const parsedFlow = FactoryFlowSchema.safeParse(payload.flow);
    const parsedStages = FactoryFlowStageSchema.array().safeParse(payload.stages);
    const parsedSession = BackgroundSessionSummarySchema.safeParse(payload.session);
    if (!parsedFlow.success || !parsedStages.success || !parsedSession.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao executar a etapa do fluxo.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    return {
      flow: parsedFlow.data,
      stages: parsedStages.data,
      session: parsedSession.data,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, 'Não foi possível executar a etapa do fluxo.');
  }
}

/** Cancela um fluxo da Factory e encerra qualquer sessão em execução associada. */
export async function cancelFactoryFlow(
  flowId: string,
  request: CancelFactoryFlowRequest = {},
  signal?: AbortSignal,
): Promise<FactoryFlow> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/factory/flows/${encodeURIComponent(flowId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal,
      },
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(payload, response.status, 'Não foi possível cancelar o fluxo da Factory.');
    }

    const parsed = TransitionFactoryFlowResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao cancelar o fluxo da Factory.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data.flow;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(error, 'Não foi possível cancelar o fluxo da Factory.');
  }
}

/** Reverte o worktree de um fluxo da Factory para um checkpoint anterior registrado. */
export async function rollbackFactoryFlowCheckpoint(
  flowId: string,
  request: RollbackFactoryFlowCheckpointRequest = {},
  signal?: AbortSignal,
): Promise<RollbackFactoryFlowCheckpointResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/factory/flows/${encodeURIComponent(flowId)}/rollback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal,
      },
    );
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw extractApiError(
        payload,
        response.status,
        'Não foi possível reverter o worktree para o checkpoint anterior.',
      );
    }

    const parsed = RollbackFactoryFlowCheckpointResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FactoryFlowApiError(
        'Formato inesperado ao reverter o worktree do fluxo.',
        'FACTORY_FLOW_INVALID_RESPONSE',
        response.status,
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw toFactoryFlowRequestError(
      error,
      'Não foi possível reverter o worktree para o checkpoint anterior.',
    );
  }
}
