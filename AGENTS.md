Nunca faça o commit de arquivo `.md` que não seja o `README.md` e `AGENTS.md`

## Padrão obrigatório para implementações e alterações

- Antes de implementar ou alterar código, leia e siga a seção [Padrão de lint e qualidade](README.md#padrão-de-lint-e-qualidade). Ela é a referência para todos os workspaces, incluindo testes e configurações.
- Aplique as regras de tipagem, Promises, imports, React, acessibilidade, formatação e revisão descritas nessa seção. Preserve o escopo da tarefa e alterações existentes do usuário.
- Não enfraqueça o TypeScript nem desabilite regras globalmente para fazer uma entrega passar. Exceções locais exigem a regra específica e uma justificativa técnica.
- Para mudanças de código, execute `npm run typecheck`, `npm test` e `npm run build`. Quando os scripts de lint e formatação estiverem disponíveis, execute também `npm run lint` e `npm run format:check`, ou o comando agregado `npm run check` que cubra todas as verificações.
- Para mudanças apenas de documentação, confira links e comandos citados e execute `git diff --check`.
- Informe quais verificações passaram, quais não foram executadas e os motivos. Enquanto ESLint e Prettier não estiverem configurados, revise as regras manualmente e não afirme que o lint passou.
