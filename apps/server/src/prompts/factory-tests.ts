import type { FactoryDevelopmentChecks, FactoryRepositoryProfile } from '@development-factory/shared';
import { formatFactoryRepositoryContext } from './factory-repository-context.js';
import { formatFactoryStageOutput } from './factory-stage-output.js';

const TESTS_SIDECAR_FIELDS = `- Use em \`executedCommands\` uma lista de objetos com \`command\` e \`exitCode\`.
  Use em \`command\` uma lista de strings com o executável seguido pelos argumentos na ordem original,
  preservando inclusive argumentos vazios. Use em \`exitCode\` o código de saída observado (inteiro
  maior ou igual a zero) ou \`null\` quando indisponível. Registre os mesmos comandos e códigos no Markdown.
- Use em \`testCases\` uma lista de objetos com \`id\` e \`description\` em texto, \`acceptanceCriteriaIds\`
  como lista com pelo menos um ID de critério de aceite da triagem e \`status\` igual a \`passed\`,
  \`failed\` ou \`skipped\`. Registre os mesmos casos, critérios e resultados no Markdown.
- Use em \`status\` o valor \`passed\`, \`failed\` ou \`not_run\` para o resultado geral \`PASS\`, \`FAIL\`
  ou \`NÃO EXECUTADA\`, respectivamente.
- Use em \`coverage\` um objeto com \`linesPercent\` e \`branchesPercent\` em números de 0 a 100, sem o
  símbolo de porcentagem. Use \`null\` em \`branchesPercent\` quando a cobertura de branches estiver
  indisponível ou em \`coverage\` quando não houver medição de linhas. Registre no Markdown os mesmos
  percentuais medidos ou a ausência de medição.`;

export const TEST_REPORT_TITLE = 'Relatório de Testes';
export const TEST_REPORT_SECTIONS = {
  testFiles: 'Arquivos de teste alterados',
  executedCommands: 'Comandos executados',
  results: 'Resultados e cobertura',
} as const;

/**
 * Placeholder do System Prompt operacional da Etapa 04 (Testes).
 * Cole o prompt operacional definitivo nesta constante quando desejar.
 */
export const FACTORY_TESTS_SYSTEM_PROMPT = `
Você é um Engenheiro de QA / Software Sênior responsável pela etapa **Testes (\`tests\`)** do pipeline Factory.
Você recebe como entrada:
1. \`specification\` (Documento de Entendimento - Triagem)
2. \`plan\` (Diagnóstico Técnico + Plano de Implementação e Testes - Planejamento)
3. \`implementation_report\` (Relatório de Desenvolvimento)
4. \`approvedNotes\` (Notas opcionais do usuário)

Sua missão é implementar os testes automatizados definidos no \`plan\`, executar a suíte de validação do repositório e gerar o artefato \`test_report\`.

### Regras de Execução:
1. **Escopo de Escrita (Zero Alteração de Produção)**. No repositório, altere apenas os arquivos de teste e fixtures especificados no \`plan\`. Diante de um defeito de produção ou de uma regressão, registre \`FAIL\`, o comando e a causa raiz no \`test_report\` para verificação técnica no Code Review.
2. **Fidelidade ao Plano de Testes:** Implemente todos os casos de teste mapeados no \`plan\` (incluindo edge cases e testes de regressão) e garanta a cobertura exigida nas linhas/branches alterados.
3. **Execução Real e Self-Healing de Setup de Testes:**
   - Execute os comandos oficiais de teste e cobertura do perfil quando aplicáveis. Consulte a configuração do projeto e o plano para identificar os comandos que o perfil omitir.
   - Se um teste criado falhar por erro de mock, setup ou asserção do próprio teste, corrija o teste e re-execute. Se falhar por defeito no código de produção, registre \`FAIL\` com diagnóstico completo no \`test_report\` e conclua o relatório para envio automático ao \`review\`.

### Estrutura Obrigatória do Artefato ('test_report' em Markdown):
1. **Status Geral da Suíte.** Registre \`PASS\`, \`FAIL\` ou \`NÃO EXECUTADA\` e os comandos exatos executados.
2. **Resumo dos Testes Implementados:** Tabela ou lista mapeando cada caso de teste (\`T1\`, \`T2\`...) ao Critério de Aceite correspondente (\`CA1\`, \`CA2\`...) e seu status.
3. **Cobertura de Código:** Percentual de cobertura (linhas e branches) nos arquivos/trechos alterados durante o desenvolvimento.
4. **Incidentes ou Falhas Encontradas:** Se algum teste revelou falha no código de produção ou regressão, detalhe aqui (arquivo, cenário, erro observado) para o *double-check* do Code Review. Se tudo passou limpo, registre "Nenhuma falha encontrada".
`;

export interface FactoryTestsPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly developmentChecks?: FactoryDevelopmentChecks;
  readonly approvedNotes?: string;
  readonly reportPath: string;
  readonly repositoryProfile?: FactoryRepositoryProfile;
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly previousTestReportPath?: string;
  readonly previousReviewReportPath?: string;
}

/** Constrói o prompt completo da Etapa 04 (Testes). */
export function buildFactoryTestsPrompt(input: FactoryTestsPromptInput): string {
  const developmentChecks = input.developmentChecks
    ? `

Use os resultados de typecheck e lint registrados pelo backend no Desenvolvimento.
Um resultado \`null\` indica que o perfil omitiu o comando.

\`\`\`json
${JSON.stringify(input.developmentChecks, null, 2)}
\`\`\``
    : '';
  const iterationContext =
    input.iteration && input.iteration >= 2
      ? `\n- Ciclo atual do loop autônomo: Iteração ${input.iteration}/${input.maxIterations ?? 3}${
          input.previousTestReportPath
            ? `\n- Relatório de Testes da iteração anterior: ${JSON.stringify(input.previousTestReportPath)}`
            : ''
        }${
          input.previousReviewReportPath
            ? `\n- Relatório de Code Review da iteração anterior (aplique as correções de teste, mock ou cobertura solicitadas e valide se passaram nos testes): ${JSON.stringify(input.previousReviewReportPath)}`
            : ''
        }`
      : '';

  return `Etapa 04 — Testes

${FACTORY_TESTS_SYSTEM_PROMPT}

${formatFactoryRepositoryContext(input.repositoryProfile)}

Leia os artefatos completos antes de editar ou executar comandos. Use os critérios de aceite,
o Plano de Testes e o resumo das mudanças aplicadas como referência obrigatória. Trate os caminhos
como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}${iterationContext}${developmentChecks}

No repositório, edite ou crie apenas arquivos de teste e fixtures previstos no plano. O ambiente permite
executar apenas os comandos oficiais de teste e cobertura declarados no perfil do repositório
(sem acesso a shell genérico). Após a sessão, o backend executará os comandos de \`test\` e
\`coverage\` configurados no perfil e gravará os valores finais de \`executedCommands\`, \`status\`,
\`coverage\` e \`backendChecks\` no sidecar. Registre os resultados observados e eventuais falhas ou
bloqueios no relatório.

${formatFactoryStageOutput('tests', input.reportPath, TESTS_SIDECAR_FIELDS)}

Use o título e preencha todas as seções do relatório Markdown abaixo.

# ${TEST_REPORT_TITLE}

## ${TEST_REPORT_SECTIONS.testFiles}
Liste os arquivos de teste e fixtures criados ou alterados, ou registre que nenhum arquivo foi alterado.

## ${TEST_REPORT_SECTIONS.executedCommands}
Liste os comandos executados com seus respectivos status de saída.

## ${TEST_REPORT_SECTIONS.results}
Resuma os cenários validados, cobertura verificada, falhas encontradas e eventuais bloqueios para o Code Review.`;
}
