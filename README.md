# development-factory

Interface local de code review com React, xterm.js e o Claude Code CLI interativo em um PTY real no WSL. Toda a lógica da aplicação, configuração e testes está em TypeScript; HTML e CSS compõem a apresentação.

```text
React / xterm.js ⇄ WebSocket JSON + Zod ⇄ Node.js / node-pty ⇄ claude [prompt]
```

## Preparação no WSL

Use Node.js **22.12 ou superior** e npm com suporte a workspaces. Execute todos os comandos dentro do WSL, não no PowerShell. O Claude deve estar instalado, autenticado e disponível no mesmo PATH usado para iniciar o backend:

```bash
node --version
npm --version
command -v claude
claude --version
```

Antes de usar a interface, execute `claude` diretamente no repositório que deseja revisar para concluir autenticação, confiança do diretório e configuração dos MCPs. A aplicação herda o ambiente do backend e usa o diretório informado como `cwd`; não configura, replica ou substitui MCPs, agente ou credenciais. Disponibilidade das ferramentas depende da sua configuração local, das permissões do projeto e do acesso aos serviços.

O `node-pty` é um módulo nativo. Se a instalação precisar compilá-lo e as ferramentas estiverem ausentes, em Ubuntu/WSL instale:

```bash
sudo apt update
sudo apt install -y build-essential python3
```

## Instalar e executar

Na raiz do projeto:

```bash
cd /caminho/para/development-factory
npm install
npm run typecheck
npm run dev
```

Abra **http://localhost:5173** ou **http://127.0.0.1:5173** no navegador do Windows. O Vite usa a porta 5173 fixa; o backend escuta exclusivamente em `127.0.0.1:3001`. O encaminhamento de localhost do WSL precisa estar disponível. O WebSocket conecta diretamente a `ws://127.0.0.1:3001/ws/terminal`, sem proxy ou serviço hospedado.

Use o botão de sol/lua no cabeçalho para alternar entre os temas claro e escuro. A preferência é salva no navegador e restaurada ao recarregar; o tema inicial é escuro. O mesmo botão está disponível no modal e atualiza as cores do terminal sem reiniciar a sessão.

1. Escolha **Número da PR** ou **Nome da Branch**.
2. Informe um número positivo, como `142`, ou uma branch, como `feat/minha-feature`.
3. Clique em **Selecionar** no campo **Repositório no WSL**. Navegue pelas pastas e clique em **Selecionar esta pasta** no diretório do projeto. O seletor abre na última pasta utilizada ou na pasta pessoal do usuário WSL; permite subir até a raiz e navegar por `/mnt/c` quando necessário. O filtro procura subpastas apenas na localização atual.
4. Em **Salvar code review em**, confirme a pasta padrão ou escolha outra pasta no WSL. O aplicativo lembra a última seleção neste navegador. Clique em **Iniciar code review**.
5. Interaja com o Claude normalmente no terminal, inclusive com eventuais solicitações de confiança, login e ferramentas. O prompt solicita as cinco etapas de investigação e feedback em português.
6. Teste redimensionar a janela, selecionar e copiar texto, colar e abrir links. **Ctrl+C** copia quando há seleção; sem seleção envia o controle de interrupção ao PTY. **Ctrl+V** lê o clipboard e usa `term.paste`, respeitando o bracketed paste da TUI. O navegador pode solicitar permissão de clipboard. **Esc** continua disponível para o Claude.
7. **Copiar saída** copia o buffer ativo completo de até 15.000 linhas de scrollback, sem códigos de cores, com feedback visual. Em uma tela alternativa da TUI, o buffer ativo corresponde àquela tela; não é um histórico permanente de todos os quadros renderizados.
8. Use **Segundo plano** para fechar o modal e manter o review em execução. Abra a sessão novamente pelo menu de operações em segundo plano ou use **Encerrar processo** para parar o PTY.

Encerre os servidores com **Ctrl+C** no terminal onde executou `npm run dev`.

## Pareceres em Markdown

Em **Salvar code review em**, o destino inicial é `$XDG_DATA_HOME/development-factory/reviews/` ou, se a variável estiver vazia ou ausente, `~/.local/share/development-factory/reviews/`. É possível selecionar outra pasta a cada execução. O backend verifica se o destino permite gravação e fica fora do repositório analisado e do diretório do Development Factory antes de iniciar o Claude.

O Claude entrega o parecer em um arquivo temporário privado. O backend grava um único `.md` na pasta indicada em **Salvar code review em**, com o alvo e um identificador de execução no nome. O modal exibe **Parecer salvo** e o caminho completo após a gravação. O terminal continua disponível ao vivo e em segundo plano. O code review não salva uma transcrição. Se a sessão terminar sem entregar o Markdown, aparece **Parecer incompleto**.

### Consultar revisões pela interface

Abra **Histórico** e selecione **Pareceres salvos** para consultar os reviews, inclusive quando estão em pastas diferentes. A busca aceita PR, branch, repositório e caminho do arquivo. Se um parecer tiver sido movido ou apagado, o Histórico informa que está indisponível.

Use **Arquivos locais** para navegar pelo WSL e consultar arquivos legados em `.code-reviews/` ou outros arquivos Markdown. Conteúdo Markdown é exibido com tabelas, listas de tarefas e blocos de código. A leitura aceita arquivos regulares de até 5 MiB e não renderiza HTML embutido.

## Etapa 03 da Factory

No card **Planejamento**, confira o Diagnóstico Técnico + Plano de Implementação, preencha **Notas / Decisões Aprovadas** se houver e clique em **Avançar para Desenvolvimento**. A sessão usa o Documento de Entendimento da Triagem, o plano e as notas aprovadas. As notas ficam salvas no fluxo para reexecução.

O Claude Code roda em modo restrito, com ferramentas de leitura e edição autorizadas para código de produção e para o arquivo do relatório. Os padrões de proteção bloqueiam arquivos e diretórios de teste, e a sessão fica sem ferramentas de shell. Use uma versão do Claude Code com suporte a `--restricted`. [Referência do Claude Code CLI](https://code.claude.com/docs/en/cli-reference#cli-flags)

Quando a execução concluir com um relatório válido, abra **Ver artefato** no card **Desenvolvimento**. **Avançar para Testes** entrega o fluxo à Etapa 04. A execução da Etapa 04 será adicionada futuramente.

Cole o prompt operacional definitivo em `FACTORY_DEVELOPMENT_SYSTEM_PROMPT` no arquivo [apps/server/src/prompts/factory-development.ts](apps/server/src/prompts/factory-development.ts).

## Perfil de repositório da Factory

O backend usa o perfil de `.development-factory.json` na raiz Git do repositório alvo para
provisionar o worktree e montar os prompts de Planejamento, Desenvolvimento, Testes e PR.
O arquivo é opcional. Tanto a ausência do manifesto quanto a omissão de campos em um manifesto
parcial usam os valores padrão abaixo.

| Campo | Padrão | Formato |
| --- | --- | --- |
| `baseBranch` | `null` | Nome de branch Git. O padrão mantém a seleção automática da Factory pela branch atual ou, com `HEAD` destacado, por `main`, `master` ou `HEAD`, nessa ordem. |
| `branchPattern` | `factory/{slug}` | Padrão de nome de branch Git com o marcador `{slug}` para a chave Jira ou o título normalizado da tarefa. |
| `stack` | `[]` | Lista de tecnologias e ferramentas usadas no projeto. |
| `commands` | `null` por comando | Objeto com as chaves `typecheck`, `lint`, `test` e `coverage`. Cada comando é uma lista com o executável seguido dos argumentos. |
| `protectedPaths` | `[]` | Lista de caminhos ou globs adicionais relativos à raiz do repositório. |
| `architectureRules` | `[]` | Lista de regras de arquitetura em texto. |
| `prTemplate` | `null` | Conteúdo Markdown do template de PR. |

Uma branch base informada no fluxo tem prioridade sobre `baseBranch` do manifesto. Em caso de
colisão de nomes, a Factory acrescenta um sufixo ao valor de `{slug}` dentro do padrão. As etapas
que usam o perfil consultam o manifesto no repositório alvo, mesmo quando a branch base do worktree
tem outra versão do arquivo. Os prompts orientam a consulta aos arquivos do projeto e ao plano
para identificar tecnologias e comandos omitidos.

Este exemplo define a branch base, a stack, os comandos de tipagem e teste e um caminho protegido.

```json
{
  "baseBranch": "main",
  "stack": ["TypeScript", "Node.js"],
  "commands": {
    "typecheck": ["npm", "run", "typecheck"],
    "test": ["npm", "test"]
  },
  "protectedPaths": ["infra/**"]
}
```

Use um arquivo regular em UTF-8 de até 256 KiB. Use `/` nos caminhos protegidos e nos caminhos
relativos de executáveis, como `./scripts/test`. O esquema rejeita caracteres de controle e
segmentos `..` em caminhos protegidos e comandos, além de campos desconhecidos no manifesto.

## Mapeamento do fluxo atual da Factory (Fase 1)

Este mapeamento registra o estado atual das transições, contratos, aprovações, atualizações da interface e recursos locais de validação da Factory como linha de base para as melhorias seguintes.

### 1.1 Execução de Triagem e Planejamento

#### Responsabilidades por arquivo e função

| Responsabilidade | Arquivo e função | Comportamento atual |
| --- | --- | --- |
| Criação do fluxo e início da Triagem | [apps/server/src/server.ts](apps/server/src/server.ts) (`handleFactoryFlowApiRequest` em `POST /api/factory/flows`), [apps/server/src/factory-flow-service.ts](apps/server/src/factory-flow-service.ts) (`FactoryFlowService.createFlow`), [apps/server/src/ws/terminal-handler.ts](apps/server/src/ws/terminal-handler.ts) (`handleTerminalConnection` em `start_factory`) | Cria o fluxo em `queued`/`triage`. Com `startSession: true` (ou via WebSocket `start_factory`), inicia `SessionManager.startFactorySession`. Reexecuções entram por `POST /api/factory/flows/:id/rerun` ou `/start`. |
| Início da sessão e processo Claude | [apps/server/src/session-manager.ts](apps/server/src/session-manager.ts) (`SessionManager.startFactorySession`, `#ensureFactoryFlowWorktree`, `#startFactoryRunner`) | Garante worktree isolado, valida handoff (`FactoryFlowService.assertStageHandoff`), carrega o perfil do repositório, instancia o histórico externo (`createFactoryHistory`), monta prompt e flags e executa `pty.spawn('claude', ['--verbose', '--output-format', 'stream-json', ...runnerArgs, '-p', prompt], { cwd: workingDirectory })`. Vincula sessão via `FactoryFlowService.attachSession` e grava caminhos em `FactoryFlowService.updateStagePaths`. |
| Flags e ferramentas de Triagem e Planejamento | [apps/server/src/factory-stage-runners.ts](apps/server/src/factory-stage-runners.ts) (`buildTriageAndPlanningRunnerArgs`, `buildRestrictedRunnerArgs`, `buildReportFileToolPermissions`) | Ambas usam `--restricted`, `--no-chrome`, `--permission-mode dontAsk` e `--add-dir <artifactsDir>`. **Triagem:** `Read,Edit,Write` + `JIRA_READ_TOOLS` + MCP restrito a `https://mcp.atlassian.com/*`. **Planejamento:** `Read,Glob,Grep,Edit,Write` + `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (sem `Bash` e sem MCP). Escrita restrita ao par `.md` e `.json`. |
| Prompts e contrato de saída | [apps/server/src/prompts/factory-plan.ts](apps/server/src/prompts/factory-plan.ts) (`buildFactoryPlanPrompt`), [apps/server/src/prompts/factory-architecture.ts](apps/server/src/prompts/factory-architecture.ts) (`buildFactoryArchitecturePrompt`, `FACTORY_ARCHITECTURE_SYSTEM_PROMPT`), [apps/server/src/prompts/factory-stage-output.ts](apps/server/src/prompts/factory-stage-output.ts) (`formatFactoryStageOutput`) | `buildFactoryPlanPrompt` instrui uso do Jira MCP, seções 1–5 obrigatórias, seção 6 (`Bloqueadores e Ambiguidades`) e campos do sidecar (`acceptanceCriteria`, `negativeScope`, `blockers`, `jiraContext`, `jiraError`, `technicalContext`). `buildFactoryArchitecturePrompt` injeta o documento de entendimento, `approvedNotes` e `formatFactoryRepositoryContext`, pedindo `Decisões Pendentes para Aprovação Humana` dentro da seção 2 e `pendingDecisions`, `plannedFiles`, `testPlan` no sidecar. |
| Geração e validação dos artefatos | [apps/server/src/artifacts.ts](apps/server/src/artifacts.ts) (`resolveFactoryArtifactsDirectory`), [apps/server/src/history.ts](apps/server/src/history.ts) (`createFactoryHistory`, `createSessionHistory`, `validateFactoryStageArtifacts`), [apps/server/src/factory-stage-runners.ts](apps/server/src/factory-stage-runners.ts) (`readFactoryStageSidecar`, `readFactoryStageDocument`, `normalizeStructuredMarkdownReport`, `describeMissingStructuredReportParts`) | Cria `<base>.md` (placeholder), `<base>.json` (sidecar vazio) e `<base>.session.md` em diretório externo `0o700`. Ao sair do PTY (`#handlePtyExit` → `#finalizePtyExit` → `history.finish`), redige segredos, valida título e seções obrigatórias do Markdown e valida o sidecar JSON contra `FactoryTriageSidecarSchema` / `FactoryPlanningSidecarSchema`. `#finishFactorySession` registra o artefato no SQLite (`ready`, `incomplete` ou `failed`) via `FactoryFlowService.registerArtifact`. |
| Interação habilitada vs. restrita | [apps/server/src/ws/terminal-handler.ts](apps/server/src/ws/terminal-handler.ts) (`input`, `resize`), [apps/server/src/session-manager.ts](apps/server/src/session-manager.ts) (`writeInput`, `resizeSession`), [apps/web/src/utils/factory-flow-status.ts](apps/web/src/utils/factory-flow-status.ts) (`canOpenTerminalForFactoryStage`), [apps/web/src/components/FactoryFlowRoadmapModal.tsx](apps/web/src/components/FactoryFlowRoadmapModal.tsx) | O processo roda em PTY com `-p` e `--permission-mode dontAsk`; `writeInput` ainda aceita escrita no PTY via `/ws/terminal`, mas a UI oculta atalhos de terminal (`canOpenTerminalForFactoryStage` retorna `false`). A interação humana estruturada existe no modal: na Triagem (bloco `Portão humano · Ação necessária`, textarea de respostas/complemento, botões `Reexecutar com complemento` e `Enviar respostas e avançar` / `Avançar para Planejamento`) e no Planejamento (`FactoryPlanningGatePanel` + `Aprovar e Iniciar Desenvolvimento`). |
| Interrupção por ambiguidades, Jira, artefato inválido, erro ou timeout | [apps/server/src/factory-preflight.ts](apps/server/src/factory-preflight.ts) (`checkJiraMcp`), [packages/shared/src/factory.ts](packages/shared/src/factory.ts) (`evaluateFactoryTriageGate`), [apps/server/src/session-manager.ts](apps/server/src/session-manager.ts) (`#finishFactorySession`, `formatTriageGatePausedReason`, `#handleFactoryStageTimeout`, `#handleAutoTransitionFailure`) | Preflight bloqueia criação quando `inputType !== 'title'` e o Jira MCP não está conectado. Após a Triagem, `evaluateFactoryTriageGate` bloqueia se `blockers.length > 0 || jiraError !== null`: grava `loopPausedReason`, pausa em `waiting_action` em `triage` e não chama `#autoAdvanceAndStartStage`. Artefato inválido com saída 0 pausa em `waiting_action` com `error`; `exitCode !== 0` marca `failed`; timeout (15 min padrão) envia `SIGTERM` e pausa em `waiting_action` com `FACTORY_STAGE_TIMEOUT`. |

#### Rastreamento dos cenários (1.1)

1. **Execução bem-sucedida (`triage` → `planning`):** `POST /api/factory/flows` (`startSession: true`) cria o fluxo em `queued` e inicia `triage` (`running`). O Claude grava Markdown (seções 1–5) e sidecar com `blockers: []` e `jiraError: null`, encerrando com código 0. `history.finish` marca `saved`; `#finishFactorySession` registra o artefato `ready`, avalia `evaluateFactoryTriageGate` (`blocked: false`), transita `triage` para `waiting_action` e chama `#autoAdvanceAndStartStage('planning')` → `FactoryFlowService.advanceStage` → `SessionManager.startFactorySession({ stage: 'planning' })`. O Planejamento grava Markdown e sidecar válido; ao sair com código 0, `#finishFactorySession` registra o artefato `ready` e transita `planning` para `waiting_action` (sem avanço automático).
2. **Ambiguidade na Triagem:** o prompt instrui registrar dúvidas em `blockers` (sidecar) e na seção 6 (Markdown). Ao concluir com código 0 e artefato válido, `evaluateFactoryTriageGate` retorna `blocked: true`; `formatTriageGatePausedReason` gera `loopPausedReason`; o fluxo permanece em `triage` com `state: 'waiting_action'`; `FactoryFlowService.getFlow` expõe `triageGate` via `resolveTriageGateForFlow`. A `FactoryPage` classifica o card em **Aguardando decisão humana**, `useBackgroundOperations` exibe toast via `maybeNotifyFlowAttention` e o `FactoryFlowRoadmapModal` exibe o alerta de `loopPausedReason`, a lista de `blockers`, o textarea de respostas e os botões manuais.
3. **Falha do Jira:** antes da execução, `runFactoryPreflight` (`checkJiraMcp`) pode bloquear a abertura se o MCP Atlassian Rovo estiver desconectado. Em tempo de execução da Triagem, o prompt instrui gravar a falha em `jiraError` (sidecar) e na seção 6. `evaluateFactoryTriageGate` retorna `blocked: true` com `jiraError !== null`; o servidor pausa em `triage` (`waiting_action`) com `loopPausedReason` mencionando o Jira MCP e `triageGate.jiraError` exposto em `GET /api/factory/flows/:id`; o modal exibe a caixa **Falha na consulta ao Jira MCP** e permite reexecutar com complemento manual.

### 1.2 Aprovação do Planejamento, Atualizações e Publicação

#### Contratos e entradas da API e do modal

- **Contratos em [packages/shared/src/factory.ts](packages/shared/src/factory.ts):**
  - `FactoryPlanningSidecarSchema`: `pendingDecisions` (`{ question, options (mín. 2), recommendedOption }[]`, atualmente **sem campo `id` persistido no sidecar**), `plannedFiles` e `testPlan`.
  - `FactoryPlanningGateSchema`: `{ pendingDecisions, acceptanceCriteria }` exposto em `FactoryFlowDetailsSchema.planningGate`.
  - `AdvanceFactoryStageRequestSchema` (`POST /api/factory/flows/:id/advance`): aceita `at?`, `reason?`, `expectedUpdatedAt?`, `startSession?`, `approvedNotes?`, `planningApproval?: FactoryPlanningApprovalInputSchema`, `reviewTriage?`, `cols?`, `rows?`.
  - `FactoryPlanningApprovalSchema`: `{ decisions, acceptanceCriteria, notes?, approvedAt }` persistido em `factory_flows.planning_approval_json` (migration v8 em [apps/server/src/storage/migrations.ts](apps/server/src/storage/migrations.ts)). As notas efetivas (`approvedNotes ?? planningApproval?.notes`) também são persistidas em `factory_flow_stages.approved_notes` da etapa `development` (migration v5).
  - Contratos de PR: `FactoryPrSidecarSchema`, `FactoryPrGateSchema`, `FactoryPrReviewSchema` (vinculado por `prArtifactId` e `confirmedForPublish`), `FactoryPrPublicationSchema` (`blocked_by_secrets | failed | published`, `secretFindings`, `jiraSync`) e requests `SaveFactoryPrReviewRequestSchema`, `PublishFactoryPrRequestSchema`, `RetryFactoryPrJiraSyncRequestSchema`.
- **Rotas HTTP relevantes em [apps/server/src/server.ts](apps/server/src/server.ts):**
  - `GET /api/factory/flows` e `GET /api/factory/flows/:id` (retorna `flow`, `stages`, `artifacts`, `checkpoints`, `triageGate`, `planningGate`, `reviewGate`, `prGate`).
  - `POST /api/factory/flows/:id/advance` (avanço de etapa, aprovação do planejamento e `startSession` opcional — exceto para `pr`, que nunca auto-inicia).
  - `POST /api/factory/flows/:id/rerun` e `/start` (execução/reexecução da etapa atual; exige `stage === flow.currentStage`).
  - `POST /api/factory/flows/:id/transitions` (bloqueia troca de `stage` com `409 FACTORY_FLOW_INVALID_STAGE_ADVANCE`).
  - `POST /api/factory/flows/:id/pr-review`, `POST /api/factory/flows/:id/pr-publish` e `POST /api/factory/flows/:id/pr-jira-retry`.
  - `GET /api/events` (stream SSE de `AppEvent` assinado em `sessionManager.onEvent`).

#### Caminho das decisões do sidecar até o formulário e aprovação com pendências

1. `GET /api/factory/flows/:id` chama `FactoryFlowService.getFlow` → `resolvePlanningGateForFlow` ([apps/server/src/factory-flow-service.ts](apps/server/src/factory-flow-service.ts)), que lê `pendingDecisions` do sidecar de `planning` e `acceptanceCriteria` do sidecar de `triage`.
2. [apps/web/src/components/FactoryFlowRoadmapModal.tsx](apps/web/src/components/FactoryFlowRoadmapModal.tsx) busca os detalhes via `fetchFactoryFlowDetails` (recarregando quando `flow.id`, `flow.updatedAt` ou timestamps de revisão/publicação mudam) e inicializa o formulário via `createPlanningGateDrafts` ([apps/web/src/components/FactoryPlanningGatePanel.tsx](apps/web/src/components/FactoryPlanningGatePanel.tsx)), gerando IDs posicionais `D1`, `D2`, ... a partir da ordem de `pendingDecisions`.
3. Enquanto `currentStage === 'planning'` e `state === 'waiting_action'` com artefatos prontos (`isPlanningGateEditable`), o modal exibe `FactoryPlanningGatePanel` (replicando perguntas e opções no modal) e o botão **Aprovar e Iniciar Desenvolvimento**.
4. Ao submeter, `buildPlanningApprovalPayload` valida opções customizadas e critérios de aceite e chama `onAdvanceFlowStage` ([apps/web/src/App.tsx](apps/web/src/App.tsx)) → `advanceFlowStage` ([apps/web/src/hooks/useBackgroundOperations.ts](apps/web/src/hooks/useBackgroundOperations.ts)) → `POST /api/factory/flows/:id/advance` com `startSession: true`, `planningApproval` e `approvedNotes`.
5. No servidor, `FactoryFlowService.advanceStage` executa `assertStageHandoff(details, 'development')`; quando `planningApproval` é enviado, `buildValidatedPlanningApproval` exige resposta para cada `pendingDecision` (por `D<n>` ou texto exato da pergunta) e valida se `selectedOption` corresponde à opção recomendada ou a uma alternativa do plano. Em transação, grava `planningApproval` no fluxo, `approvedNotes` na etapa `development`, define `iteration = 1` e transita `planning → development`; em seguida `server.ts` emite `factory_flow.updated` e inicia a sessão de `development`, que recebe `planningApproval` e `approvedNotes` via `readFactoryDevelopmentInputs` ([apps/server/src/factory-development.ts](apps/server/src/factory-development.ts)).
6. **Lacunas atuais mapeadas para a Fase 3:** `FactoryPlanningApprovalSchema` ainda não registra `planningArtifactId` (ou versão do plano), reexecutar `planning` não invalida `flow.planningApproval` anterior, e `FactoryFlowService.advanceStage` ainda permite avançar `planning → development` quando `planningApproval` é omitido na requisição.

#### Atualizações com o modal fechado

- `useBackgroundOperations` ([apps/web/src/hooks/useBackgroundOperations.ts](apps/web/src/hooks/useBackgroundOperations.ts)) permanece montado na raiz em [apps/web/src/App.tsx](apps/web/src/App.tsx), independente de `FactoryFlowRoadmapModal` estar aberto ou fechado.
- Faz hidratação inicial (`GET /api/sessions` e `GET /api/factory/flows`) e mantém conexão `EventSource` em `GET /api/events` com reconexão exponencial (1s–10s) e re-hidratação em `onopen` (preservando revisões mais recentes via `compareFactoryFlowRevisions` e `mergeSessionSummary`).
- Eventos `factory_flow.*` atualizam `factoryFlowsMap` (refletindo na `FactoryPage` e no `FloatingDock`); `factory_flow.updated` dispara `maybeNotifyFlowAttention` (apenas para `loopPausedReason` ou `isFactoryFlowReadyForPr`) e `factory_flow.finished` dispara `maybeNotifyFlowFinished`. Eventos `session.history_saved` e `session.finished` chamam `maybeNotify` (deduplicado por `${sessionId}:${kind}` em memória), exibindo toasts em [apps/web/src/components/NotificationToastCenter.tsx](apps/web/src/components/NotificationToastCenter.tsx).
- **Lacuna atual mapeada para a Fase 3:** não há notificação única por versão do plano quando `triage` + `planning` terminam; hoje `session.history_saved` e `session.finished` podem emitir múltiplos toasts (`Plano salvo`) para cada sessão.

#### Caminho atual de preparação e publicação (Bloco 06 / `pr`)

1. **Entrada em `pr`:** após aprovação do Code Review (automática quando sem findings em `#finishFactorySession`, ou manual após triagem sem bloqueantes via `POST /api/factory/flows/:id/advance`), o fluxo estaciona em `currentStage: 'pr'`, `state: 'waiting_action'`, sem iniciar sessão automaticamente.
2. **Etapa 1 — Preparação (`pr_summary`):** acionada manualmente por **Executar etapa PR** / **Reexecutar preparação** no card da etapa 06 ou no `FactoryFlowPrPanel` → `POST /api/factory/flows/:id/rerun` (`stage: 'pr'`). Usa `buildPrRunnerArgs` ([apps/server/src/factory-pr.ts](apps/server/src/factory-pr.ts)), liberando apenas leitura Git e escrita do `pr_summary.md`/`.json` (bloqueando `git commit`, `git push`, `gh`, `glab`). Ao finalizar com contratos válidos, limpa `prReview` e `prPublication` anteriores e volta a `waiting_action`.
3. **Etapa 2 — Revisão pré-publicação:** `buildFactoryPrGateForFlow` ([apps/server/src/factory-pr.ts](apps/server/src/factory-pr.ts)) pré-carrega `prGate` na aba `PR` ([apps/web/src/components/FactoryFlowPrPanel.tsx](apps/web/src/components/FactoryFlowPrPanel.tsx)). **Salvar revisão** (`confirmPublish: false`) e **Confirmar publicação do PR** (`confirmPublish: true`) chamam `POST /api/factory/flows/:id/pr-review` → `FactoryFlowService.savePrReview`, vinculando `prReview` ao `prArtifactId` vigente.
4. **Etapa 3 — Publicação determinística:** o botão **Publicar Pull Request** chama `POST /api/factory/flows/:id/pr-publish` → `FactoryFlowService.publishPr`, que revalida contratos e confirmação do `prArtifactId` vigente, executa `scanFactoryWorktreeSecrets` (bloqueando com `409 FACTORY_FLOW_SECRET_DETECTED` antes de `git push`), faz `commitAndPushFactoryWorktree`, abre o PR/MR via `createFactoryProviderPullRequest` (`gh` ou `glab`), comenta opcionalmente no Jira via `syncFactoryPrWithJira` (com retry em `POST /api/factory/flows/:id/pr-jira-retry`), limpa o worktree conforme política de retenção e transita o fluxo para `completed`.

### 1.3 Recursos de validação do projeto alvo

#### Recursos locais disponíveis hoje e pré-requisitos

| Camada | Implementação atual | Disponibilidade no worktree / sessão | Pré-requisitos e lacunas para verificações locais no Planejamento |
| --- | --- | --- | --- |
| Worktree isolado | [apps/server/src/factory-worktree.ts](apps/server/src/factory-worktree.ts) (`provisionFactoryWorktree`, `verifyExistingFactoryWorktree`) e [apps/server/src/artifacts.ts](apps/server/src/artifacts.ts) (`resolveFactoryWorktreePath`) | Cria `git worktree add -b <branch> <worktreesRoot>/<flowId> <baseRef>` fora do repositório alvo (`0o700`). A sessão do Claude roda com `cwd: worktreePath` herdando `process.env` do backend. | Contém apenas arquivos rastreados no Git. Dependências e arquivos ignorados pelo `.gitignore` (`node_modules`, `.venv`, `.env`, bancos SQLite locais) **não** são copiados automaticamente; é necessário ter dependências disponíveis, variáveis de desenvolvimento acessíveis (via ambiente ou configuração local) e banco de desenvolvimento acessível no WSL. |
| Perfil do repositório (`.development-factory.json`) | [packages/shared/src/factory.ts](packages/shared/src/factory.ts) (`FactoryRepositoryProfileSchema`), [apps/server/src/factory-repository-profile.ts](apps/server/src/factory-repository-profile.ts) (`loadFactoryRepositoryProfile`), [apps/server/src/prompts/factory-repository-context.ts](apps/server/src/prompts/factory-repository-context.ts) (`formatFactoryRepositoryContext`) | Lido sempre da raiz Git do repositório alvo. Define `baseBranch`, `branchPattern`, `stack`, `commands` (`typecheck`, `lint`, `test`, `coverage`), `protectedPaths`, `architectureRules` e `prTemplate`. Usa `z.strictObject` (rejeita chaves desconhecidas). | Ainda não possui campos para declarar comandos/verificações de ambiente de desenvolvimento (ex.: healthcheck da aplicação, smoke test ou checagem contra banco de desenvolvimento). Hoje `commands` só são executados pelo backend após `development` (`typecheck`/`lint` via [apps/server/src/factory-development-checks.ts](apps/server/src/factory-development-checks.ts)) e após `tests` (`test`/`coverage` via [apps/server/src/factory-tests-checks.ts](apps/server/src/factory-tests-checks.ts)). |
| Capacidades do runner de `planning` | [apps/server/src/factory-stage-runners.ts](apps/server/src/factory-stage-runners.ts) (`buildTriageAndPlanningRunnerArgs`) | Permite apenas `Read`, `Glob`, `Grep` no worktree e `Edit`/`Write` no `.md` e `.json` do plano, com `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. | **Sem `Bash` e sem MCP:** hoje o Planejamento não executa testes, scripts, consultas ao banco de desenvolvimento nem chamadas à aplicação local. Para a Fase 2 (2.2), será necessário habilitar execução controlada (whitelist de comandos/verificações ou executor autorizado) preservando código somente leitura, bloqueando mutações Git, usando dados de teste isolados/reversíveis quando houver gravação e mantendo `redactSecrets` ([apps/server/src/secret-redaction.ts](apps/server/src/secret-redaction.ts)). |
| Comparação com runner de `tests` | [apps/server/src/factory-tests.ts](apps/server/src/factory-tests.ts) (`buildTestsRunnerArgs`, `buildTestsBashAllowedTools`) | Já demonstra o padrão de whitelist estrita em `Bash(...)` para `commands.test` e `commands.coverage`, bloqueando shells genéricos, rede externa e escrita Git. | Pode servir de referência para autorização restrita de verificações locais sem abrir shell irrestrito. |

#### Identificação de dependências de staging e cenários indisponíveis localmente

- **Validação prévia (preflight):** [apps/server/src/factory-preflight.ts](apps/server/src/factory-preflight.ts) (`runFactoryPreflight`) verifica `claude`, `jiraMcp` (obrigatório para `jira_key`/`jira_url`, dispensado para `title`), `github` (`warning` se ausente), `git` e `profile`. Não inspeciona banco de desenvolvimento nem credenciais externas do projeto alvo.
- **Critérios objetivos para classificar uma dependência como exclusiva de staging:**
  1. **Credenciais/segredos ausentes ou restritos:** variáveis de ambiente ou arquivos de segredo necessários à integração não existem no WSL local ou contêm apenas placeholders (ex.: chaves de API externas, tokens OAuth de parceiros, certificados de homologação).
  2. **Conectividade/rede restrita:** endpoint, fila, serviço interno ou webhook acessível apenas via VPN/rede privada de staging (falha de DNS, recusa de conexão, timeout ou erro `401`/`403` ao validar localmente).
  3. **Ausência de serviço ou massa de dados local:** dependência de serviço de terceiros sem sandbox/emulador local ou banco/serviço de desenvolvimento não provisionado na máquina.
- **Conduta esperada (base para Fase 2):** quando o recurso local (código, testes, aplicação e banco de desenvolvimento) estiver disponível, executar a verificação com dados isolados/reversíveis e registrar a evidência; quando houver dependência concreta de staging, registrar exatamente o que foi verificado e qual credencial/serviço faltou (sem expor segredos), recorrendo a pergunta pendente apenas se a decisão técnica permanecer indeterminada.

## Verificações

```bash
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:3001/health
```

O health check deve responder `{"ok":true}` com o backend em execução. `npm run build` valida a tipagem e gera a SPA em `apps/web/dist`; o fluxo integrado local documentado usa `npm run dev` e a origem 5173.

Os testes usam servidor HTTP, WebSocket e **node-pty reais** em porta efêmera. Um executável de teste temporário chamado `claude`, escrito em TypeScript, substitui somente o CLI via PATH. Assim não fazem chamadas de IA nem acessam seus repositórios, credenciais ou MCPs. Cobrem health, origem ausente/indevida, rota de upgrade, JSON inválido, schema, diretório inexistente, argumentos sem shell, cwd, TERM, entrada, resize, substituição da sessão, exit code, seletor de diretórios e salvamento em pasta externa, consulta após reiniciar o servidor e revisão interrompida sem salvar transcrição. Os testes também cobrem arquivos legados e a persistência de sessões de planejamento da Factory. O teste manual acima verifica a integração com seu Claude e seus MCPs.

## Padrão de lint e qualidade

Este padrão se aplica a toda implementação e alteração em `apps/*` e `packages/*`, incluindo testes e configurações. Novos workspaces devem seguir as mesmas regras. Alterações devem manter o escopo da tarefa e preservar o comportamento existente, exceto quando sua mudança fizer parte do requisito.

**Situação atual:** o projeto possui typecheck, testes e build, mas ainda não tem ESLint, Prettier, scripts de lint/formatação ou CI que os execute. As regras abaixo passam a orientar a implementação e a revisão de código; sua aplicação automática depende da instalação e configuração dessas ferramentas. Não declarar lint aprovado antes de essa automação existir e ser executada.

### Ferramentas e escopo

Adotar uma configuração ESLint compartilhada na raiz, no formato flat config, com ajustes por workspace:

| Escopo | Base a configurar |
| --- | --- |
| JavaScript e configuração | Regras recomendadas de `@eslint/js`; ambiente Node ou navegador conforme o arquivo. |
| TypeScript | `typescript-eslint` com `recommendedTypeChecked`, usando os projetos TypeScript de cada workspace. |
| React em `apps/web` | `eslint-plugin-react-hooks` e `eslint-plugin-jsx-a11y`, com presets recomendados e avisos tratados como erros. |
| Formatação | Prettier separado do lint; `eslint-config-prettier` para desativar regras de estilo conflitantes. |
| Artefatos gerados | Ignorar `node_modules`, `dist`, cobertura, arquivos temporários e bancos SQLite; incluir código-fonte, testes e configurações mantidos pelo projeto. |

Fixar as versões instaladas no lockfile e avaliar mudanças nos presets ao atualizar dependências. Configurações fora dos projetos TypeScript devem receber um override sem regras que dependam de informação de tipos.

### Regras de lint obrigatórias

As regras explícitas complementam os presets. Quando a regra TypeScript substitui uma regra equivalente do ESLint, desativar a versão básica para evitar diagnósticos duplicados.

| Área | Regras e comportamento exigido |
| --- | --- |
| Tipagem | `@typescript-eslint/no-explicit-any`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access` e `no-unsafe-return`: usar `unknown` nas fronteiras e fazer narrowing ou validação. Os nomes `no-unsafe-*` desta linha pertencem a `@typescript-eslint`. |
| Asserções | `@typescript-eslint/no-unnecessary-type-assertion`, `no-non-null-assertion` e `ban-ts-comment`: evitar coerções e `!`; proibir `@ts-ignore` e `@ts-nocheck`; exigir justificativa para `@ts-expect-error`. |
| Código sem uso | `@typescript-eslint/no-unused-vars`: proibir variáveis e imports não usados. Permitir prefixo `_` apenas para argumentos intencionalmente ignorados e propriedades extraídas para exclusão antes de um rest; configurar essas exceções explicitamente. |
| Imports | `@typescript-eslint/consistent-type-imports` e `no-duplicate-imports`: separar imports de tipos e evitar imports duplicados, permitindo declarações separadas de tipos. Preservar ESM e a convenção `.js` dos imports relativos TypeScript existentes. |
| Promises | `@typescript-eslint/no-floating-promises`, com `ignoreVoid: false`, e `no-misused-promises`: aguardar ou tratar rejeições; `void` sozinho não trata erros. Callbacks que esperam retorno síncrono não devem receber funções assíncronas sem um adaptador com tratamento de falhas. |
| Exceções | `@typescript-eslint/only-throw-error`: lançar `Error` ou subclasses com códigos estáveis para erros de domínio; não lançar strings ou objetos avulsos. |
| Correção | `eqeqeq` com comparação estrita e exceção explícita para `== null`/`!= null`; `curly` em todos os blocos; `prefer-const`, `no-var`, `no-debugger`, `no-eval`, `no-implied-eval` e `no-new-func`. |
| Hooks | Aplicar o preset recomendado de `react-hooks`, incluindo `rules-of-hooks` e `exhaustive-deps`. Corrigir dependências e estrutura dos efeitos em vez de silenciar o diagnóstico. |
| Acessibilidade | Aplicar o preset recomendado de `jsx-a11y`: labels acessíveis, texto alternativo, semântica e interação por teclado. A verificação estática deve ser complementada pela revisão de foco e navegação. |

Todas as regras obrigatórias devem ter severidade `error`. Não definir limites arbitrários de linhas de função, quantidade de parâmetros ou complexidade como bloqueios iniciais: dividir código quando isso melhorar responsabilidades e legibilidade.

### Formatação

Configurar Prettier com `tabWidth: 2`, `useTabs: false`, `singleQuote: true`, `semi: true`, `trailingComma: 'all'`, `printWidth: 100` e `endOfLine: 'lf'`. Usar aspas duplas em atributos JSX, UTF-8 e newline final. `printWidth` orienta a formatação; não deve ser duplicado por uma regra rígida de tamanho de linha.

Aplicar formatação aos arquivos alterados. Uma normalização inicial de todo o repositório deve ser uma alteração separada, para manter os diffs funcionais legíveis. Markdown pode ser formatado, respeitando a política de arquivos permitidos no commit.

### Regras de implementação e revisão

Os itens abaixo são obrigatórios, mas não são garantidos apenas pelo ESLint:

- Manter TypeScript `strict`, `noUncheckedIndexedAccess` e `verbatimModuleSyntax`; não enfraquecer o compilador para contornar erros.
- Definir contratos de comunicação e domínio em `packages/shared`, com Zod e tipos inferidos. Validar JSON, mensagens WebSocket, respostas externas e dados persistidos nas fronteiras; tipos TypeScript sozinhos não validam dados em runtime.
- Manter regras de domínio, persistência e controle de processos no backend. O pacote compartilhado não deve importar React, APIs de Node ou módulos específicos dos apps.
- Preservar mensagens ao usuário em português e códigos de erro estáveis. Não registrar credenciais, tokens ou conteúdo sensível; logs operacionais devem ter contexto e finalidade, sem `console.log` de depuração deixado no código.
- Usar APIs de processos com argumentos separados, sem interpolar entradas em shell. Validar caminhos, origens e limites de payload nas fronteiras correspondentes.
- Em React, limpar efeitos, listeners, timers, conexões e recursos criados pelo componente. Cancelar requisições ou ignorar respostas obsoletas para impedir atualização por uma execução anterior.
- Usar HTML semântico, nomes acessíveis, foco visível e suporte a teclado; não introduzir HTML não confiável na renderização de Markdown.
- Cobrir mudanças de comportamento com testes proporcionais ao risco. Exercitar falhas e invariantes em domínio, persistência e processos; testes não devem chamar IA real, usar credenciais nem publicar em serviços externos.
- Preservar separação entre estado do processo, salvamento de artefatos e conclusão da análise. Saída zero e mudança de arquivo não comprovam conclusão válida.

### Verificação de cada entrega

Enquanto a automação de lint/formatação não existir, revisar manualmente este padrão e executar os comandos existentes: `npm run typecheck`, `npm test` e `npm run build` para mudanças de código. Para alterações apenas de documentação, conferir os links, comandos citados e `git diff --check`. Informar qualquer verificação bloqueada ou não executada e seu motivo.

Na implantação da automação, criar os seguintes comandos na raiz e executá-los em CI antes do merge:

| Comando a criar | Contrato |
| --- | --- |
| `npm run lint` | Analisar todos os workspaces e configurações, sem modificar arquivos, com zero warnings (`--max-warnings 0`). |
| `npm run lint:fix` | Aplicar correções automáticas de lint, sujeitas à revisão do diff. |
| `npm run format:check` | Conferir a formatação dos arquivos mantidos pelo projeto, sem escrever alterações. |
| `npm run format` | Aplicar Prettier; usar seleção de arquivos quando a tarefa exigir escopo limitado. |
| `npm run check` | Executar lint, conferência de formatação, testes e build; o build já inclui typecheck. |

Não desabilitar regras globalmente para aprovar uma entrega. Exceções devem ser locais, mencionar a regra específica e explicar o motivo técnico no código; quando temporárias, registrar também a condição de remoção. Não deixar warnings como dívida silenciosa nem usar autofix sem conferir o diff.

Referências para a configuração: [presets do typescript-eslint](https://typescript-eslint.io/users/configs/), [regras de Hooks do React](https://react.dev/reference/eslint-plugin-react-hooks), [JSX a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) e [integração do Prettier com linters](https://prettier.io/docs/integrating-with-linters).

## Estrutura

```text
packages/shared/src/index.ts                 Schemas Zod e tipos inferidos
apps/server/src/index.ts                     Inicialização e sinais de encerramento
apps/server/src/server.ts                    HTTP, upgrade e validação de Origin
apps/server/src/ws/terminal-handler.ts        Ciclo de vida do PTY por conexão
apps/server/src/prompts/code-review.ts       Prompt das cinco etapas
apps/server/src/directories.ts              Listagem das pastas do WSL
apps/server/src/history.ts                  Persistência e acompanhamento do histórico
apps/server/src/history-reader.ts           Consulta de arquivos Markdown existentes
apps/server/src/storage/                    Repositório SQLite (`node:sqlite`), WAL e migrations versionadas
apps/server/test/terminal.test.ts            Integração HTTP / WS / PTY
apps/web/src/App.tsx                         Formulário e localStorage
apps/web/src/components/TerminalModal.tsx    TUI, resize, clipboard e cleanup
apps/web/src/components/DirectoryPicker.tsx  Seletor de diretórios do WSL
apps/web/src/components/HistoryModal.tsx     Navegação e leitura do histórico
```

O pacote compartilhado exporta `src/index.ts` diretamente; `tsx` e Vite o resolvem sem build intermediário. O backend também pode ser iniciado com `npm run start -w @development-factory/server`.

### Armazenamento local de reviews

O backend utiliza **SQLite** via módulo nativo `node:sqlite` (sem dependências externas ou compilação nativa no WSL), em modo `WAL` com transações `BEGIN IMMEDIATE` e migrations versionadas. Por padrão, o banco é criado fora dos repositórios analisados em `$XDG_DATA_HOME/development-factory/reviews.db` (ou `~/.local/share/development-factory/reviews.db`), podendo ser sobrescrito pela variável `REVIEW_DB_PATH`. Falhas na aplicação de migrations impedem a inicialização do servidor com diagnóstico explícito e sem apagar dados existentes.

## Limites e diagnóstico

- O backend aceita upgrade apenas em `/ws/terminal` e com Origin exato `http://localhost:5173` ou `http://127.0.0.1:5173`. Clientes sem Origin são recusados. Mantenha a aplicação em loopback: ela dá acesso interativo ao CLI com os privilégios do seu usuário WSL.
- O processo é criado com `pty.spawn('claude', [prompt], ...)`, sem shell, `-p`, `--bare` ou override do agente. O prompt pede análise sem alterações no código ou publicação, com exceção da escrita do parecer em Markdown; a aplicação mantém os controles de permissão do próprio CLI.
- A listagem de diretórios usa `GET /api/directories`, protegida pelas mesmas origens permitidas e CORS explícito. O seletor recebe os caminhos reais do backend; não faz upload de arquivos nem depende dos caminhos que um seletor nativo do navegador Windows poderia retornar.
- As consultas do histórico usam `GET /api/history` e `GET /api/history/file`, também protegidas por Origin e CORS. A leitura aceita somente nomes de arquivos Markdown diretamente na pasta selecionada, sem travessia de caminho ou links simbólicos para arquivos.
- O protocolo limita dimensões e tamanho das mensagens. Diretórios inválidos, JSON inválido e erros de PTY são reportados sem encerrar o servidor.
- **`claude` não encontrado:** confira `command -v claude` no mesmo shell que inicia `npm run dev`; reinicie o backend depois de ajustar PATH.
- **Erro de conexão:** confira o endpoint `/health`, as portas 3001/5173 e o encaminhamento de localhost do WSL. Use exatamente uma das URLs permitidas.
- **Porta ocupada:** encerre o processo conflitante. A porta do Vite não muda automaticamente, pois a validação de Origin depende dela.
- **Erro ao instalar:** `EAI_AGAIN` indica falha de resolução DNS/acesso ao registry; resolva a conectividade e repita `npm install`. Falhas de compilação do `node-pty` podem exigir as ferramentas nativas descritas acima.

Referências: [Tailwind com Vite](https://tailwindcss.com/docs/installation/using-vite), [API do xterm.js](https://xtermjs.org/docs/api/terminal/classes/terminal/) e [node-pty](https://github.com/microsoft/node-pty).
