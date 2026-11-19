import type { BackgroundSessionSummary } from '@development-factory/shared';

/** Apresentação visual de status para uma operação em background. */
export interface SessionStatusPresentation {
  label: string;
  dotClass: string;
  textClass: string;
}

type SessionStatusInput = Pick<BackgroundSessionSummary, 'mode' | 'status' | 'historyState'>;

/**
 * Indica se a operação ainda está executando a geração do parecer ou plano.
 * Sessões com o artefato já salvo permanecem com o PTY aberto, mas não contam
 * mais como tarefa em andamento nos indicadores de execução.
 */
export function isSessionActivelyRunning(
  session: Pick<BackgroundSessionSummary, 'status' | 'historyState'>,
): boolean {
  return session.status === 'running' && session.historyState !== 'saved';
}

/**
 * Resolve o rótulo e as classes visuais de acordo com a etapa atual da execução
 * (em execução, artefato salvo, concluída, incompleta, falha ou cancelada).
 */
export function getSessionStatusPresentation(
  session: SessionStatusInput,
): SessionStatusPresentation {
  const isFactory = session.mode === 'factory';

  if (session.status === 'failed') {
    return {
      label: 'Falhou',
      dotClass: 'bg-danger',
      textClass: 'text-danger',
    };
  }

  if (session.status === 'cancelled') {
    return {
      label: 'Cancelada',
      dotClass: 'bg-warning',
      textClass: 'text-warning',
    };
  }

  if (session.status === 'running') {
    if (session.historyState === 'saved') {
      return {
        label: isFactory ? 'Plano salvo' : 'Parecer salvo',
        dotClass: 'bg-accent',
        textClass: 'text-accent',
      };
    }

    if (session.historyState === 'incomplete') {
      return {
        label: isFactory ? 'Plano incompleto' : 'Parecer incompleto',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
    }

    return {
      label: 'Em execução',
      dotClass: 'bg-accent animate-pulse',
      textClass: 'text-accent',
    };
  }

  if (session.historyState === 'saved') {
    return {
      label: 'Concluída',
      dotClass: 'bg-accent',
      textClass: 'text-accent',
    };
  }

  return {
    label: isFactory ? 'Plano incompleto' : 'Parecer incompleto',
    dotClass: 'bg-warning',
    textClass: 'text-warning',
  };
}
