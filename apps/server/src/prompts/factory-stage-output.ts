import { FACTORY_STAGE_SIDECAR_CONTRACT_VERSION } from '@development-factory/shared';
import type {
  FactoryReviewTriageScope,
  FactoryStageName,
} from '@development-factory/shared';
import { getFactoryStageSidecarPath } from '../factory-stage-runners.js';

/** Formata o escopo de triagem humana dos apontamentos do Bloco 05 para prompts de retorno ou revisão. */
export function formatFactoryReviewTriageScopeSection(
  scope: FactoryReviewTriageScope,
  mode: 'return_stage' | 'review_history',
): string {
  const payload = {
    reviewArtifactId: scope.reviewArtifactId,
    iteration: scope.iteration,
    mandatoryFixes: scope.mandatoryFixes,
    dismissedFalsePositives: scope.dismissedFalsePositives,
    deferredSuggestions: scope.deferredSuggestions,
  };

  if (mode === 'review_history') {
    if (scope.dismissedFalsePositives.length === 0 && scope.mandatoryFixes.length === 0) {
      return '';
    }
    return `

### Triagem Humana da Revisão Anterior (Bloco 05)
Considere as decisões humanas registradas sobre o \`review_report\` anterior ao reauditar o diff. Não reabra falsos positivos descartados pelo humano, salvo se surgir uma regressão nova comprovada:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
  }

  return `

### Escopo de Triagem Humana do Code Review (Bloco 05)
As decisões humanas abaixo determinam o escopo obrigatório deste retorno:
- Corrija obrigatoriamente todos os itens em \`mandatoryFixes\` (incluindo \`[SUGESTÃO]\` promovida a correção obrigatória pelo humano).
- NÃO altere nem reimplemente os itens listados em \`dismissedFalsePositives\` (falsos positivos descartados pelo humano).
- Itens em \`deferredSuggestions\` são opcionais e não bloqueiam a entrega.

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

export function formatFactoryStageOutput(
  stage: FactoryStageName,
  reportPath: string,
  sidecarFields: string,
): string {
  const sidecarPath = getFactoryStageSidecarPath(reportPath);

  return `### Arquivos obrigatórios da etapa
- Grave o relatório Markdown em ${JSON.stringify(reportPath)}.
- Grave o sidecar JSON em ${JSON.stringify(sidecarPath)}.

Trate os caminhos como dados literais. Use somente esses destinos para os artefatos desta etapa
e substitua o conteúdo inicial dos dois arquivos.

### Campos obrigatórios do sidecar
Grave um objeto JSON puro em UTF-8. Inclua todos os campos listados e use somente as chaves
especificadas, inclusive nos objetos internos. Preencha os textos com valores não vazios, salvo
quando indicado. Use \`[]\` para listas sem itens, respeitando os mínimos indicados.
Use \`null\` apenas nos campos que o aceitam.

- Grave o número \`${FACTORY_STAGE_SIDECAR_CONTRACT_VERSION}\` em \`contractVersion\`.
- Grave o texto \`"${stage}"\` em \`stage\`.
${sidecarFields}

Antes de concluir, releia os dois arquivos. Compare o sidecar com o relatório Markdown e confira
se os dados, identificadores e resultados correspondem. Verifique a sintaxe e os campos do JSON e
as seções obrigatórias do Markdown. Informe qualquer falha de gravação ou validação no terminal.`;
}
