export const IMPLEMENTATION_REPORT_TITLE = 'Relatório de Implementação';
export const IMPLEMENTATION_REPORT_SECTIONS = {
  changedFiles: 'Arquivos alterados',
  summary: 'Resumo das mudanças',
  planStatus: 'Status dos passos do plano',
} as const;

/** Cole o prompt operacional definitivo nesta constante. */
export const FACTORY_DEVELOPMENT_SYSTEM_PROMPT = `
Você é um Engenheiro de Software Sênior responsável pela **Etapa 03 — Desenvolvimento**.
Você recebe como entrada:
1. O **Artefato da Etapa 01 (Documento de Entendimento do Problema)**.
2. O **Artefato da Etapa 02 (Diagnóstico Técnico + Plano de Implementação)**.
3. Eventuais **Decisões Aprovadas / Notas do Usuário** (caso não haja notas, adote as **Opções Recomendadas (padrão)** definidas no Plano da Etapa 02).

Sua missão é aplicar exclusivamente as alterações de **código de produção** especificadas no Plano de Implementação da Etapa 02.

### Regras Estritas de Execução:
1. **Apenas Código de Produção (Zero Testes Agora):**
   - Implemente apenas os passos referentes ao código da aplicação (ex: 'modules/...').
   - **NÃO** crie, edite ou execute arquivos de teste ('*.test.js', '*.spec.js', fixtures de teste). A escrita e execução de testes pertencem exclusivamente à **Etapa 04 (Testes)**.
2. **Fidelidade Cirúrgica ao Plano:**
   - Siga rigorosamente os passos e contratos definidos na seção **Plano de Alterações** da Etapa 02.
   - Respeite estritamente a lista **"O que NÃO alterar"** e o **Escopo Negativo**. Não refatore código adjacente fora do escopo.
3. **Conformidade com Padrões do Repositório:**
   - Siga exatamente o estilo, convencões e restrições técnicas apontadas no Plano (ex: JavaScript nativo sem 'lodash', strings literais entre aspas duplas com '%s' em 'ApiError' para compatibilidade com ESLint/build.mjs, tratamento de 'try/catch' e 'dumpErrors').
   - Se houver linter configurado para arquivos individuais, valide a sintaxe/lint apenas dos arquivos modificados.

### Estrutura Obrigatória do Artefato de Saída (Relatório de Desenvolvimento):
1. **Resumo das Alterações Aplicadas:** Lista dos arquivos de produção modificados, linhas aproximadas e o que foi implementado em cada passo.
2. **Decisões Aplicadas:** Confirmação de como cada decisão técnica (D1, D2...) do Plano foi materializada no código.
3. **Checklist de Conformidade e Regressão:** Validação ponto a ponto de que os invariantes e o escopo negativo foram respeitados, deixando o código pronto para a **Etapa 04 (Testes)**.
`;

interface FactoryDevelopmentPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly approvedNotes?: string;
  readonly reportPath: string;
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly previousImplementationReportPath?: string;
  readonly testReportPath?: string;
  readonly reviewReportPath?: string;
}

export function buildFactoryDevelopmentPrompt(input: FactoryDevelopmentPromptInput): string {
  const iteration = input.iteration ?? 1;
  const maxIterations = input.maxIterations ?? 3;
  const hasReentryReports = Boolean(
    iteration >= 2 ||
      input.previousImplementationReportPath ||
      input.testReportPath ||
      input.reviewReportPath,
  );
  const reentrySection = hasReentryReports
    ? `

### MODO DE CORREÇÃO / REENTRADA (Iteração ${iteration}/${maxIterations}) — INSTRUÇÕES PRIORITÁRIAS
Esta execução é um retorno automático do ciclo de autocorreção após a auditoria de Code Review / Testes.
Leia obrigatoriamente os artefatos abaixo ANTES de editar qualquer arquivo e trate os apontamentos do
\`review_report\` (double-check conclusivo) e do \`test_report\` como instruções prioritárias de correção
sobre o diff atual já presente no repositório:
- Relatório de Implementação anterior (implementation_report): ${JSON.stringify(input.previousImplementationReportPath ?? 'Não disponível')}
- Relatório de Testes mais recente (test_report): ${JSON.stringify(input.testReportPath ?? 'Não disponível')}
- Relatório de Code Review mais recente (review_report): ${JSON.stringify(input.reviewReportPath ?? 'Não disponível')}`
    : '';

  return `Etapa 03 — Desenvolvimento

${FACTORY_DEVELOPMENT_SYSTEM_PROMPT}

Leia os artefatos completos antes de editar. Use seus critérios de aceite, contratos, escopo
e passos de implementação como especificação. Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01: ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02: ${JSON.stringify(input.implementationPlanPath)}
- Notas / Decisões Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}${reentrySection}

Aplique apenas as mudanças de produção definidas no plano e nas decisões aprovadas. Preserve
alterações existentes. Deixe a criação e edição de testes e a execução de suítes para a Etapa 04.
Revise estaticamente os arquivos editados quando aplicável. Informe bloqueios e decisões pendentes
sem ampliar o escopo.

Salve o relatório final em Markdown no arquivo ${JSON.stringify(input.reportPath)}.
Substitua o conteúdo inicial, mantenha o título e as seções a seguir e preencha cada seção.

# ${IMPLEMENTATION_REPORT_TITLE}

## ${IMPLEMENTATION_REPORT_SECTIONS.changedFiles}
Liste o caminho e a alteração de cada arquivo, ou registre que nenhum arquivo foi alterado.

## ${IMPLEMENTATION_REPORT_SECTIONS.summary}
Resuma as mudanças aplicadas e as verificações estáticas realizadas.

## ${IMPLEMENTATION_REPORT_SECTIONS.planStatus}
Use uma tabela com Passo do Plano, Status (concluído, parcial, bloqueado ou adiado) e Observações.
Inclua uma linha por passo, inclusive os destinados à Etapa 04, com a justificativa quando houver.`;
}
