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
import { createFactoryHistory } from '../src/history.js';

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

test('preserva saída sem ANSI entre chunks e identifica planejamento interrompido em diretório externo', context => {
  const { repoDir, xdgDataHome } = createIsolatedHistoryEnv(context);
  const flowId = randomUUID();
  const states: string[] = [];
  const history = createFactoryHistory(
    { inputType: 'title', value: '123', repoPath: repoDir, flowId },
    state => states.push(state),
    message => assert.fail(message),
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
  assert.match(readFileSync(history.reportPath, 'utf8'), /Plano da tarefa incompleto/);
  assert.deepEqual(states, ['incomplete']);
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(dirname(history.reportPath), join(xdgDataHome, 'development-factory', 'artifacts', flowId));
});

test('preserva o Markdown final, cria arquivos distintos fora do repositório e aplica permissões restritas', context => {
  const { repoDir, xdgDataHome } = createIsolatedHistoryEnv(context);
  const flowId = randomUUID();
  const request = { inputType: 'title', value: '../../feature', repoPath: repoDir, flowId } as const;
  const states: string[] = [];
  const first = createFactoryHistory(request, state => states.push(state), message => assert.fail(message));
  const second = createFactoryHistory(
    { inputType: 'title', value: '../../feature', repoPath: repoDir },
    () => {},
    message => assert.fail(message),
  );
  assert.notEqual(first.reportPath, second.reportPath);
  const expectedFlowDir = join(xdgDataHome, 'development-factory', 'artifacts', flowId);
  const expectedRootDir = join(xdgDataHome, 'development-factory', 'artifacts');
  assert.equal(dirname(first.reportPath), expectedFlowDir);
  assert.equal(dirname(first.sessionPath), expectedFlowDir);
  assert.equal(dirname(second.reportPath), expectedRootDir);
  assert.equal(existsSync(join(repoDir, '.code-reviews')), false);
  assert.equal(statSync(expectedRootDir).mode & 0o777, 0o700);
  assert.equal(statSync(expectedFlowDir).mode & 0o777, 0o700);
  assert.equal(statSync(first.reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(first.sessionPath).mode & 0o777, 0o600);

  const result = '# Review\n\n## Veredito\nAJUSTES NECESSÁRIOS\n';
  writeFileSync(first.reportPath, result);
  first.finish('concluído');
  second.finish('interrompido');
  assert.equal(readFileSync(first.reportPath, 'utf8'), result);
  assert.deepEqual(states, ['saved']);
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
