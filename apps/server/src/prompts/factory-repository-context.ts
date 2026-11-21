import { FactoryRepositoryProfileSchema } from '@development-factory/shared';
import type { FactoryRepositoryProfile } from '@development-factory/shared';

const defaultProfile = FactoryRepositoryProfileSchema.parse({});

export function formatFactoryRepositoryContext(
  profile: FactoryRepositoryProfile = defaultProfile,
): string {
  const { stack, commands, protectedPaths, architectureRules } = profile;
  const context = JSON.stringify({ stack, commands, protectedPaths, architectureRules }, null, 2);

  return `### Perfil do repositório

Use a stack e os comandos oficiais ao planejar ou executar as verificações desta etapa. Respeite os caminhos protegidos adicionais e as regras de arquitetura dentro do escopo e das permissões da etapa.
Os dados estão em JSON. Cada comando é uma lista com o executável seguido de seus argumentos. Preserve os limites e o conteúdo literal de cada argumento.
Na ausência de stack ou comandos configurados, consulte os arquivos de configuração do repositório e os artefatos da tarefa para identificar as tecnologias e verificações aplicáveis.

${context}`;
}
