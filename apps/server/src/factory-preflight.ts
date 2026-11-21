import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FACTORY_FLOW_CONTRACT_VERSION,
  FactoryPreflightResponseSchema,
} from '@development-factory/shared';
import type {
  FactoryFlowInputType,
  FactoryPreflightCheck,
  FactoryPreflightRequest,
  FactoryPreflightResponse,
} from '@development-factory/shared';
import {
  FactoryRepositoryProfileError,
  loadFactoryRepositoryProfile,
} from './factory-repository-profile.js';
import {
  FactoryWorktreeError,
  resolveValidGitRepoRoot,
  verifyFactoryGitRepository,
} from './factory-worktree.js';

const execFileAsync = promisify(execFile);
const PREFLIGHT_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 64 * 1024;
const JIRA_MCP_NAME = 'claude.ai Atlassian Rovo';

const gitTimeout: FactoryPreflightCheck = {
  status: 'error',
  message: 'A verificação do Git excedeu o tempo limite. Confira o acesso à pasta e tente novamente.',
};

function runCommand(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  cwd?: string,
) {
  signal.throwIfAborted();
  return execFileAsync(executable, args, {
    cwd,
    signal,
    killSignal: 'SIGKILL',
    maxBuffer: COMMAND_MAX_BUFFER,
    env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
}

async function checkClaude(signal: AbortSignal): Promise<FactoryPreflightCheck> {
  try {
    await runCommand('claude', ['--version'], signal);
    return { status: 'ok', message: 'O Claude Code está disponível no WSL.' };
  } catch {
    return {
      status: 'error',
      message: signal.aborted
        ? 'O Claude Code excedeu o tempo limite. Execute claude --version no WSL e tente novamente.'
        : 'Instale o Claude Code no WSL e confirme que claude --version funciona no terminal.',
    };
  }
}

async function checkGitHub(signal: AbortSignal): Promise<FactoryPreflightCheck> {
  try {
    await runCommand('gh', ['auth', 'status'], signal);
    return { status: 'ok', message: 'O GitHub CLI confirmou a autenticação.' };
  } catch {
    return {
      status: 'warning',
      message: signal.aborted
        ? 'A verificação do GitHub excedeu o tempo limite. Execute gh auth status antes da etapa de PR.'
        : 'Confira a instalação do GitHub CLI no WSL e use gh auth login antes da etapa de PR.',
    };
  }
}

async function checkJiraMcp(
  inputType: FactoryFlowInputType,
  repoRoot: string | null,
  signal: AbortSignal,
): Promise<FactoryPreflightCheck> {
  if (inputType === 'title') {
    return { status: 'ok', message: 'A entrada por título dispensa o MCP do Jira.' };
  }
  if (repoRoot === null) {
    return { status: 'warning', message: 'Selecione um repositório Git válido para verificar o Jira.' };
  }

  try {
    const { stdout } = await runCommand('claude', ['mcp', 'get', JIRA_MCP_NAME], signal, repoRoot);
    if (stdout.split('\n').some(line => /^\s*Status:\s*(?:✓\s*)?Connected\s*$/i.test(line))) {
      return { status: 'ok', message: 'O MCP do Jira está conectado pelo Atlassian Rovo.' };
    }
  } catch {
    if (signal.aborted) {
      return {
        status: 'error',
        message: 'O MCP do Jira excedeu o tempo limite. Confira a conexão do Atlassian Rovo e tente novamente.',
      };
    }
  }
  return {
    status: 'error',
    message: 'Conecte o Atlassian Rovo em /mcp no Claude Code e confirme que a conta tem acesso ao Jira.',
  };
}

async function checkProfile(repoRoot: string): Promise<{
  check: FactoryPreflightCheck;
  baseBranch: string | null;
}> {
  try {
    const { source, profile } = await loadFactoryRepositoryProfile(repoRoot);
    return {
      check: {
        status: 'ok',
        message: source === 'manifest'
          ? 'O manifesto .development-factory.json é válido.'
          : 'A Factory usará o perfil padrão deste repositório.',
      },
      baseBranch: profile.baseBranch,
    };
  } catch (error) {
    return {
      check: {
        status: 'error',
        message: error instanceof FactoryRepositoryProfileError
          ? error.message
          : 'Confira o acesso ao manifesto .development-factory.json e tente novamente.',
      },
      baseBranch: null,
    };
  }
}

async function checkGit(
  repoRoot: string,
  baseBranch: string | null,
  signal: AbortSignal,
): Promise<FactoryPreflightCheck> {
  try {
    const resolvedBase = await verifyFactoryGitRepository(repoRoot, baseBranch, signal);
    return { status: 'ok', message: `O repositório Git está íntegro e a base "${resolvedBase}" existe.` };
  } catch (error) {
    if (signal.aborted) {
      return gitTimeout;
    }
    if (error instanceof FactoryWorktreeError) {
      return { status: 'error', message: error.message };
    }
    return {
      status: 'error',
      message: 'Execute git fsck no repositório e corrija os problemas de integridade antes de tentar novamente.',
    };
  }
}

async function checkRepository(
  repoRoot: string | null,
  input: FactoryPreflightRequest,
  signal: AbortSignal,
  deadline: Promise<null>,
): Promise<Pick<FactoryPreflightResponse['checks'], 'git' | 'profile'>> {
  if (repoRoot === null) {
    return {
      git: signal.aborted
        ? gitTimeout
        : {
            status: 'error',
            message: 'Confira se o Git está instalado e selecione a pasta de um repositório Git válido no WSL.',
          },
      profile: {
        status: 'warning',
        message: 'Selecione um repositório Git válido para verificar o manifesto .development-factory.json.',
      },
    };
  }

  const profile = await Promise.race([checkProfile(repoRoot), deadline]);
  const baseBranch = input.baseBranch ?? profile?.baseBranch ?? null;
  const git = await Promise.race([checkGit(repoRoot, baseBranch, signal), deadline]);
  return {
    git: git ?? gitTimeout,
    profile: profile?.check ?? {
      status: 'error',
      message: 'A leitura do manifesto excedeu o tempo limite. Confira o acesso à pasta e tente novamente.',
    },
  };
}

export async function runFactoryPreflight(
  input: FactoryPreflightRequest,
): Promise<FactoryPreflightResponse> {
  const signal = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
  const deadline = new Promise<null>(resolve => {
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  const repoRoot = Promise.race([
    resolveValidGitRepoRoot(input.repoPath, signal).catch(() => null),
    deadline,
  ]);
  const [claude, github, jiraMcp, repository] = await Promise.all([
    checkClaude(signal),
    checkGitHub(signal),
    repoRoot.then(root => checkJiraMcp(input.inputType, root, signal)),
    repoRoot.then(root => checkRepository(root, input, signal, deadline)),
  ]);
  const checks = { claude, jiraMcp, github, ...repository };
  return FactoryPreflightResponseSchema.parse({
    contractVersion: FACTORY_FLOW_CONTRACT_VERSION,
    blocked: Object.values(checks).some(check => check.status === 'error'),
    checks,
  });
}
