import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import {
  FactoryFlowDetailsSchema,
  FactoryPlanningSidecarSchema,
  evaluateFactoryTriageGate,
  resolvePlanningPendingDecisionId,
} from '@development-factory/shared';
import type {
  BackgroundSessionSummary,
  FactoryFlowDetails,
  FactoryPlanningPendingDecision,
} from '@development-factory/shared';
import { loadFactoryRepositoryProfile } from '../src/factory-repository-profile.js';
import {
  FactoryStageArtifactError,
  buildPlanningBashAllowedTools,
  buildTriageAndPlanningRunnerArgs,
  readFactoryStageSidecar,
} from '../src/factory-stage-runners.js';
import { validateFactoryStageArtifacts } from '../src/history.js';
import {
  PLANNING_PENDING_QUESTIONS_SECTION,
  buildFactoryArchitecturePrompt,
} from '../src/prompts/factory-architecture.js';
import { buildFactoryPlanPrompt } from '../src/prompts/factory-plan.js';
import { createReviewServer } from '../src/server.js';
import {
  planningMarkdown,
  sidecarFixtures,
  triageMarkdown,
  writeFactoryStageSidecar,
} from './fixtures/factory-stage-artifacts.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function initGitRepo(repoDir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, '.gitignore'), '.env.local\ndev.sqlite\n');
  writeFileSync(join(repoDir, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

async function waitFor<T>(
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let current = await probe();
  while (!predicate(current)) {
    if (Date.now() > deadline) {
      throw new Error(`Tempo limite excedido aguardando: ${label}`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
    current = await probe();
  }
  return current;
}

const ReadyLaunchSchema = z.object({
  cwd: z.string(),
  args: z.array(z.string()),
});

async function createPhase2Harness(context: { after: (fn: () => Promise<void> | void) => void }) {
  const rootDir = mkdtempSync(join(tmpdir(), 'df-phase2-'));
  const binDir = join(rootDir, 'bin');
  const repoDir = join(rootDir, 'repo');
  const xdgDataHome = join(rootDir, 'xdg-data');
  const dbPath = join(rootDir, 'reviews.db');
  mkdirSync(binDir);
  mkdirSync(repoDir);
  mkdirSync(xdgDataHome);
  initGitRepo(repoDir);

  const claudeTarget = join(binDir, 'claude');
  copyFileSync(new URL('./fixtures/claude.ts', import.meta.url), claudeTarget);
  chmodSync(claudeTarget, 0o755);

  const previousPath = process.env.PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.XDG_DATA_HOME = xdgDataHome;

  const created = createReviewServer({ dbPath });
  created.server.listen(0, '127.0.0.1');
  await once(created.server, 'listening');

  const address = created.server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await created.shutdown();
    process.env.PATH = previousPath;
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  const fetchFlowDetails = async (flowId: string): Promise<FactoryFlowDetails> => {
    const response = await fetch(`${baseUrl}/api/factory/flows/${flowId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(response.status, 200);
    return FactoryFlowDetailsSchema.parse(await response.json());
  };

  const readSessionLaunch = async (sessionId: string) => {
    const replay = await waitFor(
      () => created.sessionManager.getSession(sessionId)?.buffer.replay() ?? '',
      value => /READY:[^\n]*\n/.test(value),
      `READY da sessão ${sessionId}`,
    );
    const readyLine = replay.split(/\r?\n/).find(line => line.startsWith('READY:'));
    assert.ok(readyLine);
    return ReadyLaunchSchema.parse(JSON.parse(readyLine.slice('READY:'.length)) as unknown);
  };

  return { rootDir, repoDir, baseUrl, server: created, fetchFlowDetails, readSessionLaunch };
}

test(
  'Fase 2.1: Triagem declarativa encaminha lacunas ao Planejamento e registra erro objetivo quando Jira falha',
  { timeout: 25_000 },
  async context => {
    const harness = await createPhase2Harness(context);

    // Prompt da Triagem instrui linguagem declarativa e proíbe perguntas interativas.
    const triagePrompt = buildFactoryPlanPrompt('jira_key', 'PAY-10', '/tmp/triage.md');
    assert.match(triagePrompt, /modo estritamente não interativo/i);
    assert.match(triagePrompt, /nunca formule perguntas dirigidas ao usuário/i);
    assert.match(triagePrompt, /Lacunas e Pontos para Investigação/);

    // 1) Tarefa completa: avança automaticamente para Planejamento sem perguntas interativas.
    const completeRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Adicionar validação de CPF', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(completeRes.status, 201);
    const completeCreated = (await completeRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    assert.ok(completeCreated.session.reportPath);
    await harness.readSessionLaunch(completeCreated.session.sessionId);
    writeFileSync(
      completeCreated.session.reportPath,
      triageMarkdown('Quando o cliente informa CPF inválido, a API deve responder 400.'),
    );
    writeFactoryStageSidecar(completeCreated.session.reportPath, 'triage', {
      blockers: [],
      jiraError: null,
    });
    harness.server.sessionManager.writeInput(completeCreated.session.sessionId, 'EXIT0');

    const completeInPlanning = await waitFor(
      () => harness.fetchFlowDetails(completeCreated.flow.id),
      details =>
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'running' &&
        details.flow.currentSessionId !== null,
      'tarefa completa avançar automaticamente ao Planejamento',
    );
    assert.equal(completeInPlanning.triageGate, undefined);

    // 2) Tarefa ambígua: lacunas investigáveis vão em linguagem declarativa para o Planejamento.
    const ambiguousRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Ajustar regra de cupom', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(ambiguousRes.status, 201);
    const ambiguousCreated = (await ambiguousRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    assert.ok(ambiguousCreated.session.reportPath);
    await harness.readSessionLaunch(ambiguousCreated.session.sessionId);
    const gapText =
      'A task não informa se o limite de desconto incide antes ou depois do frete; investigar cálculo atual no serviço de checkout.';
    writeFileSync(
      ambiguousCreated.session.reportPath,
      `${triageMarkdown('Quando aplica cupom, o desconto respeita o limite.')}#### 6. Lacunas e Pontos para Investigação\n- ${gapText}\n`,
    );
    writeFactoryStageSidecar(ambiguousCreated.session.reportPath, 'triage', {
      blockers: [gapText],
      jiraError: null,
    });
    assert.equal(
      evaluateFactoryTriageGate({ ...sidecarFixtures.triage, blockers: [gapText], jiraError: null })
        .blocked,
      false,
    );
    harness.server.sessionManager.writeInput(ambiguousCreated.session.sessionId, 'EXIT0');

    const ambiguousInPlanning = await waitFor(
      () => harness.fetchFlowDetails(ambiguousCreated.flow.id),
      details =>
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'running' &&
        details.flow.currentSessionId !== null,
      'tarefa ambígua encaminhar lacunas ao Planejamento',
    );
    assert.ok(ambiguousInPlanning.flow.currentSessionId);
    const planningLaunch = await harness.readSessionLaunch(ambiguousInPlanning.flow.currentSessionId);
    const planningPrompt = planningLaunch.args.at(-1) ?? '';
    assert.match(planningPrompt, /LACUNAS ENCAMINHADAS PELA TRIAGEM/);
    assert.ok(planningPrompt.includes(gapText));

    // 3) Jira indisponível: registra erro objetivo no estado da etapa e NÃO inicia Planejamento.
    const jiraFailRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'jira_key', value: 'PAY-503', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(jiraFailRes.status, 201);
    const jiraFailCreated = (await jiraFailRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    assert.ok(jiraFailCreated.session.reportPath);
    await harness.readSessionLaunch(jiraFailCreated.session.sessionId);
    writeFileSync(
      jiraFailCreated.session.reportPath,
      `${triageMarkdown('A consulta ao Jira falhou e impediu consolidar os requisitos.')}#### 6. Lacunas e Pontos para Investigação\n- Jira MCP retornou 503 Service Unavailable.\n`,
    );
    writeFactoryStageSidecar(jiraFailCreated.session.reportPath, 'triage', {
      blockers: [],
      jiraError: 'Jira MCP indisponível (503 Service Unavailable)',
    });
    harness.server.sessionManager.writeInput(jiraFailCreated.session.sessionId, 'EXIT0');

    const jiraBlocked = await waitFor(
      () => harness.fetchFlowDetails(jiraFailCreated.flow.id),
      details =>
        details.flow.currentStage === 'triage' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null,
      'erro objetivo na Triagem por Jira indisponível',
    );
    assert.equal(jiraBlocked.flow.error?.code, 'FACTORY_TRIAGE_JIRA_ERROR');
    assert.match(jiraBlocked.flow.error?.message ?? '', /503 Service Unavailable/);
    const triageStage = jiraBlocked.stages.find(stage => stage.name === 'triage');
    assert.equal(triageStage?.error?.code, 'FACTORY_TRIAGE_JIRA_ERROR');
    assert.equal(jiraBlocked.triageGate?.blocked, true);
    assert.equal(
      harness.server.sessionManager
        .listSessions()
        .filter(session => session.flowId === jiraFailCreated.flow.id && session.stage === 'planning')
        .length,
      0,
    );
  },
);

test(
  'Fase 2.2: habilita verificações no ambiente de desenvolvimento com rollback/isolamento e registra limitação de staging',
  { timeout: 15_000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-phase2-dev-env-'));
    const repoDir = join(rootDir, 'repo');
    mkdirSync(repoDir);
    initGitRepo(repoDir);
    context.after(() => rmSync(rootDir, { recursive: true, force: true }));

    // Cria banco SQLite local de desenvolvimento (ignorado pelo Git) e um script de verificação reversível.
    const devDbPath = join(repoDir, 'dev.sqlite');
    const devDb = new DatabaseSync(devDbPath);
    devDb.exec(`
      CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO orders (id, status) VALUES ('seed-1', 'confirmed');
    `);
    devDb.close();

    writeFileSync(join(repoDir, '.env.local'), 'DEV_DB_PATH=./dev.sqlite\n');
    writeFileSync(
      join(repoDir, '.development-factory.json'),
      JSON.stringify({
        baseBranch: 'main',
        stack: ['TypeScript', 'Node.js', 'SQLite (dev)'],
        commands: {
          typecheck: ['npm', 'run', 'typecheck'],
          test: ['npm', 'test'],
        },
        devEnvironment: {
          verificationCommands: [
            {
              name: 'Smoke test com banco de desenvolvimento',
              command: ['node', 'scripts/verify-dev-db.mjs'],
              description: 'Grava e lê pedido sintético dentro de transação com rollback.',
              usesDevDatabase: true,
              mutatesTestData: true,
            },
          ],
          devDatabase: {
            engine: 'SQLite',
            connectionEnvVar: 'DEV_DB_PATH',
            notes: 'Sempre executar gravações de teste em transação com ROLLBACK.',
          },
          envFiles: ['.env.local'],
          stagingOnlyDependencies: ['Webhook de pagamento do parceiro (credenciais apenas em staging)'],
        },
      }),
    );

    const { profile } = await loadFactoryRepositoryProfile(repoDir);
    assert.equal(profile.devEnvironment?.devDatabase?.engine, 'SQLite');
    assert.equal(profile.devEnvironment?.verificationCommands?.length, 1);

    // Runner de Planejamento libera whitelist estrita de Bash + leitura do repo raiz, mantendo escrita travada e sem AskUserQuestion.
    const reportPath = join(rootDir, 'planning.md');
    const bashAllowed = buildPlanningBashAllowedTools(profile);
    assert.ok(bashAllowed.includes('Bash(npm run typecheck)'));
    assert.ok(bashAllowed.includes('Bash(npm test)'));
    assert.ok(bashAllowed.includes('Bash(node scripts/verify-dev-db.mjs)'));

    const runnerArgs = buildTriageAndPlanningRunnerArgs('planning', reportPath, {
      repositoryProfile: profile,
      repoPath: repoDir,
    });
    const toolsArg = runnerArgs[runnerArgs.indexOf('--tools') + 1] ?? '';
    const allowedArg = runnerArgs[runnerArgs.indexOf('--allowedTools') + 1] ?? '';
    const deniedArg = runnerArgs[runnerArgs.indexOf('--disallowedTools') + 1] ?? '';
    assert.equal(toolsArg, 'Read,Glob,Grep,Edit,Write,Bash');
    assert.match(allowedArg, /Bash\(node scripts\/verify-dev-db\.mjs\)/);
    assert.match(deniedArg, /AskUserQuestion/);
    assert.match(deniedArg, /Bash\(git push\*\)/);
    assert.match(deniedArg, /Bash\(bash \*\)/);
    assert.ok(runnerArgs.includes(repoDir));

    // Prompt de Planejamento recebe o contexto de devEnvironment e exige dados isolados/reversíveis + registro de staging.
    const prompt = buildFactoryArchitecturePrompt({
      inputType: 'title',
      value: 'Validar persistência de pedidos',
      reportPath,
      repositoryProfile: profile,
    });
    assert.match(prompt, /devEnvironment/);
    assert.match(prompt, /verify-dev-db\.mjs/);
    assert.match(prompt, /isoladas ou reversíveis/i);
    assert.match(prompt, /Dependências exclusivas de staging/i);

    // Exercita um fluxo real que grava e lê dados de teste no banco dev com rollback comprovado.
    const checkDb = new DatabaseSync(devDbPath);
    checkDb.exec('BEGIN');
    checkDb.prepare('INSERT INTO orders (id, status) VALUES (?, ?)').run('test-tmp-1', 'pending');
    const inserted = checkDb
      .prepare('SELECT id, status FROM orders WHERE id = ?')
      .get('test-tmp-1') as { id: string; status: string } | undefined;
    assert.ok(inserted);
    assert.equal(inserted.id, 'test-tmp-1');
    assert.equal(inserted.status, 'pending');
    checkDb.exec('ROLLBACK');
    const remainingRows = checkDb.prepare('SELECT id, status FROM orders').all() as Array<{
      id: string;
      status: string;
    }>;
    checkDb.close();
    assert.deepEqual(
      remainingRows.map(row => ({ id: row.id, status: row.status })),
      [{ id: 'seed-1', status: 'confirmed' }],
    );

    // Sidecar valida evidências de verificação local + limitação concreta de staging.
    const validWithVerifications = FactoryPlanningSidecarSchema.parse({
      ...sidecarFixtures.planning,
      localVerifications: [
        {
          target: 'Fluxo de criação de pedido no banco dev (dev.sqlite)',
          status: 'passed',
          evidence: 'Inserção e leitura de test-tmp-1 confirmadas; estado após ROLLBACK preservou apenas seed-1.',
          isolationOrRollback: 'Transação SQLite revertida via ROLLBACK; zero registros sintéticos restantes.',
          stagingLimitation: null,
        },
        {
          target: 'Webhook do parceiro de pagamento',
          status: 'blocked_by_staging',
          evidence: 'Endpoint configurado requer assinatura HMAC do parceiro ausente em .env.local.',
          isolationOrRollback: null,
          stagingLimitation: 'Credenciais e segredo HMAC do parceiro estão disponíveis somente no ambiente de staging.',
        },
      ],
    });
    assert.equal(validWithVerifications.localVerifications?.length, 2);

    // Exige stagingLimitation quando status é blocked_by_staging.
    const missingStagingLimitation = FactoryPlanningSidecarSchema.safeParse({
      ...sidecarFixtures.planning,
      localVerifications: [
        {
          target: 'Webhook do parceiro',
          status: 'blocked_by_staging',
          evidence: 'Falhou ao autenticar localmente.',
          stagingLimitation: null,
        },
      ],
    });
    assert.equal(missingStagingLimitation.success, false);
  },
);

test(
  'Fase 2.3: restringe perguntas à última seção do plano, preserva IDs no sidecar e lê artefato legado',
  { timeout: 15_000 },
  async context => {
    const rootDir = mkdtempSync(join(tmpdir(), 'df-phase2-questions-'));
    context.after(() => rmSync(rootDir, { recursive: true, force: true }));

    // 1) Plano totalmente resolvido: omite a seção final e grava pendingDecisions: [].
    const resolvedPath = join(rootDir, 'resolved-plan.md');
    writeFileSync(resolvedPath, planningMarkdown('Todas as dúvidas resolvidas no banco dev.'));
    writeFactoryStageSidecar(resolvedPath, 'planning', {
      pendingDecisions: [],
      localVerifications: [
        {
          target: 'Consulta de saldo no banco dev',
          status: 'passed',
          evidence: 'Fluxo confirmado sem ambiguidades.',
          isolationOrRollback: 'Consulta somente leitura.',
          stagingLimitation: null,
        },
      ],
    });
    const resolvedSidecar = validateFactoryStageArtifacts('planning', resolvedPath);
    assert.equal(resolvedSidecar.stage, 'planning');
    assert.deepEqual(resolvedSidecar.pendingDecisions, []);

    // Se incluir a seção final mesmo com pendingDecisions vazio -> rejeita.
    const resolvedWithExtraSection = join(rootDir, 'resolved-with-section.md');
    writeFileSync(
      resolvedWithExtraSection,
      `${planningMarkdown('Tudo resolvido.')}\n## ${PLANNING_PENDING_QUESTIONS_SECTION}\nNenhuma pergunta.\n`,
    );
    writeFactoryStageSidecar(resolvedWithExtraSection, 'planning', { pendingDecisions: [] });
    assert.throws(
      () => validateFactoryStageArtifacts('planning', resolvedWithExtraSection),
      error =>
        error instanceof FactoryStageArtifactError &&
        error.code === 'FACTORY_MARKDOWN_INVALID' &&
        /omitida/i.test(error.message),
    );

    // 2) Plano com pendência dependente de staging: última seção válida com ID P1 + evidências + motivo.
    const stagingDecision: FactoryPlanningPendingDecision = {
      id: 'P1',
      question: 'Qual política de retry o webhook do parceiro exige em staging (429)?',
      options: ['Backoff exponencial até 3 tentativas', 'Fila DLQ imediata'],
      recommendedOption: 'Backoff exponencial até 3 tentativas',
      checksPerformed: [
        'Leitura de src/payments/webhook.ts e testes unitários locais.',
        'Tentativa de validação local sem credenciais do parceiro em .env.local.',
      ],
      unresolvableReason:
        'O cabeçalho Retry-After do parceiro só é observável no ambiente de staging com credenciais homologadas.',
    };
    const pendingPath = join(rootDir, 'pending-plan.md');
    writeFileSync(
      pendingPath,
      [
        planningMarkdown('Diagnóstico com pendência dependente de staging.'),
        `## ${PLANNING_PENDING_QUESTIONS_SECTION}`,
        `- **P1**: ${stagingDecision.question}`,
        `  - **Opção Recomendada:** ${stagingDecision.recommendedOption}`,
        '  - **Alternativa:** Fila DLQ imediata',
        `  - **Verificações realizadas:** ${stagingDecision.checksPerformed?.join(' ')}`,
        `  - **Motivo:** ${stagingDecision.unresolvableReason}`,
        '',
      ].join('\n'),
    );
    writeFactoryStageSidecar(pendingPath, 'planning', {
      pendingDecisions: [stagingDecision],
    });
    const validatedPending = validateFactoryStageArtifacts('planning', pendingPath);
    assert.equal(validatedPending.stage, 'planning');
    assert.equal(validatedPending.pendingDecisions[0]?.id, 'P1');
    assert.equal(
      validatedPending.pendingDecisions[0]?.unresolvableReason,
      stagingDecision.unresolvableReason,
    );
    assert.deepEqual(
      validatedPending.pendingDecisions[0]?.checksPerformed,
      stagingDecision.checksPerformed,
    );

    // Rejeita quando a seção de perguntas NÃO é a última seção do Markdown.
    const wrongPositionPath = join(rootDir, 'wrong-position.md');
    writeFileSync(
      wrongPositionPath,
      [
        '# Diagnóstico Técnico + Plano de Implementação',
        '## Diagnóstico Técnico',
        'Diagnóstico.',
        '## Decisões de Design & Contratos',
        'Contratos definidos.',
        `## ${PLANNING_PENDING_QUESTIONS_SECTION}`,
        '- **P1**: Pergunta fora do fim.',
        '## Plano de Alterações (Arquivo por Arquivo)',
        'Alterar src/feature.ts.',
        '## Cuidados de Regressão',
        'Preservar comportamento.',
        '## Plano de Testes',
        'Validar CA1.',
        '',
      ].join('\n'),
    );
    writeFactoryStageSidecar(wrongPositionPath, 'planning', {
      pendingDecisions: [stagingDecision],
    });
    assert.throws(
      () => validateFactoryStageArtifacts('planning', wrongPositionPath),
      error =>
        error instanceof FactoryStageArtifactError &&
        error.code === 'FACTORY_MARKDOWN_INVALID' &&
        /última seção/i.test(error.message),
    );

    // Rejeita quando o ID do sidecar não aparece na seção final.
    const missingIdPath = join(rootDir, 'missing-id.md');
    writeFileSync(
      missingIdPath,
      `${planningMarkdown('Diagnóstico.')}\n## ${PLANNING_PENDING_QUESTIONS_SECTION}\n- Pergunta sem mencionar o identificador esperado.\n`,
    );
    writeFactoryStageSidecar(missingIdPath, 'planning', {
      pendingDecisions: [stagingDecision],
    });
    assert.throws(
      () => validateFactoryStageArtifacts('planning', missingIdPath),
      error =>
        error instanceof FactoryStageArtifactError &&
        error.code === 'FACTORY_MARKDOWN_INVALID' &&
        /P1/.test(error.message),
    );

    // Rejeita IDs duplicados no sidecar.
    assert.equal(
      FactoryPlanningSidecarSchema.safeParse({
        ...sidecarFixtures.planning,
        pendingDecisions: [stagingDecision, { ...stagingDecision, question: 'Outra pergunta?' }],
      }).success,
      false,
    );

    // 3) Artefato legado (sem id, checksPerformed, unresolvableReason, localVerifications e sem seção final): continua legível!
    const legacyPath = join(rootDir, 'legacy-plan.md');
    writeFileSync(legacyPath, planningMarkdown('Artefato legado da Fase 1.'));
    writeFactoryStageSidecar(legacyPath, 'planning', {
      pendingDecisions: [
        {
          question: 'Manter timeout padrão?',
          options: ['Manter 5s', 'Aumentar para 10s'],
          recommendedOption: 'Manter 5s',
        },
      ],
    });
    const legacySidecar = validateFactoryStageArtifacts('planning', legacyPath);
    assert.equal(legacySidecar.stage, 'planning');
    assert.equal(legacySidecar.pendingDecisions.length, 1);
    const legacyDecision = legacySidecar.pendingDecisions[0];
    assert.ok(legacyDecision);
    assert.equal(legacyDecision.id, undefined);
    assert.equal(resolvePlanningPendingDecisionId(legacyDecision, 0), 'D1');
    const rereadLegacy = readFactoryStageSidecar('planning', legacyPath);
    assert.equal(rereadLegacy.pendingDecisions[0]?.question, 'Manter timeout padrão?');
  },
);

test(
  'Fase 2.4: encadeia Triagem -> Planejamento sem duplicar sessões em artefato inválido, cancelamento, retomada e concorrência',
  { timeout: 30_000 },
  async context => {
    const harness = await createPhase2Harness(context);

    // 1) Artefato inválido na Triagem: não inicia Planejamento; reexecução válida inicia exatamente 1 Planejamento.
    const invalidFlowRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Validar artefato inválido', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(invalidFlowRes.status, 201);
    const invalidCreated = (await invalidFlowRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const invalidFlowId = invalidCreated.flow.id;
    assert.ok(invalidCreated.session.reportPath);
    const firstTriageLaunch = await harness.readSessionLaunch(invalidCreated.session.sessionId);
    assert.ok(firstTriageLaunch.args.includes('--disallowedTools'));
    assert.match(
      firstTriageLaunch.args[firstTriageLaunch.args.indexOf('--disallowedTools') + 1] ?? '',
      /AskUserQuestion/,
    );

    // Encerra sem gravar artefato válido (placeholder permanece) -> fica em triage/waiting_action com erro.
    harness.server.sessionManager.writeInput(invalidCreated.session.sessionId, 'EXIT0');
    const invalidPaused = await waitFor(
      () => harness.fetchFlowDetails(invalidFlowId),
      details =>
        details.flow.currentStage === 'triage' &&
        details.flow.state === 'waiting_action' &&
        details.flow.currentSessionId === null,
      'pausa por artefato inválido na Triagem',
    );
    assert.ok(invalidPaused.flow.error);
    assert.equal(
      harness.server.sessionManager
        .listSessions()
        .filter(session => session.flowId === invalidFlowId && session.stage === 'planning').length,
      0,
    );

    // Retomada / reexecução concorrente: duas requisições /rerun simultâneas iniciam apenas 1 Triagem (a outra recebe 409).
    const [rerunA, rerunB] = await Promise.all([
      fetch(`${harness.baseUrl}/api/factory/flows/${invalidFlowId}/rerun`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'triage' }),
      }),
      fetch(`${harness.baseUrl}/api/factory/flows/${invalidFlowId}/rerun`, {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'triage' }),
      }),
    ]);
    const rerunStatuses = [rerunA.status, rerunB.status].sort((a, b) => a - b);
    assert.deepEqual(rerunStatuses, [200, 409]);
    const okRerunRes = rerunA.status === 200 ? rerunA : rerunB;
    const rerunBody = (await okRerunRes.json()) as { session: BackgroundSessionSummary };
    assert.ok(rerunBody.session.reportPath);
    await harness.readSessionLaunch(rerunBody.session.sessionId);

    writeFileSync(
      rerunBody.session.reportPath,
      triageMarkdown('Quando reexecutada, a Triagem grava artefato válido.'),
    );
    writeFactoryStageSidecar(rerunBody.session.reportPath, 'triage', {
      blockers: ['Verificar assinatura de método interno no Planejamento.'],
      jiraError: null,
    });
    harness.server.sessionManager.writeInput(rerunBody.session.sessionId, 'EXIT0');

    const planningStarted = await waitFor(
      () => harness.fetchFlowDetails(invalidFlowId),
      details =>
        details.flow.currentStage === 'planning' &&
        details.flow.state === 'running' &&
        details.flow.currentSessionId !== null,
      'encadeamento automático após reexecução válida da Triagem',
    );
    assert.ok(planningStarted.flow.currentSessionId);
    const planningLaunch = await harness.readSessionLaunch(planningStarted.flow.currentSessionId);
    assert.ok(planningLaunch.args.includes('--disallowedTools'));
    assert.match(
      planningLaunch.args[planningLaunch.args.indexOf('--disallowedTools') + 1] ?? '',
      /AskUserQuestion/,
    );
    const planningSessionsForFlow = harness.server.sessionManager
      .listSessions()
      .filter(session => session.flowId === invalidFlowId && session.stage === 'planning');
    assert.equal(planningSessionsForFlow.length, 1);

    // 2) Cancelamento durante a Triagem: encerra sem iniciar nenhuma sessão de Planejamento.
    const cancelRes = await fetch(`${harness.baseUrl}/api/factory/flows`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { inputType: 'title', value: 'Fluxo cancelado na triagem', repoPath: harness.repoDir },
        startSession: true,
      }),
    });
    assert.equal(cancelRes.status, 201);
    const cancelCreated = (await cancelRes.json()) as {
      flow: { id: string };
      session: BackgroundSessionSummary;
    };
    const cancelFlowId = cancelCreated.flow.id;
    assert.ok(cancelCreated.session.reportPath);
    await harness.readSessionLaunch(cancelCreated.session.sessionId);
    // Mesmo que o arquivo já tenha sido salvo antes do cancelamento, cancelar não deve encadear Planejamento.
    writeFileSync(
      cancelCreated.session.reportPath,
      triageMarkdown('Triagem cancelada antes de concluir.'),
    );
    writeFactoryStageSidecar(cancelCreated.session.reportPath, 'triage');

    const stopRes = await fetch(`${harness.baseUrl}/api/factory/flows/${cancelFlowId}/cancel`, {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelado pelo usuário durante a Triagem' }),
    });
    assert.equal(stopRes.status, 200);

    const cancelledDetails = await waitFor(
      () => harness.fetchFlowDetails(cancelFlowId),
      details => details.flow.state === 'cancelled' && details.flow.currentSessionId === null,
      'cancelamento do fluxo durante a Triagem',
    );
    assert.equal(cancelledDetails.flow.currentStage, 'triage');
    assert.equal(
      harness.server.sessionManager
        .listSessions()
        .filter(session => session.flowId === cancelFlowId && session.stage === 'planning').length,
      0,
    );
  },
);
