import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultFactoryWorktreesDirectory } from '../src/artifacts.js';
import {
  FactoryWorktreeError,
  buildFactoryBranchSlug,
  provisionFactoryWorktree,
  verifyExistingFactoryWorktree,
} from '../src/factory-worktree.js';

function createTempEnv(prefix: string): {
  rootDir: string;
  repoDir: string;
  xdgDataHome: string;
  restore: () => void;
} {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdgDataHome;

  return {
    rootDir,
    repoDir,
    xdgDataHome,
    restore: () => {
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function initGitRepoWithCommits(repoDir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'app.ts'), 'export const version = 1;\n');
  execFileSync('git', ['add', 'app.ts'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });
}

test('buildFactoryBranchSlug normaliza chave Jira, URL Jira e títulos com acentos', () => {
  const flowId = randomUUID();
  assert.equal(
    buildFactoryBranchSlug({ inputType: 'jira_key', value: 'PROD-1234' }, flowId),
    'prod-1234',
  );
  assert.equal(
    buildFactoryBranchSlug(
      { inputType: 'jira_url', value: 'https://empresa.atlassian.net/browse/DEV-987' },
      flowId,
    ),
    'dev-987',
  );
  assert.equal(
    buildFactoryBranchSlug(
      { inputType: 'title', value: 'Implementar Autenticação JWT & OAuth2!' },
      flowId,
    ),
    'implementar-autenticacao-jwt-oauth2',
  );
  assert.equal(
    buildFactoryBranchSlug({ inputType: 'title', value: '🚀🔥' }, flowId),
    `flow-${flowId.slice(0, 8)}`,
  );
});

test('provisionFactoryWorktree cria worktree externo isolado com branch dedicada sem tocar o working tree original', async () => {
  const env = createTempEnv('df-worktree-isolate-');
  try {
    initGitRepoWithCommits(env.repoDir);

    // Cria branch separada 'develop' com um commit adicional e depois move o usuário para 'feature/wip' com sujeira local.
    execFileSync('git', ['checkout', '-b', 'develop'], { cwd: env.repoDir });
    writeFileSync(join(env.repoDir, 'develop-only.txt'), 'from develop\n');
    execFileSync('git', ['add', 'develop-only.txt'], { cwd: env.repoDir });
    execFileSync('git', ['commit', '-m', 'develop commit'], { cwd: env.repoDir });

    execFileSync('git', ['checkout', '-b', 'feature/local-wip', 'main'], { cwd: env.repoDir });
    writeFileSync(join(env.repoDir, 'app.ts'), 'export const version = 999;\n');
    writeFileSync(join(env.repoDir, 'untracked-wip.txt'), 'local developer wip\n');

    const flowId = randomUUID();
    const provisioned = await provisionFactoryWorktree({
      repoPath: env.repoDir,
      flowId,
      target: { inputType: 'jira_key', value: 'PROD-42' },
      baseBranch: 'develop',
    });

    assert.equal(provisioned.branchName, 'factory/prod-42');
    assert.equal(provisioned.baseBranch, 'develop');
    assert.equal(provisioned.worktreePath, join(defaultFactoryWorktreesDirectory(), flowId));
    assert.equal(statSync(defaultFactoryWorktreesDirectory()).mode & 0o777, 0o700);
    assert.equal(statSync(provisioned.worktreePath).mode & 0o777, 0o700);
    assert.equal(existsSync(join(provisioned.worktreePath, 'develop-only.txt')), true);
    assert.equal(existsSync(join(provisioned.worktreePath, 'untracked-wip.txt')), false);
    assert.equal(readFileSync(join(provisioned.worktreePath, 'app.ts'), 'utf8'), 'export const version = 1;\n');
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: provisioned.worktreePath, encoding: 'utf8' }).trim(),
      'factory/prod-42',
    );

    // O working tree original do desenvolvedor permanece intacto.
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: env.repoDir, encoding: 'utf8' }).trim(),
      'feature/local-wip',
    );
    assert.equal(readFileSync(join(env.repoDir, 'app.ts'), 'utf8'), 'export const version = 999;\n');
    assert.equal(readFileSync(join(env.repoDir, 'untracked-wip.txt'), 'utf8'), 'local developer wip\n');
    assert.equal(existsSync(join(env.repoDir, 'develop-only.txt')), false);

    // verifyExistingFactoryWorktree confirma validade do worktree.
    const verified = await verifyExistingFactoryWorktree({
      repoPath: env.repoDir,
      worktreePath: provisioned.worktreePath,
    });
    assert.equal(verified, provisioned.worktreePath);
  } finally {
    env.restore();
  }
});

test('provisionFactoryWorktree resolve colisão de branch e suporta provisionamento concorrente no mesmo repositório', async () => {
  const env = createTempEnv('df-worktree-concurrent-');
  try {
    initGitRepoWithCommits(env.repoDir);

    const flowOne = randomUUID();
    const flowTwo = randomUUID();
    const [first, second] = await Promise.all([
      provisionFactoryWorktree({
        repoPath: env.repoDir,
        flowId: flowOne,
        target: { inputType: 'jira_key', value: 'PROD-777' },
      }),
      provisionFactoryWorktree({
        repoPath: env.repoDir,
        flowId: flowTwo,
        target: { inputType: 'jira_key', value: 'PROD-777' },
      }),
    ]);

    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branchName, second.branchName);
    assert.equal(first.baseBranch, 'main');
    assert.equal(second.baseBranch, 'main');
    const branches = [first.branchName, second.branchName].sort();
    assert.equal(branches[0], 'factory/prod-777');
    assert.match(branches[1] ?? '', /^factory\/prod-777-[0-9a-f]{8}$/);
  } finally {
    env.restore();
  }
});

test('provisionFactoryWorktree trata falhas (branch base inexistente, repo vazio/não-git/corrompido e erro no checkout) sem deixar órfãos', async () => {
  const env = createTempEnv('df-worktree-failures-');
  try {
    const nonGitDir = join(env.rootDir, 'non-git');
    mkdirSync(nonGitDir);
    await assert.rejects(
      () =>
        provisionFactoryWorktree({
          repoPath: nonGitDir,
          flowId: randomUUID(),
          target: { inputType: 'title', value: 'Repo inválido' },
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'INVALID_GIT_REPOSITORY',
    );

    const emptyGitDir = join(env.rootDir, 'empty-git');
    mkdirSync(emptyGitDir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: emptyGitDir });
    await assert.rejects(
      () =>
        provisionFactoryWorktree({
          repoPath: emptyGitDir,
          flowId: randomUUID(),
          target: { inputType: 'title', value: 'Repo vazio' },
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'EMPTY_REPOSITORY',
    );

    initGitRepoWithCommits(env.repoDir);
    await assert.rejects(
      () =>
        provisionFactoryWorktree({
          repoPath: env.repoDir,
          flowId: randomUUID(),
          target: { inputType: 'jira_key', value: 'PROD-10' },
          baseBranch: 'branch-inexistente',
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'BASE_BRANCH_NOT_FOUND',
    );

    // Simula falha no meio do `git worktree add` via hook post-checkout retornando erro.
    const hookPath = join(env.repoDir, '.git', 'hooks', 'post-checkout');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failedFlowId = randomUUID();
    await assert.rejects(
      () =>
        provisionFactoryWorktree({
          repoPath: env.repoDir,
          flowId: failedFlowId,
          target: { inputType: 'jira_key', value: 'PROD-99' },
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'WORKTREE_PROVISION_FAILED',
    );
    rmSync(hookPath, { force: true });

    const worktreesRoot = defaultFactoryWorktreesDirectory();
    assert.deepEqual(existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : [], []);
    assert.equal(
      execFileSync('git', ['branch', '--list', 'factory/prod-99'], { cwd: env.repoDir, encoding: 'utf8' }).trim(),
      '',
    );

    // Simula repositório corrompido (.git/HEAD inválido).
    const corruptedDir = join(env.rootDir, 'corrupted-git');
    mkdirSync(corruptedDir);
    initGitRepoWithCommits(corruptedDir);
    writeFileSync(join(corruptedDir, '.git', 'HEAD'), 'corrupted-head\n');
    await assert.rejects(
      () =>
        provisionFactoryWorktree({
          repoPath: corruptedDir,
          flowId: randomUUID(),
          target: { inputType: 'title', value: 'Corrompido' },
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'INVALID_GIT_REPOSITORY',
    );
    assert.deepEqual(existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : [], []);
  } finally {
    env.restore();
  }
});

test('verifyExistingFactoryWorktree rejeita worktree ausente ou symlink fora da raiz gerenciada', async () => {
  const env = createTempEnv('df-worktree-verify-');
  try {
    initGitRepoWithCommits(env.repoDir);
    const flowId = randomUUID();
    const provisioned = await provisionFactoryWorktree({
      repoPath: env.repoDir,
      flowId,
      target: { inputType: 'jira_key', value: 'PROD-55' },
    });

    const symlinkPath = join(defaultFactoryWorktreesDirectory(), randomUUID());
    symlinkSync(env.repoDir, symlinkPath);
    await assert.rejects(
      () =>
        verifyExistingFactoryWorktree({
          repoPath: env.repoDir,
          worktreePath: symlinkPath,
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'WORKTREE_INVALID',
    );

    rmSync(provisioned.worktreePath, { recursive: true, force: true });
    await assert.rejects(
      () =>
        verifyExistingFactoryWorktree({
          repoPath: env.repoDir,
          worktreePath: provisioned.worktreePath,
        }),
      error => error instanceof FactoryWorktreeError && error.code === 'WORKTREE_INVALID',
    );
  } finally {
    env.restore();
  }
});
