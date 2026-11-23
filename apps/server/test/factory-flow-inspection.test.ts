import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  FACTORY_DIFF_MAX_PATCH_BYTES,
  FACTORY_DIFF_MAX_PATCH_LINES,
  FactoryFlowApiErrorResponseSchema,
  FactoryFlowDiffPageSchema,
  FactoryFlowDiffPatchSchema,
  FactoryFlowIterationComparisonSchema,
} from '@development-factory/shared';
import { provisionFactoryWorktree } from '../src/factory-worktree.js';
import { createReviewServer } from '../src/server.js';
import { writeFactoryStageSidecar } from './fixtures/factory-stage-artifacts.js';

const origin = 'http://localhost:5173';

function git(path: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function setUpFlow(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'df-flow-inspection-'));
  const repoPath = join(root, 'repository');
  mkdirSync(repoPath);
  const xdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, 'xdg-data');
  const { server, factoryFlowService, shutdown } = createReviewServer({
    dbPath: join(root, 'flow.db'),
  });
  context.after(async () => {
    try {
      await shutdown();
    } finally {
      if (xdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = xdgDataHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test User');
  writeFileSync(join(repoPath, 'code.ts'), 'const version = "base";\n');
  writeFileSync(join(repoPath, 'remove.txt'), 'linha removida\n');
  writeFileSync(join(repoPath, '.gitignore'), '*.ignored\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'Base');

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const task = { repoPath, inputType: 'title', value: 'Comparação dos ciclos' };
  const { flow } = await factoryFlowService.createFlow({ task });
  const { worktreePath, baseBranch, branchName } = await provisionFactoryWorktree({
    repoPath,
    flowId: flow.id,
    target: flow.target,
  });
  await factoryFlowService.updateWorktreeMetadata(flow.id, { worktreePath, baseBranch, branchName });
  const baseUrl = `http://127.0.0.1:${address.port}/api/factory/flows/${flow.id}`;
  const get = (path: string, params: Record<string, string> = {}) =>
    fetch(`${baseUrl}/${path}?${new URLSearchParams(params)}`, { headers: { Origin: origin } });

  async function checkpoint(iteration: number) {
    const result = await factoryFlowService.createWorktreeCheckpoint(flow.id, {
      stage: 'tests',
      iteration,
    });
    assert(result);
    return result;
  }

  return { root, repoPath, worktreePath, flow, task, factoryFlowService, baseUrl, get, checkpoint };
}

test('checkpoint Git descreve alterações do índice e persiste o corpo de até 555 caracteres', async context => {
  const { worktreePath, flow, factoryFlowService, checkpoint } = await setUpFlow(context);
  git(worktreePath, 'config', 'commit.cleanup', 'strip');
  git(worktreePath, 'config', 'core.commentChar', '-');
  renameSync(join(worktreePath, 'remove.txt'), join(worktreePath, 'renamed\nnotes.txt'));
  unlinkSync(join(worktreePath, '.gitignore'));
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "checkpoint";\n');
  git(worktreePath, 'add', '--', 'code.ts');

  const addedFiles = 16;
  for (let index = 0; index < addedFiles; index += 1) {
    const name = `test-${String(index).padStart(2, '0')}-regression.test.ts`;
    writeFileSync(join(worktreePath, name), 'export {};\n');
  }

  const created = await checkpoint(2);
  const message = git(worktreePath, 'show', '-s', '--format=%B', created.commitSha).trimEnd();
  const [title, body] = message.split('\n\n');
  assert.equal(title, 'Automatic checkpoint after Tests (iteration 2)');
  assert.ok(body && body.length <= 555);
  const bullets = body.split('\n');
  assert.ok(bullets.every(bullet => bullet.startsWith('- ')));
  assert.ok(bullets.includes('- Removed ".gitignore".'));
  assert.ok(bullets.includes('- Updated "code.ts".'));
  assert.ok(bullets.includes('- Renamed "remove.txt" to "renamed\\nnotes.txt".'));
  assert.ok(bullets.includes('- Added "test-00-regression.test.ts".'));
  const remaining = /^- (\d+) additional files changed\.$/.exec(bullets.at(-1) ?? '');
  assert.ok(remaining);
  assert.equal(bullets.length - 1 + Number(remaining[1]), addedFiles + 3);

  assert.ok(message.length > 500);
  assert.equal(created.message, message);
  assert.equal(factoryFlowService.getFlow(flow.id).checkpoints[0]?.message, message);
});

test('API de diff lê o worktree isolado, pagina arquivos e limita patches', async context => {
  const { repoPath, worktreePath, get, checkpoint, baseUrl } = await setUpFlow(context);
  writeFileSync(join(repoPath, 'code.ts'), 'mudança no repositório principal\n');
  writeFileSync(join(repoPath, 'principal.txt'), 'apenas no repositório principal\n');
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "checkpoint";\n');
  await checkpoint(1);

  unlinkSync(join(worktreePath, 'remove.txt'));
  mkdirSync(join(worktreePath, 'remove.txt'));
  writeFileSync(join(worktreePath, 'remove.txt', 'child.txt'), 'arquivo novo\n');
  const stagedFile = 'a[1] ç\t.txt';
  writeFileSync(join(worktreePath, stagedFile), 'adicionado ao índice\n');
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "índice";\n');
  git(worktreePath, '--literal-pathspecs', 'add', '--', stagedFile, 'code.ts', 'remove.txt');
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "worktree";\n');
  const untrackedFile = ':(glob)*.txt';
  writeFileSync(join(worktreePath, untrackedFile), 'novo sem staging\n');
  writeFileSync(join(worktreePath, 'file.ignored'), 'ignorado\n');
  writeFileSync(join(worktreePath, 'binary.dat'), Buffer.from([0, 1, 255]));
  symlinkSync(join(repoPath, 'principal.txt'), join(worktreePath, 'link.txt'));
  writeFileSync(
    join(worktreePath, 'oversized.txt'),
    'x'.repeat(FACTORY_DIFF_MAX_PATCH_BYTES * 2) + '\n',
  );
  writeFileSync(join(worktreePath, 'many-lines.txt'), 'x\n'.repeat(FACTORY_DIFF_MAX_PATCH_LINES * 2));

  const before = git(worktreePath, 'status', '--porcelain', '-z');
  const firstResponse = await get('diff', { limit: '2' });
  assert.equal(firstResponse.status, 200);
  const first = FactoryFlowDiffPageSchema.parse(await firstResponse.json());
  const secondResponse = await get('diff', { limit: '2', offset: '2' });
  const second = FactoryFlowDiffPageSchema.parse(await secondResponse.json());
  assert.equal(first.files.length, 2);
  assert.equal(first.nextOffset, 2);
  assert.equal(second.nextOffset, 4);
  assert(!second.files.some(file => first.files.some(entry => entry.path === file.path)));

  const page = FactoryFlowDiffPageSchema.parse(await (await get('diff')).json());
  assert.equal(page.totalFiles, 9);
  assert.equal(page.nextOffset, null);
  assert(!page.truncated);
  const files = new Map(page.files.map(file => [file.path, file]));
  assert(!files.has('principal.txt'));
  assert(!files.has('file.ignored'));
  assert.deepEqual(files.get('code.ts'), {
    path: 'code.ts', change: 'modified', untracked: false, additions: 1, deletions: 1, binary: false,
  });
  assert.equal(files.get('remove.txt')?.change, 'deleted');
  assert.equal(files.get('remove.txt')?.deletions, 1);
  assert.equal(files.get('remove.txt/child.txt')?.change, 'added');
  assert.equal(files.get('binary.dat')?.binary, true);
  assert.equal(files.get(stagedFile)?.additions, 1);
  assert.equal(files.get(untrackedFile)?.additions, 1);

  async function patch(file: string, untracked = false) {
    const response = await get('diff', { file, untracked: String(untracked) });
    assert.equal(response.status, 200);
    return FactoryFlowDiffPatchSchema.parse(await response.json());
  }

  const code = await patch('code.ts');
  assert.match(code.patch, /^-const version = "base";$/m);
  assert.match(code.patch, /^\+const version = "worktree";$/m);
  assert.doesNotMatch(code.patch, /índice|repositório principal/);
  assert.match((await patch(stagedFile)).patch, /^\+adicionado ao índice$/m);
  assert.match((await patch(untrackedFile, true)).patch, /^\+novo sem staging$/m);
  assert.doesNotMatch((await patch('link.txt', true)).patch, /apenas no repositório principal/);
  const deletion = await patch('remove.txt');
  assert.match(deletion.patch, /^-linha removida$/m);
  assert.doesNotMatch(deletion.patch, /child\.txt/);
  const oversized = await patch('oversized.txt', true);
  assert(oversized.truncated);
  assert(Buffer.byteLength(oversized.patch) <= FACTORY_DIFF_MAX_PATCH_BYTES);
  const manyLines = await patch('many-lines.txt', true);
  assert(manyLines.truncated);
  assert.equal(manyLines.patch.split('\n').length, FACTORY_DIFF_MAX_PATCH_LINES);
  assert.equal(git(worktreePath, 'status', '--porcelain', '-z'), before);

  const noOrigin = await fetch(`${baseUrl}/diff`);
  assert.equal(noOrigin.status, 403);
  const invalidQueries: Record<string, string>[] = [
    { file: '../principal.txt', untracked: 'true' },
    { file: '/etc/passwd' },
    { limit: '1000' },
    { offset: '-1' },
  ];
  for (const params of invalidQueries) {
    const response = await get('diff', params);
    assert.equal(response.status, 400);
    assert.equal(
      FactoryFlowApiErrorResponseSchema.parse(await response.json()).error.code,
      'FACTORY_FLOW_INVALID_INPUT',
    );
  }
});

test('API compara checkpoints e evidências persistidas de ciclos consecutivos', async context => {
  const { root, worktreePath, flow, get, checkpoint, factoryFlowService, task } = await setUpFlow(context);
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "ciclo 1";\n');
  const cp1 = await checkpoint(1);
  writeFileSync(join(worktreePath, 'code.ts'), 'const version = "ciclo 2";\n');
  const cp2 = await checkpoint(2);
  writeFileSync(join(worktreePath, 'code.ts'), 'trabalho posterior ao checkpoint\n');
  const testCase = { id: 'T1', description: 'Validar versão', acceptanceCriteriaIds: ['CA1'] };

  for (const iteration of [1, 2]) {
    const first = iteration === 1;
    const testsReport = join(root, `tests-${iteration}.md`);
    const reviewReport = join(root, `review-${iteration}.md`);
    writeFactoryStageSidecar(testsReport, 'tests', {
      status: first ? 'failed' : 'passed',
      executedCommands: [{ command: ['npm', 'test'], exitCode: first ? 1 : 0 }],
      testCases: [{ ...testCase, status: first ? 'failed' : 'passed' }],
      coverage: { linesPercent: first ? 45 : 80, branchesPercent: null },
    });
    writeFactoryStageSidecar(reviewReport, 'review', {
      verdict: first ? 'changes_requested' : 'approved',
      returnTarget: first ? 'development' : null,
      findings: first
        ? [{ severity: 'BLOQUEANTE', file: 'code.ts', line: 1, explanation: 'A versão diverge.' }]
        : [],
    });
    await factoryFlowService.registerArtifact(flow.id, {
      stage: 'tests', kind: 'test_report', path: testsReport, status: 'ready', iteration,
    });
    await factoryFlowService.registerArtifact(flow.id, {
      stage: 'review', kind: 'review_report', path: reviewReport, status: 'ready', iteration,
    });
  }

  const historyResponse = await get('iterations', { fromIteration: '1' });
  assert.equal(historyResponse.status, 200);
  const history = FactoryFlowIterationComparisonSchema.parse(await historyResponse.json());
  assert.equal(history.before.checkpoint?.id, cp1.id);
  assert.equal(history.before.tests?.failed, 1);
  assert.equal(history.before.tests?.cases[0]?.status, 'failed');
  assert.equal(history.before.tests?.commands[0]?.exitCode, 1);
  assert.equal(history.before.review?.findings[0]?.explanation, 'A versão diverge.');
  assert.equal(history.after.checkpoint?.id, cp2.id);
  assert.equal(history.after.tests?.passed, 1);
  assert.equal(history.after.tests?.cases[0]?.status, 'passed');
  assert.equal(history.after.tests?.coverage?.linesPercent, 80);
  assert.deepEqual(history.after.review?.findings, []);
  assert.equal((await get('iterations', { fromIteration: '2' })).status, 404);

  const range = { fromCheckpointId: cp1.id, toCheckpointId: cp2.id };
  const page = FactoryFlowDiffPageSchema.parse(await (await get('diff', range)).json());
  assert.deepEqual(page.files.map(file => file.path), ['code.ts']);
  const changes = await get('diff', { ...range, file: 'code.ts' });
  assert.equal(changes.status, 200);
  const patch = FactoryFlowDiffPatchSchema.parse(await changes.json());
  assert.match(patch.patch, /^-const version = "ciclo 1";$/m);
  assert.match(patch.patch, /^\+const version = "ciclo 2";$/m);
  assert.doesNotMatch(patch.patch, /trabalho posterior/);

  const other = await factoryFlowService.createFlow({ task });
  const foreign = await factoryFlowService.registerCheckpoint(other.flow.id, {
    stage: 'tests', iteration: 1, commitSha: cp1.commitSha,
  });
  assert.equal((await get('diff', { ...range, fromCheckpointId: foreign.id })).status, 404);
  assert.equal((await get('diff', { fromCheckpointId: cp1.id })).status, 400);

  const cp3 = await checkpoint(3);
  const partial = FactoryFlowIterationComparisonSchema.parse(
    await (await get('iterations', { fromIteration: '2' })).json(),
  );
  assert.equal(partial.after.checkpoint?.id, cp3.id);
  assert.equal(partial.after.tests, null);
  assert.equal(partial.after.review, null);

  await factoryFlowService.updateWorktreeMetadata(flow.id, { worktreePath: null });
  assert.equal((await get('diff', range)).status, 409);
  const afterCleanup = FactoryFlowIterationComparisonSchema.parse(
    await (await get('iterations', { fromIteration: '1' })).json(),
  );
  assert.deepEqual(afterCleanup, history);
});
