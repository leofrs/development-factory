import { FactoryRepositoryProfileSchema } from '@development-factory/shared';
import type { FactoryRepositoryProfile } from '@development-factory/shared';

const defaultProfile = FactoryRepositoryProfileSchema.parse({});

export function formatFactoryRepositoryContext(
  profile: FactoryRepositoryProfile = defaultProfile,
): string {
  const { stack, commands, protectedPaths, architectureRules, devEnvironment } = profile;
  const payload = {
    stack,
    commands,
    protectedPaths,
    architectureRules,
    ...(devEnvironment ? { devEnvironment } : {}),
  };
  const context = JSON.stringify(payload, null, 2);
  const devEnvironmentNote = devEnvironment
    ? '\nQuando `devEnvironment` estiver configurado, use apenas os comandos de verificação autorizados, consulte os arquivos de configuração local pertinentes sem expor segredos, utilize dados de teste isolados ou reversíveis em gravações no banco de desenvolvimento e registre objetivamente qualquer limitação de `stagingOnlyDependencies`.'
    : '';

  return `### Perfil do repositório

Use a stack e os comandos oficiais ao planejar ou executar as verificações desta etapa. Respeite os caminhos protegidos adicionais e as regras de arquitetura dentro do escopo e das permissões da etapa.
Os dados estão em JSON. Cada comando é uma lista com o executável seguido de seus argumentos. Preserve os limites e o conteúdo literal de cada argumento.
Na ausência de stack ou comandos configurados, consulte os arquivos de configuração do repositório e os artefatos da tarefa para identificar as tecnologias e verificações aplicáveis.${devEnvironmentNote}

${context}`;
}
