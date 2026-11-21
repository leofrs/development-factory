import type { FactoryRepositoryProfile } from '@development-factory/shared';
import { formatFactoryRepositoryContext } from './factory-repository-context.js';
import { formatFactoryStageOutput } from './factory-stage-output.js';

const PR_SIDECAR_FIELDS = `- Use \`title\` e \`summary\` para os textos do título do PR e do resumo das alterações no Markdown.
- Preencha \`baseBranch\` e \`headBranch\` com os nomes válidos das branches Git de destino e de origem,
  respectivamente. Confirme os mesmos nomes em Dados do Pull Request no Markdown.
- Liste em \`satisfiedAcceptanceCriteriaIds\` os IDs de critérios de aceite comprovadamente atendidos,
  conforme a triagem e as validações citadas no Markdown.
- Liste em \`evidence\` os textos das evidências verificadas e registradas em Validação e Evidências
  no Markdown.`;

export const PR_SUMMARY_TITLE = 'Resumo do Pull Request';
export const PR_SUMMARY_SECTIONS = {
  summary: 'Resumo das Alterações',
  validation: 'Validação e Evidências',
  prDetails: 'Dados do Pull Request',
} as const;

/**
 * Placeholder do System Prompt operacional da Etapa 06 (PR).
 * Cole o prompt operacional definitivo nesta constante quando desejar.
 */
export const FACTORY_PR_SYSTEM_PROMPT = `
Você é um Engenheiro de Software Sênior responsável pela etapa **PR ('pr')** do pipeline Factory (disparada manualmente após aprovação do Code Review).
Você recebe como entrada:
1. 'specification' (Documento de Entendimento - Triagem)
2. 'plan' (Diagnóstico Técnico + Plano de Implementação - Planejamento)
3. 'implementation_report' (Relatório de Implementação mais recente)
4. 'test_report' (Relatório de Testes mais recente)
5. 'review_report' (Relatório de Code Review aprovado)
6. 'approvedNotes' (Notas opcionais do usuário)

Sua missão é preparar a descrição e os metadados do Pull Request (ou executar os comandos de abertura configurados no ambiente) e gerar o artefato 'pr_summary'.

### Regras de Execução (Placeholder):
1. Revise o diff atual (\`git status\`, \`git diff\`, \`git log\`) e os relatórios aprovados.
2. Consolide título, contexto, resumo técnico, evidências de testes/review e checklist de entrega.
3. Registre no artefato final os dados do Pull Request preparado ou aberto.
`;

export interface FactoryPrPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly testReportPath: string;
  readonly reviewReportPath: string;
  readonly approvedNotes?: string;
  readonly reportPath: string;
  readonly repositoryProfile?: FactoryRepositoryProfile;
  readonly branchName?: string | null;
  readonly baseBranch?: string | null;
}

/** Constrói o prompt completo da Etapa 06 (PR). */
export function buildFactoryPrPrompt(input: FactoryPrPromptInput): string {
  const template = input.repositoryProfile?.prTemplate;
  const templateInstruction = template
    ? `Use este template de PR, representado em JSON, para estruturar o corpo da descrição.
Preencha o template com os dados verificados e inclua a descrição em Dados do Pull Request.
Preserve o título e as seções obrigatórias do arquivo de resumo.

${JSON.stringify(template)}`
    : 'Sem template de PR configurado, organize a descrição com as seções padrão do resumo.';
  const baseBranch = input.baseBranch ?? input.repositoryProfile?.baseBranch;
  const targetBranch = baseBranch === 'HEAD' ? undefined : baseBranch;

  return `Etapa 06 — PR

${FACTORY_PR_SYSTEM_PROMPT}

${formatFactoryRepositoryContext(input.repositoryProfile)}

${templateInstruction}

Leia todos os artefatos aprovados completos e inspecione o estado atual do repositório antes de preparar o Pull Request.
Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Relatório de Testes da Etapa 04 (test_report): ${JSON.stringify(input.testReportPath)}
- Relatório de Code Review da Etapa 05 (review_report): ${JSON.stringify(input.reviewReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}
- Branch de origem — ${JSON.stringify(input.branchName ?? 'Confirme no repositório')}
- Branch de destino — ${JSON.stringify(targetBranch ?? 'Confirme no repositório')}

${formatFactoryStageOutput('pr', input.reportPath, PR_SIDECAR_FIELDS)}

Use o título e preencha todas as seções do relatório Markdown abaixo.

# ${PR_SUMMARY_TITLE}

## ${PR_SUMMARY_SECTIONS.summary}
Descreva o contexto da tarefa, as alterações entregues e os principais pontos técnicos.

## ${PR_SUMMARY_SECTIONS.validation}
Informe os resultados consolidados dos testes e do Code Review aprovado com os IDs dos critérios de aceite atendidos e as evidências correspondentes.

## ${PR_SUMMARY_SECTIONS.prDetails}
Registre branch de origem/destino, título sugerido ou criado e link/status do Pull Request.`;
}
