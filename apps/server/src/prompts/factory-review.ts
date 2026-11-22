import type { FactoryTestsSidecar } from '@development-factory/shared';
import { formatFactoryStageOutput } from './factory-stage-output.js';

export type FactoryReviewTestResults = Pick<
  FactoryTestsSidecar,
  'status' | 'executedCommands' | 'coverage' | 'backendChecks'
>;

export const REVIEW_REPORT_TITLE = 'Relatório de Code Review';
export const REVIEW_REPORT_SECTIONS = {
  executiveSummary: 'Resumo Executivo',
  findings: 'Pontos Encontrados',
  verdict: 'Parecer Final',
} as const;

export const REVIEW_VERDICT_LABELS = {
  approved: 'APROVADO PARA PR',
  approvedWithWarnings: 'APROVADO COM RESSALVAS',
  changesRequested: 'REPROVADO / REQUER AJUSTES',
} as const;

const REVIEW_SIDECAR_FIELDS = `- Use em \`verdict\` o valor correspondente ao Parecer Final do Markdown.
  - \`approved\` para ${REVIEW_VERDICT_LABELS.approved}
  - \`approved_with_warnings\` para ${REVIEW_VERDICT_LABELS.approvedWithWarnings}
  - \`changes_requested\` para ${REVIEW_VERDICT_LABELS.changesRequested}
- Use em \`findings\` uma lista com um objeto por apontamento registrado no Markdown.
  Use \`severity\` igual a \`BLOQUEANTE\`, \`SUGESTÃO\` ou \`NIT\`, \`file\` como caminho relativo ao
  repositório com separador \`/\` e sem segmentos \`..\`, \`line\` como número inteiro positivo e
  \`explanation\` como texto com a explicação do apontamento.`;

/**
 * Placeholder do System Prompt operacional da Etapa 05 (Code Review).
 * Cole o prompt operacional definitivo nesta constante quando desejar.
 */
export const FACTORY_REVIEW_SYSTEM_PROMPT = `
Você é um Staff Software Engineer / Revisor Técnico Sênior responsável pela etapa **Code Review ('review')** do pipeline Factory.
Você recebe como entrada:
1. 'specification' (Triagem)
2. 'plan' (Planejamento)
3. 'implementation_report' (Desenvolvimento)
4. 'test_report' (Testes)
5. 'approvedNotes' (Notas opcionais do usuário)

Sua missão é auditar rigorosamente o diff real no repositório ('git diff' / 'git status') contra todos os artefatos anteriores, realizar o **double-check técnico** de eventuais falhas reportadas pelo 'test_report' e gerar o artefato 'review_report'.

### Regras de Operação:
1. **Modo Somente Leitura (Auditoria):** NÃO edite, crie ou delete nenhum arquivo no repositório. Inspecione o código real modificado usando 'git diff' e leitura dos arquivos afetados.
2. **Double-Check de Falhas dos Testes:**
   - Se o 'test_report' reportar falhas no código de produção ou regressões, valide diretamente no diff e nos arquivos reais se o diagnóstico dos testes procede, identifique a causa raiz exata e consolide instruções conclusivas e acionáveis de correção para a etapa 'development'.
   - Se a falha apontada pelo 'test_report' for um falso positivo ou problema exclusivo de teste/ambiente sem defeito no código de produção, registre isso explicitamente com evidências.
3. **Critérios de Auditoria:**
   - **Aderência aos Requisitos ('specification'):** Todos os Critérios de Aceite ('CA1..CAn') foram atendidos sem desvio?
   - **Respeito ao Escopo Negativo:** Algum item listado como *Fora do Escopo* ou *"O que NÃO alterar"* foi tocado indevidamente?
   - **Qualidade, Edge Cases e Regressão:** Há riscos ocultos, vazamento de dados sensíveis/técnicos, problemas de concorrência/retentativa ou quebra de fluxos existentes?
   - **Padrões do Repositório:** O código respeita lint, convenções de nomenclatura, ausência de bibliotecas proibidas e clareza dos testes?

### Estrutura Obrigatória do Artefato ('review_report' em Markdown):
1. **Veredito do Code Review (contrato determinístico na seção Parecer Final):**
   - **${REVIEW_VERDICT_LABELS.approved}** (pronto para seguir para a etapa 'pr'),
   - **${REVIEW_VERDICT_LABELS.approvedWithWarnings}** (sugestões não bloqueantes, aprovado para seguir para 'pr'), ou
   - **${REVIEW_VERDICT_LABELS.changesRequested}** (há bug, falha confirmada do 'test_report', regressão ou violação de escopo — retorna automaticamente para 'development').
2. **Auditoria de Requisitos e Escopo:** Checklist validando Critérios de Aceite vs. Escopo Negativo com base no 'git diff' real.
3. **Análise Técnica do Diff e Double-Check dos Testes:** Avaliação da qualidade da implementação, tratamento de erros/edge cases, cobertura e verificação técnica das falhas do 'test_report'.
4. **Apontamentos / Instruções Conclusivas de Correção:** Lista classificada por severidade ('[BLOQUEANTE]', '[SUGESTÃO]', '[NIT]'). Quando houver bloqueadores, forneça arquivo, linha, causa raiz e correção esperada para orientar o retorno automático ao Desenvolvimento. Se estiver tudo limpo, registre "Nenhum apontamento bloqueante".
`;

export interface FactoryReviewPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly testReportPath: string;
  readonly testResults?: FactoryReviewTestResults;
  readonly approvedNotes?: string;
  readonly reportPath: string;
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly previousReviewReportPath?: string;
}

/** Constrói o prompt completo da Etapa 05 (Code Review). */
export function buildFactoryReviewPrompt(input: FactoryReviewPromptInput): string {
  const testResultsContext = input.testResults
    ? `

Use os resultados de testes e cobertura registrados pelo backend no sidecar como referência oficial para o double-check (em caso de divergência com o texto do relatório, priorize estes dados reais).

\`\`\`json
${JSON.stringify(input.testResults, null, 2)}
\`\`\``
    : '';
  const iterationContext =
    input.iteration && input.iteration >= 2
      ? `\n- Ciclo atual do loop autônomo: Iteração ${input.iteration}/${input.maxIterations ?? 3}${
          input.previousReviewReportPath
            ? `\n- Relatório de Code Review da iteração anterior (confira se os bloqueadores foram corrigidos): ${JSON.stringify(input.previousReviewReportPath)}`
            : ''
        }`
      : '';

  return `Etapa 05 — Code Review

${FACTORY_REVIEW_SYSTEM_PROMPT}

Leia todos os artefatos anteriores completos e inspecione o diff real do repositório com
comandos somente leitura (\`git status\`, \`git diff\`, \`git log\`) antes de emitir seu parecer.
Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Relatório de Testes da Etapa 04 (test_report): ${JSON.stringify(input.testReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}${iterationContext}${testResultsContext}

Não modifique nenhum arquivo do código ou dos testes do repositório. Audite aderência aos requisitos,
completude, edge cases, regressões, segurança, padrões do projeto, cobertura de testes e faça o double-check
de qualquer falha apontada no test_report.

${formatFactoryStageOutput('review', input.reportPath, REVIEW_SIDECAR_FIELDS)}

Use o título e preencha todas as seções do relatório Markdown abaixo.

# ${REVIEW_REPORT_TITLE}

## ${REVIEW_REPORT_SECTIONS.executiveSummary}
Resuma se as alterações atendem à especificação e ao plano, o nível de risco, o resultado do double-check dos testes e a quantidade de bloqueadores críticos.

## ${REVIEW_REPORT_SECTIONS.findings}
Liste os pontos encontrados (bloqueadores críticos primeiro, com instruções conclusivas de correção e evidências de arquivo/linha, depois sugestões), ou registre que nenhum problema foi encontrado.

## ${REVIEW_REPORT_SECTIONS.verdict}
Veredito: ${REVIEW_VERDICT_LABELS.approved} | ${REVIEW_VERDICT_LABELS.approvedWithWarnings} | ${REVIEW_VERDICT_LABELS.changesRequested}
Informe na primeira linha exatamente \`Veredito: ${REVIEW_VERDICT_LABELS.approved}\`, \`Veredito: ${REVIEW_VERDICT_LABELS.approvedWithWarnings}\` ou \`Veredito: ${REVIEW_VERDICT_LABELS.changesRequested}\`, seguido da justificativa e ações recomendadas.`;
}
