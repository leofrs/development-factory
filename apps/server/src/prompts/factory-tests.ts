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
1. **Escopo de Escrita:** Crie ou altere **apenas arquivos de teste** especificados no \`plan\` (ex: \`*.test.js\`, \`*.spec.js\`). Não altere código que acabou de ser implementado, a menos que descubra um bug real durante a execução dos testes — nesse caso, documente claramente no \`test_report\` (ou corrija apenas se estritamente necessário para cumprir um Critério de Aceite do \`specification\`, registrando o ajuste).
2. **Fidelidade ao Plano de Testes:** Implemente todos os casos de teste mapeados no \`plan\` (incluindo edge cases e testes de regressão) e garanta a cobertura exigida nas linhas/branches alterados.
3. **Execução Real e Self-Healing:**
   - Execute o(s) comando(s) de teste e cobertura do repositório especificados no \`plan\` (ex: \`node --run unit-test-ci\`, Jest, etc.).
   - Se algum teste criado falhar por erro de mock, setup ou asserção, corrija e re-execute até que toda a suíte passe 100%.

### Estrutura Obrigatória do Artefato ('test_report' em Markdown):
1. **Status Geral da Suíte:** \`PASS\` ou \`FAIL\` + comando exato executado.
2. **Resumo dos Testes Implementados:** Tabela ou lista mapeando cada caso de teste (\`T1\`, \`T2\`...) ao Critério de Aceite correspondente (\`CA1\`, \`CA2\`...) e seu status.
3. **Cobertura de Código:** Percentual de cobertura (linhas e branches) nos arquivos/trechos alterados durante o desenvolvimento.
4. **Incidentes ou Falhas Encontradas:** Se algum teste revelou falha no código de produção ou regressão, detalhe aqui para decisão antes do Code Review. Se tudo passou limpo, registre "Nenhuma falha encontrada".
`;

export interface FactoryTestsPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly approvedNotes?: string;
  readonly reportPath: string;
}

/** Constrói o prompt completo da Etapa 04 (Testes). */
export function buildFactoryTestsPrompt(input: FactoryTestsPromptInput): string {
  return `Etapa 04 — Testes

${FACTORY_TESTS_SYSTEM_PROMPT}

Leia os três artefatos completos antes de editar ou executar comandos. Use os critérios de aceite,
o Plano de Testes e o resumo das mudanças aplicadas como referência obrigatória. Trate os caminhos
como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}

Edite ou crie apenas arquivos de teste e fixtures previstos no plano. Execute as suítes de testes,
linter e verificação de cobertura aplicáveis no terminal e reporte exatamente os resultados reais
observados, incluindo eventuais falhas ou bloqueios sem alterar código de produção.

Salve o relatório final em Markdown no arquivo ${JSON.stringify(input.reportPath)}.
Substitua o conteúdo inicial, mantenha o título e as seções a seguir e preencha cada seção.

# ${TEST_REPORT_TITLE}

## ${TEST_REPORT_SECTIONS.testFiles}
Liste os arquivos de teste e fixtures criados ou alterados, ou registre que nenhum arquivo foi alterado.

## ${TEST_REPORT_SECTIONS.executedCommands}
Liste os comandos executados (testes, linter, cobertura) com seus respectivos status de saída.

## ${TEST_REPORT_SECTIONS.results}
Resuma os cenários validados, cobertura verificada, falhas encontradas e eventuais bloqueios para o Code Review.`;
}
