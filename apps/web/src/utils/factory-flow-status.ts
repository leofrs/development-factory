import type {
  FactoryFlow,
  FactoryFlowState,
  FactoryStageName,
} from '@development-factory/shared';
import type { SessionStatusPresentation } from './session-status';

const STAGE_LABELS: Record<FactoryStageName, string> = {
  triage: 'Triagem',
  planning: 'Planejamento',
  development: 'Desenvolvimento',
  tests: 'Testes',
  review: 'Code Review',
  pr: 'PR',
};

const STAGE_STEPS: Record<FactoryStageName, string> = {
  triage: '01',
  planning: '02',
  development: '03',
  tests: '04',
  review: '05',
  pr: '06',
};

/** Retorna o nome legível de uma etapa do ciclo da Factory. */
export function getFactoryStageLabel(stage: FactoryStageName): string {
  return STAGE_LABELS[stage];
}

/** Retorna o número formatado da etapa (`01` a `06`). */
export function getFactoryStageStep(stage: FactoryStageName): string {
  return STAGE_STEPS[stage];
}

/** Indica se um fluxo da Factory está em execução ativa ou na fila. */
export function isFactoryFlowActivelyRunning(flow: Pick<FactoryFlow, 'state'>): boolean {
  return flow.state === 'running' || flow.state === 'queued';
}

/** Resolve rótulo e classes visuais para o estado atual de um fluxo da Factory. */
export function getFactoryFlowStatePresentation(
  state: FactoryFlowState,
): SessionStatusPresentation {
  switch (state) {
    case 'queued':
      return {
        label: 'Na fila',
        dotClass: 'bg-accent/70',
        textClass: 'text-accent',
      };
    case 'running':
      return {
        label: 'Em execução',
        dotClass: 'bg-accent animate-pulse',
        textClass: 'text-accent',
      };
    case 'waiting_action':
      return {
        label: 'Aguardando ação',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
    case 'completed':
      return {
        label: 'Concluído',
        dotClass: 'bg-accent',
        textClass: 'text-accent',
      };
    case 'failed':
      return {
        label: 'Falhou',
        dotClass: 'bg-danger',
        textClass: 'text-danger',
      };
    case 'cancelled':
      return {
        label: 'Cancelado',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
  }
}
