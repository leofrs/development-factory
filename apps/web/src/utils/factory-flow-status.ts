import type {
  FactoryFlow,
  FactoryFlowArtifactKind,
  FactoryFlowArtifactStatus,
  FactoryFlowInputType,
  FactoryFlowState,
  FactoryReviewVerdict,
  FactoryStageName,
  FactoryStageState,
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

const INPUT_TYPE_LABELS: Record<FactoryFlowInputType, string> = {
  jira_url: 'URL JIRA',
  jira_key: 'Chave JIRA',
  title: 'Título',
};

const ARTIFACT_KIND_LABELS: Record<FactoryFlowArtifactKind, string> = {
  plan: 'Plano técnico',
  specification: 'Especificação',
  patch: 'Patch',
  implementation_report: 'Relatório de Implementação',
  test_report: 'Relatório de testes',
  review_report: 'Code Review',
  pr_summary: 'Resumo do PR',
  session_log: 'Log da sessão',
};

/** Indica se a etapa da Factory deve expor atalhos para abrir o terminal. */
export function canOpenTerminalForFactoryStage(_stage: FactoryStageName): boolean {
  return false;
}

/** Retorna o nome legível de uma etapa do ciclo da Factory. */
export function getFactoryStageLabel(stage: FactoryStageName): string {
  return STAGE_LABELS[stage];
}

/** Retorna o número formatado da etapa (`01` a `06`). */
export function getFactoryStageStep(stage: FactoryStageName): string {
  return STAGE_STEPS[stage];
}

/** Retorna o rótulo amigável do tipo de entrada da tarefa. */
export function getFactoryInputTypeLabel(inputType: FactoryFlowInputType): string {
  return INPUT_TYPE_LABELS[inputType];
}

/** Retorna o rótulo amigável do tipo de artefato gerado pelo fluxo. */
export function getFactoryArtifactKindLabel(kind: FactoryFlowArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
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

/** Resolve rótulo e classes visuais para o estado de uma etapa do fluxo. */
export function getFactoryStageStatePresentation(
  state: FactoryStageState,
): SessionStatusPresentation {
  switch (state) {
    case 'pending':
      return {
        label: 'Pendente',
        dotClass: 'bg-muted/60',
        textClass: 'text-muted',
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
        label: 'Concluída',
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
        label: 'Cancelada',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
  }
}

/** Resolve rótulo e classes visuais para o status de um artefato do fluxo. */
export function getFactoryArtifactStatusPresentation(
  status: FactoryFlowArtifactStatus,
): SessionStatusPresentation {
  switch (status) {
    case 'pending':
      return {
        label: 'Pendente',
        dotClass: 'bg-muted/60',
        textClass: 'text-muted',
      };
    case 'ready':
      return {
        label: 'Pronto',
        dotClass: 'bg-accent',
        textClass: 'text-accent',
      };
    case 'incomplete':
      return {
        label: 'Incompleto',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
    case 'failed':
      return {
        label: 'Falhou',
        dotClass: 'bg-danger',
        textClass: 'text-danger',
      };
  }
}

/** Resolve rótulo e classes visuais para o último veredito do Code Review. */
export function getFactoryReviewVerdictPresentation(
  verdict: FactoryReviewVerdict,
): SessionStatusPresentation {
  switch (verdict) {
    case 'approved':
      return {
        label: 'Aprovado para PR',
        dotClass: 'bg-accent',
        textClass: 'text-accent',
      };
    case 'approved_with_warnings':
      return {
        label: 'Aprovado com ressalvas',
        dotClass: 'bg-accent',
        textClass: 'text-accent',
      };
    case 'changes_requested':
      return {
        label: 'Requer ajustes',
        dotClass: 'bg-warning',
        textClass: 'text-warning',
      };
  }
}
