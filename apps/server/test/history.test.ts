import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FactoryTriageSidecarSchema } from '@development-factory/shared';
import { createFactoryHistory } from '../src/history.js';
import {
  planningMarkdown,
  sidecarFixtures,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

function createIsolatedHistoryEnv(context: TestContext): {
  rootDir: string;
  repoDir: string;
  xdgDataHome: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-history-'));
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);

  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;

  context.after(() => {
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  return { rootDir, repoDir, xdgDataHome };
}

test('preserva saída sem ANSI entre chunks e identifica triagem interrompida em diretório externo', context => {
  const { repoDir, xdgDataHome } = createIsolatedHistoryEnv(context);
  const flowId = randomUUID();
  const states: string[] = [];
  const history = createFactoryHistory(
    { inputType: 'title', value: '123', repoPath: repoDir, flowId },
    state => states.push(state),
    () => {},
  );
  history.record('\x1b[');
  history.record('31mProblema crítico\x1b[0m\r\n');
  history.record('\x1b]0;título');
  history.record('\x07Mais informações\n');
  history.finish('interrompido');
  history.finish('não deve finalizar duas vezes');
  const session = readFileSync(history.sessionPath, 'utf8');
  assert(session.includes('Problema crítico\n    Mais informações'));
  assert(!session.includes('\x1b'));
  assert.match(
    readFileSync(history.reportPath, 'utf8'),
    /Documento de Entendimento do Problema incompleto/,
  );
  assert.ok(session.includes(history.sidecarPath));
  assert.deepEqual(states, ['incomplete']);
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(
    dirname(history.reportPath),
    join(xdgDataHome, 'development-factory', 'artifacts', flowId),
  );
});

test('preserva o par final, cria arquivos distintos fora do repositório e aplica permissões restritas', context => {
  const { repoDir, xdgDataHome } = createIsolatedHistoryEnv(context);
  const flowId = randomUUID();
  const request = { inputType: 'title', value: '../../feature', repoPath: repoDir, flowId } as const;
  const states: string[] = [];
  const first = createFactoryHistory(request, state => states.push(state), assert.fail);
  const second = createFactoryHistory(
    { inputType: 'title', value: '../../feature', repoPath: repoDir },
    () => {},
    () => {},
  );
  assert.notEqual(first.reportPath, second.reportPath);
  const expectedFlowDir = join(xdgDataHome, 'development-factory', 'artifacts', flowId);
  const expectedRootDir = join(xdgDataHome, 'development-factory', 'artifacts');
  assert.equal(dirname(first.reportPath), expectedFlowDir);
  assert.equal(first.sidecarPath, first.reportPath.replace(/\.md$/, '.json'));
  assert.notEqual(first.sidecarPath, second.sidecarPath);
  assert.equal(dirname(first.sessionPath), expectedFlowDir);
  assert.equal(dirname(second.reportPath), expectedRootDir);
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(statSync(expectedRootDir).mode & 0o777, 0o700);
  assert.equal(statSync(expectedFlowDir).mode & 0o777, 0o700);
  assert.equal(statSync(first.reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(first.sidecarPath).mode & 0o777, 0o600);
  assert.equal(statSync(first.sessionPath).mode & 0o777, 0o600);

  const result = triageMarkdown('Definir o escopo da tarefa.');
  writeFactoryStageSidecar(first.reportPath, 'triage');
  writeFileSync(first.reportPath, result);
  assert.deepEqual(states, []);
  first.finish('concluído');
  second.finish('interrompido');
  assert.equal(readFileSync(first.reportPath, 'utf8'), result);
  assert.equal(readFileSync(first.sidecarPath, 'utf8'), JSON.stringify(sidecarFixtures.triage));
  assert.deepEqual(states, ['saved']);
});

for (const { stage, markdown } of [
  { stage: 'triage', markdown: triageMarkdown('Descrever o cenário.') },
  { stage: 'planning', markdown: planningMarkdown('Investigar os pontos de integração.') },
] as const) {
  test(`${stage} exige Markdown estruturado e sidecar da etapa`, context => {
    const { repoDir } = createIsolatedHistoryEnv(context);
    const states: string[] = [];
    const request = {
      inputType: 'title',
      value: 'Validar relatório',
      repoPath: repoDir,
      stage,
    } as const;

    const missingSidecar = createFactoryHistory(request, state => states.push(state), () => {});
    writeFileSync(missingSidecar.reportPath, markdown);
    unlinkSync(missingSidecar.sidecarPath);
    const missingError = missingSidecar.finish('concluído');
    assert.equal(missingError?.code, 'FACTORY_SIDECAR_MISSING');
    assert.equal(readFileSync(missingSidecar.reportPath, 'utf8'), markdown);

    const invalidReport = createFactoryHistory(request, state => states.push(state), () => {});
    writeFileSync(invalidReport.reportPath, '# Rascunho\n\nConteúdo arbitrário.');
    writeFactoryStageSidecar(invalidReport.reportPath, stage);
    const invalidReportError = invalidReport.finish('concluído');
    assert.equal(invalidReportError?.code, 'FACTORY_MARKDOWN_INVALID');

    const validPair = createFactoryHistory(request, state => states.push(state), assert.fail);
    writeFileSync(validPair.reportPath, markdown);
    writeFactoryStageSidecar(validPair.reportPath, stage);
    assert.equal(validPair.finish('concluído'), undefined);
    assert.deepEqual(states, ['incomplete', 'incomplete', 'saved']);
  });
}

test('diagnostica o campo da etapa e chaves extras com o caminho completo no JSON', context => {
  const { repoDir } = createIsolatedHistoryEnv(context);
  const states: string[] = [];
  const history = createFactoryHistory(
    { inputType: 'title', value: 'Validar sidecar', repoPath: repoDir },
    state => states.push(state),
    () => {},
  );
  writeFileSync(history.reportPath, triageMarkdown('Descrever o cenário.'));
  writeFileSync(history.sidecarPath, JSON.stringify({
    ...sidecarFixtures.triage,
    stage: 'planning',
    acceptanceCriteria: [{ id: 'CA1', description: 'Validar o cenário.', extra: true }],
  }));

  const error = history.finish('concluído');
  assert.equal(error?.code, 'FACTORY_SIDECAR_INVALID_SCHEMA');
  assert.deepEqual(error.issues.map(({ code, path }) => ({ code, path })), [
    { code: 'invalid_value', path: ['stage'] },
    { code: 'unrecognized_keys', path: ['acceptanceCriteria', 0, 'extra'] },
  ]);
  assert.deepEqual(states, ['incomplete']);
});

test('diagnostica JSON malformado sem incluir conteúdo do arquivo e recusa sidecar simbólico', context => {
  const { repoDir, rootDir } = createIsolatedHistoryEnv(context);
  const request = { inputType: 'title', value: 'Validar relatório', repoPath: repoDir } as const;
  const states: string[] = [];
  const messages: string[] = [];
  const history = createFactoryHistory(
    request,
    state => states.push(state),
    message => messages.push(message),
  );
  writeFileSync(history.reportPath, triageMarkdown('Descrever o cenário.'));
  writeFileSync(history.sidecarPath, '{"segredo": valorInvalido}');

  const parseError = history.finish('concluído');
  assert.equal(parseError?.code, 'FACTORY_SIDECAR_INVALID_JSON');
  assert.equal(parseError.issues[0]?.code, 'invalid_json');
  assert.deepEqual(parseError.issues[0]?.path, []);
  assert.match(parseError.message, /\$ \(/);
  assert.doesNotMatch(parseError.message, /segredo|valorInvalido/);

  const linkedHistory = createFactoryHistory(
    request,
    state => states.push(state),
    message => messages.push(message),
  );
  writeFileSync(linkedHistory.reportPath, triageMarkdown('Descrever o cenário.'));
  const targetReport = join(rootDir, 'outro.md');
  writeFactoryStageSidecar(targetReport, 'triage');
  unlinkSync(linkedHistory.sidecarPath);
  symlinkSync(join(rootDir, 'outro.json'), linkedHistory.sidecarPath);
  const readError = linkedHistory.finish('concluído');
  assert.equal(readError?.code, 'FACTORY_SIDECAR_READ_FAILED');
  assert.deepEqual(states, ['incomplete', 'incomplete']);
  assert.deepEqual(messages, [parseError.message, readError.message]);
});

test('recusa destino dentro do repositório, symlinks em diretórios gerenciados e flowId inválido', context => {
  const { rootDir, repoDir, xdgDataHome } = createIsolatedHistoryEnv(context);

  // 1. Rejeita flowId com travessia de caminho.
  assert.throws(
    () =>
      createFactoryHistory(
        { inputType: 'title', value: '1', repoPath: repoDir, flowId: '../fora' },
        () => {},
        () => {},
      ),
    /Identificador de fluxo inválido/,
  );

  // 2. Rejeita XDG_DATA_HOME dentro do repositório alvo.
  process.env.XDG_DATA_HOME = join(repoDir, 'dados');
  assert.throws(
    () => createFactoryHistory({ inputType: 'title', value: '1', repoPath: repoDir }, () => {}, () => {}),
    /fora do repositório/,
  );

  // 3. Rejeita symlink no diretório artifacts/<flowId>.
  process.env.XDG_DATA_HOME = xdgDataHome;
  const artifactsDir = join(xdgDataHome, 'development-factory', 'artifacts');
  const outsideTarget = join(rootDir, 'outro');
  const flowId = randomUUID();
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(outsideTarget);
  symlinkSync(outsideTarget, join(artifactsDir, flowId));
  assert.throws(
    () =>
      createFactoryHistory(
        { inputType: 'title', value: '1', repoPath: repoDir, flowId },
        () => {},
        () => {},
      ),
    /links simbólicos/,
  );

  // 4. Não segue symlink caso o arquivo de relatório seja substituído durante a sessão.
  const validFlowId = randomUUID();
  const protectedFile = join(rootDir, 'protected.md');
  writeFileSync(protectedFile, 'original');
  const history = createFactoryHistory(
    { inputType: 'title', value: '1', repoPath: repoDir, flowId: validFlowId },
    () => {},
    () => {},
  );
  unlinkSync(history.reportPath);
  symlinkSync(protectedFile, history.reportPath);
  history.finish('interrompido');
  assert.equal(readFileSync(protectedFile, 'utf8'), 'original');
});

test('redige segredos divididos entre chunks na saída da TUI, no relatório Markdown e no sidecar JSON', context => {
  const { repoDir } = createIsolatedHistoryEnv(context);
  const states: string[] = [];
  const history = createFactoryHistory(
    {
      inputType: 'jira_url',
      value: 'https://bot:jira_pass_123@empresa.atlassian.net/browse/DEV-99',
      repoPath: repoDir,
    },
    state => states.push(state),
    assert.fail,
  );

  history.record('\x1b[33mAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.');
  history.record('eyJzdWIiOiIxMjM0NTYifQ.sig_9876543210\x1b[0m\r\n');
  history.record('GH_TOKEN=ghp_1234567890abcdef1234567890abcdef1234\n');
  history.record('Linha final sem quebra AWS=AKIAIOSFODNN7EXAMPLE');

  writeFileSync(
    history.reportPath,
    triageMarkdown('Chamada em https://user:secret99@api.internal/v1 com x-api-key: key_abc12345'),
  );
  writeFactoryStageSidecar(history.reportPath, 'triage', {
    technicalContext: 'Token ATATT3xFfGF0123456789abcdefABCDEF_-123456 e "secret": "nao-vazar-123"',
    jiraContext: {
      key: 'DEV-99',
      url: 'https://bot:jira_pass_123@empresa.atlassian.net/browse/DEV-99',
    },
  });

  const error = history.finish('encerrado com JIRA_API_TOKEN=ATATT3xFfGF0123456789abcdefABCDEF_-9999');
  assert.equal(error, undefined);
  assert.deepEqual(states, ['saved']);

  const sessionContent = readFileSync(history.sessionPath, 'utf8');
  const reportContent = readFileSync(history.reportPath, 'utf8');
  const sidecarContent = readFileSync(history.sidecarPath, 'utf8');

  for (const leaked of [
    'jira_pass_123',
    'eyJhbGciOiJIUzI1NiJ9',
    'ghp_1234567890abcdef1234567890abcdef1234',
    'AKIAIOSFODNN7EXAMPLE',
    'user:secret99',
    'key_abc12345',
    'ATATT3xFfGF0123456789abcdefABCDEF_-123456',
    'nao-vazar-123',
    'ATATT3xFfGF0123456789abcdefABCDEF_-9999',
  ]) {
    assert.equal(sessionContent.includes(leaked), false, `Sessão vazou ${leaked}`);
    assert.equal(reportContent.includes(leaked), false, `Relatório vazou ${leaked}`);
    assert.equal(sidecarContent.includes(leaked), false, `Sidecar vazou ${leaked}`);
  }

  assert.match(sessionContent, /Authorization: Bearer \[REDACTED\]/);
  assert.match(sessionContent, /GH_TOKEN=\[REDACTED\]/);
  assert.match(sessionContent, /Linha final sem quebra AWS=\[REDACTED\]/);
  assert.match(sessionContent, /- Encerramento: encerrado com JIRA_API_TOKEN=\[REDACTED\]/);
  assert.match(reportContent, /https:\/\/\[REDACTED\]@api\.internal\/v1 com x-api-key: \[REDACTED\]/);

  const parsedSidecar = FactoryTriageSidecarSchema.parse(JSON.parse(sidecarContent));
  assert.equal(
    parsedSidecar.jiraContext?.url,
    'https://[REDACTED]@empresa.atlassian.net/browse/DEV-99',
  );
  assert.equal(
    parsedSidecar.technicalContext,
    'Token [REDACTED] e "secret": "[REDACTED]"',
  );
});
