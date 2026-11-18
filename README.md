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
4. Clique em **Iniciar code review**. A pasta selecionada fica salva automaticamente em `localStorage`. Cada sessão cria arquivos de histórico no repositório.
5. Interaja com o Claude normalmente no terminal, inclusive com eventuais solicitações de confiança, login e ferramentas. O prompt solicita as cinco etapas de investigação e feedback em português.
6. Teste redimensionar a janela, selecionar e copiar texto, colar e abrir links. **Ctrl+C** copia quando há seleção; sem seleção envia o controle de interrupção ao PTY. **Ctrl+V** lê o clipboard e usa `term.paste`, respeitando o bracketed paste da TUI. O navegador pode solicitar permissão de clipboard. **Esc** continua disponível para o Claude.
7. **Copiar saída** copia o buffer ativo completo de até 15.000 linhas de scrollback, sem códigos de cores, com feedback visual. Em uma tela alternativa da TUI, o buffer ativo corresponde àquela tela; não é um histórico permanente de todos os quadros renderizados.
8. **Encerrar sessão** fecha o modal e o WebSocket; o backend encerra o PTY. Fechar ou recarregar a aba também encerra a conexão. Não há reconexão automática nem restauração de sessões.

Encerre os servidores com **Ctrl+C** no terminal onde executou `npm run dev`.

## Histórico em Markdown

Cada review cria dois arquivos dentro de **`<repositório>/.code-reviews/`**, com data/hora, alvo e um identificador único no nome. Reviews anteriores não são sobrescritos.

- **`<sessão>.md`**: parecer final estruturado em Markdown. O prompt instrui o Claude a escrever e verificar esse arquivo ao concluir a análise. O CLI mantém suas permissões normais e pode pedir autorização para a escrita. O modal mostra **Parecer salvo** quando detecta conteúdo no arquivo; o estado inicial é **Parecer em elaboração**.
- **`<sessão>.session.md`**: registro textual automático da saída do PTY, gravado pelo backend durante a sessão, mesmo quando o modal é fechado. Inclui alvo, repositório, início e motivo do encerramento; remove sequências ANSI, mas a TUI pode produzir repetições e redesenhos. Não é uma transcrição semântica da conversa.

Se a sessão terminar antes de o Claude salvar o parecer, o primeiro arquivo é marcado **Code review incompleto**, com um link para o registro da sessão. O encerramento normal, o botão **Encerrar sessão**, a desconexão e a troca de sessão finalizam os registros. Em encerramento abrupto do sistema, o texto já gravado permanece no disco, mas a marcação final pode não existir.

Os caminhos completos aparecem no modal. Abra os arquivos no seu editor pelo diretório do repositório, inclusive depois de recarregar a página. A aplicação não restaura processos PTY a partir desses arquivos. Se não for possível criar o histórico por falta de permissão, o review não é iniciado e o erro aparece no modal. Falhas durante a gravação também são exibidas.

### Consultar revisões pela interface

Clique em **Histórico** no menu superior. O modal abre na última pasta consultada; na primeira utilização, usa o repositório selecionado e entra em `.code-reviews/` quando essa subpasta existe. Sem repositório selecionado, começa na pasta pessoal do WSL.

Navegue pelas pastas, use **Início** para retornar à pasta pessoal ou a seta para subir um nível. Os arquivos `.md` da pasta atual são exibidos do mais recente para o mais antigo, com nome e data de alteração. A busca filtra os nomes dos arquivos e permite localizar a PR ou branch registrada no nome. Ao clicar em um arquivo, o conteúdo Markdown aparece no próprio modal, incluindo pareceres incompletos e registros `.session.md`.

O conteúdo é renderizado como Markdown formatado, com títulos, negrito, itálico, listas, citações, links, imagens, código inline e blocos de código. Também aceita tabelas, listas de tarefas, texto riscado e notas de rodapé do GitHub Flavored Markdown. A apresentação acompanha o tema claro/escuro, e tabelas e blocos de código largos têm rolagem horizontal. HTML embutido não é executado nem renderizado.

A leitura não altera arquivos nem inicia uma sessão do Claude. O botão **Atualizar arquivos** recarrega a pasta; para acompanhar um arquivo que ainda está sendo escrito, atualize a lista e abra-o novamente. A pasta de consulta é lembrada separadamente do repositório usado para novos reviews. Arquivos acima de 5 MB e links simbólicos para arquivos não são abertos; nesse caso, use seu editor local.

O único arquivo que o prompt autoriza o Claude a alterar é o parecer daquela sessão; o restante do código continua sob instrução de revisão sem alterações. A pasta `.code-reviews/` não é adicionada automaticamente ao `.gitignore` do repositório: se desejar manter o histórico fora dos commits, inclua-a no ignore local.

## Verificações

```bash
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:3001/health
```

O health check deve responder `{"ok":true}` com o backend em execução. `npm run build` valida a tipagem e gera a SPA em `apps/web/dist`; o fluxo integrado local documentado usa `npm run dev` e a origem 5173.

Os testes usam servidor HTTP, WebSocket e **node-pty reais** em porta efêmera. Um executável de teste temporário chamado `claude`, escrito em TypeScript, substitui somente o CLI via PATH. Assim não fazem chamadas de IA nem acessam seus repositórios, credenciais ou MCPs. Cobrem health, origem ausente/indevida, rota de upgrade, JSON inválido, schema, diretório inexistente, argumentos sem shell, cwd, TERM, entrada, resize, substituição da sessão, exit code, seletor de diretórios e persistência dos arquivos após gravação do parecer ou desconexão. Testes adicionais verificam histórico incompleto, remoção de ANSI dividido entre chunks, arquivos distintos e recusa de symlink no diretório de histórico. O teste manual acima verifica a integração com seu Claude e seus MCPs.

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
