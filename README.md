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
apps/server/test/terminal.test.ts            Integração HTTP / WS / PTY
apps/web/src/App.tsx                         Formulário e localStorage
apps/web/src/components/TerminalModal.tsx    TUI, resize, clipboard e cleanup
apps/web/src/components/DirectoryPicker.tsx  Seletor de diretórios do WSL
apps/web/src/components/HistoryModal.tsx     Navegação e leitura do histórico
```

O pacote compartilhado exporta `src/index.ts` diretamente; `tsx` e Vite o resolvem sem build intermediário. O backend também pode ser iniciado com `npm run start -w @development-factory/server`.

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
