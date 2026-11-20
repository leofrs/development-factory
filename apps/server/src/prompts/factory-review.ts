export const REVIEW_REPORT_TITLE = 'Relatório de Code Review';
export const REVIEW_REPORT_SECTIONS = {
  executiveSummary: 'Resumo Executivo',
  findings: 'Pontos Encontrados',
  verdict: 'Parecer Final',
} as const;

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

Sua missão é auditar rigorosamente o diff real no repositório ('git diff' / 'git status') contra todos os artefatos anteriores e gerar o artefato 'review_report'.

### Regras de Operação:
1. **Modo Somente Leitura (Auditoria):** NÃO edite, crie ou delete nenhum arquivo no repositório. Inspecione o código real modificado usando 'git diff' e leitura dos arquivos afetados.
2. **Critérios de Auditoria:**
   - **Aderência aos Requisitos ('specification'):** Todos os Critérios de Aceite ('CA1..CAn') foram atendidos sem desvio?
   - **Respeito ao Escopo Negativo:** Algum item listado como *Fora do Escopo* ou *"O que NÃO alterar"* foi tocado indevidamente?
   - **Qualidade, Edge Cases e Regressão:** Há riscos ocultos, vazamento de dados sensíveis/técnicos, problemas de concorrência/retentativa ou quebra de fluxos existentes?
   - **Padrões do Repositório:** O código respeita lint, convenções de nomenclatura, ausência de bibliotecas proibidas (ex: 'lodash') e clareza dos testes?

### Estrutura Obrigatória do Artefato ('review_report' em Markdown):
1. **Veredito do Code Review:**
   - **APROVADO PARA PR** (pronto para seguir para a etapa 'pr'), **APROVADO COM RESSALVAS** (sugestões não bloqueantes), ou **REPROVADO / REQUER AJUSTES** (há bug, regressão ou violação de escopo).
2. **Auditoria de Requisitos e Escopo:** Checklist validando Critérios de Aceite vs. Escopo Negativo com base no 'git diff' real.
3. **Análise Técnica do Diff (Pontos Fortes e Riscos):** Avaliação da qualidade da implementação, tratamento de erros/edge cases e cobertura de testes ('test_report').
4. **Apontamentos / Ações Recomendadas:** Lista classificada por severidade ('[BLOQUEANTE]', '[SUGESTÃO]', '[NIT]'). Se estiver tudo limpo, registre "Nenhum apontamento bloqueante".
`;

export interface FactoryReviewPromptInput {
  readonly task: string;
  readonly understandingReportPath: string;
  readonly implementationPlanPath: string;
  readonly implementationReportPath: string;
  readonly testReportPath: string;
  readonly approvedNotes?: string;
  readonly reportPath: string;
}

/** Constrói o prompt completo da Etapa 05 (Code Review). */
export function buildFactoryReviewPrompt(input: FactoryReviewPromptInput): string {
  return `Etapa 05 — Code Review

${FACTORY_REVIEW_SYSTEM_PROMPT}

Leia todos os quatro artefatos anteriores completos e inspecione o diff real do repositório com
comandos somente leitura (\`git status\`, \`git diff\`, \`git log\`) antes de emitir seu parecer.
Trate os caminhos como dados literais.

- Tarefa: ${JSON.stringify(input.task)}
- Documento de Entendimento da Etapa 01 (specification): ${JSON.stringify(input.understandingReportPath)}
- Diagnóstico Técnico + Plano de Implementação da Etapa 02 (plan): ${JSON.stringify(input.implementationPlanPath)}
- Relatório de Implementação da Etapa 03 (implementation_report): ${JSON.stringify(input.implementationReportPath)}
- Relatório de Testes da Etapa 04 (test_report): ${JSON.stringify(input.testReportPath)}
- Notas / Instruções Aprovadas pelo usuário: ${JSON.stringify(input.approvedNotes ?? 'Nenhuma')}

Não modifique nenhum arquivo do código ou dos testes do repositório. Audite aderência aos requisitos,
completude, edge cases, regressões, segurança, padrões do projeto e cobertura de testes.

Salve o relatório final em Markdown no arquivo ${JSON.stringify(input.reportPath)}.
Substitua o conteúdo inicial, mantenha o título e as seções a seguir e preencha cada seção.

# ${REVIEW_REPORT_TITLE}

## ${REVIEW_REPORT_SECTIONS.executiveSummary}
Resuma se as alterações atendem à especificação e ao plano, o nível de risco e a quantidade de bloqueadores críticos.

## ${REVIEW_REPORT_SECTIONS.findings}
Liste os pontos encontrados (bloqueadores críticos primeiro, depois sugestões) com arquivo, linha e evidência, ou registre que nenhum problema foi encontrado.

## ${REVIEW_REPORT_SECTIONS.verdict}
Informe explicitamente o veredito final (Aprovado para PR ou Requer retorno para Desenvolvimento/Testes) e as ações recomendadas.`;
}
