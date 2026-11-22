import type {
  FactoryAcceptanceCriterion,
  FactoryDevelopmentChecks,
  FactoryPlanningApproval,
  FactoryRepositoryProfile,
  FactoryReviewSidecar,
  FactoryReviewTriageScope,
  FactoryTestsSidecar,
  FactoryTriageSidecar,
} from '@development-factory/shared';
import { formatFactoryRepositoryContext } from './factory-repository-context.js';
import { formatFactoryStageOutput } from './factory-stage-output.js';

export type FactoryPrTestResults = Pick<
  FactoryTestsSidecar,
  'status' | 'executedCommands' | 'coverage' | 'testCases' | 'backendChecks'
>;

export type FactoryPrReviewOutcome = Pick<FactoryReviewSidecar, 'verdict' | 'findings'>;

const PR_SIDECAR_FIELDS = `- Use \`title\` para o título do Pull Request no padrão Conventional Commits (\`<tipo>(<escopo opcional>): <descrição concisa>\`), idêntico ao título informado em Dados do Pull Request no Markdown.
- Use \`summary\` para um texto objetivo com o resumo das alterações e do contexto técnico, coerente com Resumo das Alterações no Markdown.
- Preencha \`baseBranch\` e \`headBranch\` com os nomes válidos das branches Git de destino e de origem,
  respectivamente. Confirme os mesmos nomes em Dados do Pull Request no Markdown.
- Liste em \`satisfiedAcceptanceCriteriaIds\` os IDs de critérios de aceite aprovados e comprovadamente atendidos,
  conforme a tabela de Validação e Evidências no Markdown (não inclua critérios excluídos no Portão Humano ou não atendidos).
- Liste em \`evidence\` os textos das evidências verificadas e registradas em Validação e Evidências
  no Markdown (incluindo comandos executados com \`exitCode\` real e métricas de cobertura do Bloco 04).`;

export const PR_SUMMARY_TITLE = 'Resumo do Pull Request';
export const PR_SUMMARY_SECTIONS = {
  summary: 'Resumo das Alterações',
  validation: 'Validação e Evidências',
  prDetails: 'Dados do Pull Request',
} as const;

/** System Prompt operacional definitivo da Etapa 1 do Bloco 06 (Preparação estruturada do PR). */
export const FACTORY_PR_SYSTEM_PROMPT = `
Você é um Engenheiro de Software Sênior responsável pela **Etapa 1 do Bloco 06 — Preparação Estruturada do Pull Request (\`pr\`)** do pipeline Factory (disparada manualmente após aprovação do Code Review).
Você recebe como entrada:
1. \`specification\` (Documento de Entendimento - Bloco 01 / Triagem)
2. \`plan\` (Diagnóstico Técnico + Plano de Implementação - Bloco 02 / Planejamento) e decisões/critérios aprovados no Portão Humano
3. \`implementation_report\` (Relatório de Implementação mais recente - Bloco 03) e verificações determinísticas de \`typecheck\`/\`lint\`
4. \`test_report\` (Relatório de Testes mais recente - Bloco 04) e resultados reais do executor determinístico do backend (\`exitCode\`, comandos, cobertura)
5. \`review_report\` (Relatório de Code Review aprovado - Bloco 05) com eventuais ressalvas e decisões da triagem humana
6. \`approvedNotes\` (Notas opcionais do usuário)

Sua missão é inspecionar o diff real do worktree em modo estritamente somente leitura, consolidar todas as evidências verificadas e gerar o rascunho estruturado do Pull Request no artefato \`pr_summary\` e em seu sidecar JSON.

### Regras de Execução:
1. **Preparação Somente Leitura (Sem Publicação Autônoma):** NÃO edite, crie ou remova arquivos do repositório. NÃO execute \`git add\`, \`git commit\`, \`git push\`, \`gh pr create\` ou qualquer comando que altere o repositório ou publique o Pull Request. A revisão humana e a publicação ocorrem somente na etapa seguinte após confirmação explícita do usuário.
2. **Título no padrão Conventional Commits:** Formate o título do PR como \`<tipo>(<escopo opcional>): <descrição concisa no imperativo>\` (tipos: \`feat\`, \`fix\`, \`refactor\`, \`perf\`, \`docs\`, \`test\`, \`build\`, \`ci\`, \`chore\`, \`style\`, \`revert\`; use \`!\` antes de \`:\` apenas quando houver breaking change), refletindo o escopo real do diff.
3. **Template do Repositório e Estrutura Obrigatória:** Quando \`prTemplate\` estiver configurado em \`.development-factory.json\`, estruture o corpo do PR seguindo o template preenchido com dados verificados. Preserve obrigatoriamente o título \`# ${PR_SUMMARY_TITLE}\` e todas as seções exigidas no \`pr_summary\`.
4. **Tabela de Critérios de Aceite e Evidências Reais do Bloco 04:** Inclua obrigatoriamente uma tabela Markdown de Critérios de Aceite (\`CA1..CAn\`) indicando status e evidência (sinalizando eventual critério marcado como fora do escopo aprovado) e registre literalmente os comandos, \`exitCode\` e cobertura de linhas/branches fornecidos pelo executor determinístico do Bloco 04, sem inventar ou omitir falhas.
5. **Ressalvas e Decisões da Triagem do Review:** Registre o veredito do Code Review, eventuais sugestões/nits não bloqueantes e as decisões da triagem humana do Bloco 05 (correções aplicadas, falsos positivos descartados com justificativa e sugestões adiadas).
`;

export interface FactoryPrPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly testReportPath: string;
  readonly reviewReportPath: string;
  readonly acceptanceCriteria?: readonly FactoryAcceptanceCriterion[];
  readonly jiraContext?: FactoryTriageSidecar['jiraContext'];
  readonly negativeScope?: readonly string[];
  readonly planningApproval?: FactoryPlanningApproval;
  readonly developmentChecks?: FactoryDevelopmentChecks;
  readonly testResults?: FactoryPrTestResults;
  readonly reviewOutcome?: FactoryPrReviewOutcome;
  readonly reviewTriageScope?: FactoryReviewTriageScope;
  readonly approvedNotes?: string;
  readonly reportPath: string;
  readonly repositoryProfile?: FactoryRepositoryProfile;
  readonly branchName?: string | null;
  readonly baseBranch?: string | null;
}

function formatAcceptanceCriteriaContext(input: FactoryPrPromptInput): string {
  const criteria = input.planningApproval?.acceptanceCriteria.length
    ? input.planningApproval.acceptanceCriteria
    : input.acceptanceCriteria?.map(criterion => ({
        id: criterion.id,
        description: criterion.description,
        approved: true,
      }));
  const decisions = input.planningApproval?.decisions ?? [];
  const negativeScope = input.negativeScope ?? [];

  if (!criteria?.length && decisions.length === 0 && negativeScope.length === 0 && !input.jiraContext) {
    return '';
  }

  const payload = {
    ...(input.jiraContext ? { jiraContext: input.jiraContext } : {}),
    ...(criteria ? { acceptanceCriteria: criteria } : {}),
    ...(decisions.length > 0 ? { approvedDecisions: decisions } : {}),
    ...(negativeScope.length > 0 ? { negativeScope } : {}),
  };

  return `

### Critérios de Aceite, Contexto Jira e Decisões Aprovadas (Blocos 01 e 02)
Inclua todos os critérios listados abaixo na tabela de Critérios de Aceite (sinalizando eventuais itens com \`"approved": false\` como fora do escopo aprovado e não os incluindo em \`satisfiedAcceptanceCriteriaIds\`):

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

function formatDeterministicChecksContext(input: FactoryPrPromptInput): string {
  if (!input.testResults && !input.developmentChecks) {
    return '';
  }

  const payload = {
    ...(input.developmentChecks ? { developmentChecks: input.developmentChecks } : {}),
    ...(input.testResults ? { testResults: input.testResults } : {}),
  };

  return `

### Evidências Reais do Executor Determinístico (Blocos 03 e 04)
Use exclusivamente os registros abaixo como fonte oficial para \`exitCode\`, comandos executados, status da suíte e percentuais reais de cobertura (\`linesPercent\` e \`branchesPercent\`):

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

function formatReviewAndTriageContext(input: FactoryPrPromptInput): string {
  if (!input.reviewOutcome && !input.reviewTriageScope) {
    return '';
  }

  const payload = {
    ...(input.reviewOutcome ? { reviewOutcome: input.reviewOutcome } : {}),
    ...(input.reviewTriageScope ? { reviewTriage: input.reviewTriageScope } : {}),
  };

  return `

### Ressalvas do Code Review e Triagem Humana (Bloco 05)
Registre o veredito do Review, eventuais apontamentos não bloqueantes (\`SUGESTÃO\` / \`NIT\`), falsos positivos descartados com justificativa e sugestões adiadas para acompanhamento futuro:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

/** Constrói o prompt completo da Etapa 1 do Bloco 06 (Preparação estruturada do PR). */
export function buildFactoryPrPrompt(input: FactoryPrPromptInput): string {
  const template = input.repositoryProfile?.prTemplate;
  const templateInstruction = template
    ? `Use este template de PR, representado em JSON, para estruturar o corpo da descrição.
Preencha o template com os dados verificados, preservando a tabela de Critérios de Aceite atendidos, as evidências reais de testes/cobertura do Bloco 04 e as ressalvas/decisões da triagem do Review, e inclua o corpo completo em Dados do Pull Request.
Preserve o título e as seções obrigatórias do arquivo de resumo.

${JSON.stringify(template)}`
    : 'Sem template de PR configurado, organize a descrição com as seções padrão do resumo, incluindo o corpo completo do PR em Dados do Pull Request.';
  const baseBranch = input.baseBranch ?? input.repositoryProfile?.baseBranch;
  const targetBranch = baseBranch === 'HEAD' ? undefined : baseBranch;
  const acceptanceCriteriaContext = formatAcceptanceCriteriaContext(input);
  const deterministicChecksContext = formatDeterministicChecksContext(input);
  const reviewAndTriageContext = formatReviewAndTriageContext(input);

  return `Etapa 06 — PR (Etapa 1: Preparação Estruturada)

${FACTORY_PR_SYSTEM_PROMPT}

${formatFactoryRepositoryContext(input.repositoryProfile)}

${templateInstruction}

Leia todos os artefatos aprovados completos e inspecione o estado atual do repositório em modo somente leitura (\`git status\`, \`git diff\`, \`git log\`, \`git branch\`) antes de preparar o rascunho do Pull Request. Não execute \`git commit\`, \`git push\` nem \`gh pr create\`.
Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Relatório de Testes da Etapa 04 (test_report): ${JSON.stringify(input.testReportPath)}
- Relatório de Code Review da Etapa 05 (review_report): ${JSON.stringify(input.reviewReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}
- Branch de origem — ${JSON.stringify(input.branchName ?? 'Confirme no repositório')}
- Branch de destino — ${JSON.stringify(targetBranch ?? 'Confirme no repositório')}${acceptanceCriteriaContext}${deterministicChecksContext}${reviewAndTriageContext}

${formatFactoryStageOutput('pr', input.reportPath, PR_SIDECAR_FIELDS)}

Use o título e preencha todas as seções do relatório Markdown abaixo.

# ${PR_SUMMARY_TITLE}

## ${PR_SUMMARY_SECTIONS.summary}
Descreva o contexto da tarefa, as alterações entregues, as decisões técnicas aplicadas e os principais pontos técnicos observados no diff.

## ${PR_SUMMARY_SECTIONS.validation}
Inclua obrigatoriamente:
1. Tabela Markdown de Critérios de Aceite atendidos no formato:
   | ID | Critério de Aceite | Status | Evidência |
   | --- | --- | --- | --- |
   | CA1 | Descrição do critério | Atendido | Caso de teste / verificação observada |
   (Se não houver critérios registrados na triagem, registre uma linha explícita informando a ausência.)
2. Evidências reais do Bloco 04 (comandos exatos, \`exitCode\` e cobertura de linhas/branches; informe \`indisponível\` quando \`coverage\` ou um check for \`null\`) e verificações do Bloco 03 quando disponíveis.
3. Resumo do Code Review (Bloco 05): veredito final, ressalvas não bloqueantes, falsos positivos descartados com justificativa e sugestões adiadas.

## ${PR_SUMMARY_SECTIONS.prDetails}
Registre obrigatoriamente:
- Título sugerido no padrão Conventional Commits (\`<tipo>(<escopo opcional>): <descrição>\`)
- Branch de origem (\`headBranch\`) e branch de destino (\`baseBranch\`)
- Contexto Jira vinculado (quando houver)
- Status: Rascunho preparado para revisão humana (aguardando confirmação para publicação)
- Corpo completo do Pull Request pronto para revisão humana (seguindo o \`prTemplate\` configurado ou a estrutura consolidada com tabela de CAs, evidências reais do Bloco 04 e ressalvas/decisões do Bloco 05).`;
}
