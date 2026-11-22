import { writeFileSync } from 'node:fs';
import { FACTORY_STAGE_SIDECAR_CONTRACT_VERSION } from '@development-factory/shared';
import type {
  FactoryDevelopmentSidecar,
  FactoryPlanningSidecar,
  FactoryPrSidecar,
  FactoryReviewSidecar,
  FactoryStageName,
  FactoryTestsSidecar,
  FactoryTriageSidecar,
} from '@development-factory/shared';
import { getFactoryStageSidecarPath } from '../../src/factory-stage-runners.js';

interface Sidecars {
  triage: FactoryTriageSidecar;
  planning: FactoryPlanningSidecar;
  development: FactoryDevelopmentSidecar;
  tests: FactoryTestsSidecar;
  review: FactoryReviewSidecar;
  pr: FactoryPrSidecar;
}

const contractVersion = FACTORY_STAGE_SIDECAR_CONTRACT_VERSION;
export const sidecarFixtures: Sidecars = {
  triage: {
    contractVersion,
    stage: 'triage',
    acceptanceCriteria: [{ id: 'CA1', description: 'Validar o comportamento esperado.' }],
    negativeScope: [],
    blockers: [],
    jiraContext: null,
    technicalContext: 'Investigar o código do fluxo.',
  },
  planning: {
    contractVersion,
    stage: 'planning',
    pendingDecisions: [],
    plannedFiles: ['src/feature.ts'],
    testPlan: ['Validar CA1.'],
  },
  development: {
    contractVersion,
    stage: 'development',
    changedFiles: ['src/feature.ts'],
    summary: 'Alteração implementada.',
    deviations: [],
  },
  tests: {
    contractVersion,
    stage: 'tests',
    executedCommands: [{ command: ['npm', 'test'], exitCode: 0 }],
    testCases: [],
    status: 'passed',
    coverage: null,
  },
  review: {
    contractVersion,
    stage: 'review',
    verdict: 'approved',
    returnTarget: null,
    findings: [],
  },
  pr: {
    contractVersion,
    stage: 'pr',
    title: 'Implementar alteração',
    summary: 'Alteração implementada e validada.',
    baseBranch: 'main',
    headBranch: 'factory/feature',
    satisfiedAcceptanceCriteriaIds: ['CA1'],
    evidence: ['Testes e revisão aprovados.'],
  },
};

export function writeFactoryStageSidecar<Stage extends FactoryStageName>(
  reportPath: string,
  stage: Stage,
  fields?: Partial<Sidecars[Stage]>,
): void {
  const payload = { ...sidecarFixtures[stage], ...fields };
  writeFileSync(getFactoryStageSidecarPath(reportPath), JSON.stringify(payload));
}

export function triageMarkdown(summary: string): string {
  return [
    '# Documento de Entendimento do Problema',
    '#### 1. Síntese Central (Core)',
    summary,
    '#### 2. Detalhamento do Cenário (Causa e Expectativa)',
    'O comportamento deve atender ao escopo da tarefa.',
    '#### 3. Critérios de Aceite',
    '- CA1: Validar o comportamento esperado.',
    '#### 4. Escopo Negativo (Fora do Escopo)',
    'Sem itens adicionais.',
    '#### 5. Pistas Técnicas Citadas na Task',
    'Investigar o código do fluxo.',
    '',
  ].join('\n');
}

export function planningMarkdown(diagnosis: string): string {
  return [
    '# Diagnóstico Técnico + Plano de Implementação',
    `1. **Diagnóstico Técnico:** ${diagnosis}`,
    '2. **Decisões de Design & Contratos:** Preservar as integrações existentes.',
    '3. **Plano de Alterações (Arquivo por Arquivo):** Alterar src/feature.ts.',
    '4. **Cuidados de Regressão:** Validar o fluxo anterior.',
    '5. **Plano de Testes**. Validar CA1.',
    '',
  ].join('\n');
}
