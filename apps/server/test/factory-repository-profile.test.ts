import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FactoryRepositoryProfile } from '@development-factory/shared';
import { loadFactoryRepositoryProfile } from '../src/factory-repository-profile.js';

const defaultProfile: FactoryRepositoryProfile = {
  baseBranch: null,
  branchPattern: 'factory/{slug}',
  stack: [],
  commands: {
    typecheck: null,
    lint: null,
    test: null,
    coverage: null,
  },
  protectedPaths: [],
  architectureRules: [],
  prTemplate: null,
};

async function createTestRepository(context: TestContext): Promise<{
  repoRoot: string;
  manifestPath: string;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'factory-profile-'));
  context.after(() => rm(repoRoot, { recursive: true, force: true }));
  return { repoRoot, manifestPath: join(repoRoot, '.development-factory.json') };
}

test('carrega o perfil completo da raiz do repositório', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  const profile: FactoryRepositoryProfile = {
    baseBranch: 'release/atual',
    branchPattern: 'feat/{slug}-factory',
    stack: ['TypeScript', 'Node.js'],
    commands: {
      typecheck: ['npm', 'run', 'typecheck'],
      lint: ['npm', 'run', 'lint'],
      test: ['./scripts/test', '--filter', 'regra com espaços'],
      coverage: ['npm', 'run', 'coverage', '--', '--config=./coverage/config.json'],
    },
    protectedPaths: ['infra/**', 'docs/versão..anterior.md'],
    architectureRules: ['Controllers chamam serviços.\nServiços concentram regras de negócio.'],
    prTemplate: '## Resumo\n\n## Evidências\n',
  };
  await writeFile(manifestPath, JSON.stringify(profile));

  assert.deepEqual(await loadFactoryRepositoryProfile(repoRoot), { source: 'manifest', profile });
});

test('aplica valores padrão aos campos e comandos omitidos de um perfil parcial', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  const commands = { test: ['npm', 'test'] };
  await writeFile(manifestPath, JSON.stringify({ commands }));

  assert.deepEqual(await loadFactoryRepositoryProfile(repoRoot), {
    source: 'manifest',
    profile: {
      ...defaultProfile,
      commands: { ...defaultProfile.commands, ...commands },
    },
  });
});

test('usa os valores padrão quando a raiz não contém o manifesto', async context => {
  const { repoRoot } = await createTestRepository(context);
  const subdirectory = join(repoRoot, 'subpasta');
  await mkdir(subdirectory);
  await writeFile(join(subdirectory, '.development-factory.json'), '{"baseBranch":"main"}');

  assert.deepEqual(await loadFactoryRepositoryProfile(repoRoot), {
    source: 'defaults',
    profile: defaultProfile,
  });
});

test('rejeita JSON malformado com diagnóstico de sintaxe', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  await writeFile(manifestPath, '{"baseBranch":');

  await assert.rejects(loadFactoryRepositoryProfile(repoRoot), {
    code: 'INVALID_FACTORY_MANIFEST_JSON',
    message: /\.development-factory\.json contém JSON inválido/,
  });
});

test('identifica os campos e motivos dos erros de validação do perfil', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  const invalidProfiles = [
    { input: [], diagnostic: /raiz do manifesto \(Informe um objeto JSON\)/ },
    { input: { baseBranch: 'release/.tmp' }, diagnostic: /baseBranch .*branch Git válido/ },
    { input: { branchPattern: 'feat/{chave}' }, diagnostic: /branchPattern .*marcador \{slug\}/ },
    { input: { stack: [' '] }, diagnostic: /stack\.0 .*item da stack/ },
    { input: { commands: { test: 'npm test' } }, diagnostic: /commands\.test .*executável/ },
    { input: { commands: { test: [] } }, diagnostic: /commands\.test\.0 .*executável/ },
    { input: { commands: { build: ['npm'] } }, diagnostic: /commands .*Campos desconhecidos.*build/ },
    { input: { unknown: true }, diagnostic: /raiz do manifesto .*Campos desconhecidos.*unknown/ },
    { input: { prTemplate: false }, diagnostic: /prTemplate \(Informe um texto\)/ },
  ];
  for (const { input, diagnostic } of invalidProfiles) {
    await writeFile(manifestPath, JSON.stringify(input));
    await assert.rejects(loadFactoryRepositoryProfile(repoRoot), {
      code: 'INVALID_FACTORY_MANIFEST',
      message: diagnostic,
    });
  }
});

test('rejeita caracteres de controle e travessia em caminhos e comandos', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  const invalidProfiles = [
    {
      input: { protectedPaths: ['infra/**\n'] },
      diagnostic: /protectedPaths\.0 .*caracteres de controle/,
    },
    {
      input: { protectedPaths: ['infra/../privado'] },
      diagnostic: /protectedPaths\.0 .*relativo/,
    },
    {
      input: { protectedPaths: ['C:\\privado'] },
      diagnostic: /protectedPaths\.0 .*relativo/,
    },
    {
      input: { commands: { test: ['npm', 'test\0'] } },
      diagnostic: /commands\.test\.1 .*caracteres de controle/,
    },
    {
      input: { commands: { lint: ['../lint'] } },
      diagnostic: /commands\.lint\.0 .*relativo/,
    },
    {
      input: { commands: { test: ['npm', '--config=..\\privado'] } },
      diagnostic: /commands\.test\.1 .*segmentos "\.\."/,
    },
  ];
  for (const { input, diagnostic } of invalidProfiles) {
    await writeFile(manifestPath, JSON.stringify(input));
    await assert.rejects(loadFactoryRepositoryProfile(repoRoot), {
      code: 'INVALID_FACTORY_MANIFEST',
      message: diagnostic,
    });
  }
});

test('distingue um manifesto ausente de um diretório raiz inexistente', async context => {
  const { repoRoot } = await createTestRepository(context);
  await assert.rejects(loadFactoryRepositoryProfile(join(repoRoot, 'inexistente')), {
    code: 'INVALID_REPO_PATH',
  });
});

test('rejeita um manifesto referenciado por link simbólico', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  await symlink(join(repoRoot, 'inexistente.json'), manifestPath);

  await assert.rejects(loadFactoryRepositoryProfile(repoRoot), {
    code: 'FACTORY_MANIFEST_READ_FAILED',
    message: /link simbólico/,
  });
});

test('rejeita manifestos fora do limite de leitura', async context => {
  const { repoRoot, manifestPath } = await createTestRepository(context);
  await writeFile(manifestPath, `{}${' '.repeat(256 * 1024)}`);

  await assert.rejects(loadFactoryRepositoryProfile(repoRoot), {
    code: 'INVALID_FACTORY_MANIFEST',
    message: /256 KiB/,
  });
});
