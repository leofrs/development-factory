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
}

/** Constrói o prompt completo da Etapa 06 (PR). */
export function buildFactoryPrPrompt(input: FactoryPrPromptInput): string {
  return `Etapa 06 — PR

${FACTORY_PR_SYSTEM_PROMPT}

Leia todos os artefatos aprovados completos e inspecione o estado atual do repositório antes de preparar o Pull Request.
Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Relatório de Testes da Etapa 04 (test_report): ${JSON.stringify(input.testReportPath)}
- Relatório de Code Review da Etapa 05 (review_report): ${JSON.stringify(input.reviewReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}

Salve o resumo final em Markdown no arquivo ${JSON.stringify(input.reportPath)}.
Substitua o conteúdo inicial, mantenha o título e as seções a seguir e preencha cada seção.

# ${PR_SUMMARY_TITLE}

## ${PR_SUMMARY_SECTIONS.summary}
Descreva o contexto da tarefa, as alterações entregues e os principais pontos técnicos.

## ${PR_SUMMARY_SECTIONS.validation}
Informe os resultados consolidados dos testes e do Code Review aprovado.

## ${PR_SUMMARY_SECTIONS.prDetails}
Registre branch de origem/destino, título sugerido ou criado e link/status do Pull Request.`;
}
