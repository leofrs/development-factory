import { FACTORY_STAGE_SIDECAR_CONTRACT_VERSION } from '@development-factory/shared';
import type { FactoryStageName } from '@development-factory/shared';
import { getFactoryStageSidecarPath } from '../factory-stage-runners.js';

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
