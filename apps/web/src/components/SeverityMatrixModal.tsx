import { useEffect, useRef } from 'react';
import { Scale, X } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';

const SEVERITY_MATRIX_MARKDOWN = `Para calibrar o agente de IA e evitar falsos bloqueios (ou que ele deixe passar algo grave como mera sugestão), a matriz abaixo define a fronteira exata entre **Bloqueante** e **Sugestão** para cada uma das 9 categorias do prompt.

### Matriz de Severidade por Categoria

| Categoria | \`[Bloqueante]\` (Impede o Merge) | \`[Sugestão]\` (Não impede o Merge) |
| --- | --- | --- |
| **1. Escopo** | Faltou requisito explícito do Jira/comentários, ou entrou código não pedido que altera comportamento existente sem acordo. | Pequena melhoria de UX/fluxo não prevista no Jira, ou sugerir mover uma refatoração colateral segura para um PR futuro. |
| **2. Completude** | O mesmo bug/falha de regra corrigido continua ativo em fluxos irmãos idênticos (ex: corrigiu no web, quebrou no mobile/API). | O padrão aparece em um fluxo secundário/legado de baixo risco onde a correção imediata não é crítica, mas vale mapear. |
| **3. Edge Case** | Gera crash/erro 500, corrompe dados, viola regra de negócio ou impede ação básica (ex: limpar campo) em cenário plausível. | Cenário teórico extremo (ex: lista de 1 milhão de itens) ou melhoria de resiliência onde o erro já é tratado sem quebrar. |
| **4. Regressão** | Quebra contrato de API, remove/altera retorno consumido por outros módulos ou falha em contexto específico (ex: token de usuário). | Mudança interna que exige atenção em integrações futuras, mas mantém retrocompatibilidade total no momento. |
| **5. Segurança** | Brecha de autenticação/autorização, exposição de dados sensíveis/segredos, ausência de auditoria crítica ou bypass de validação. | Endurecimento extra (*hardening*), como restrição adicional de cabeçalhos ou logs preventivos não exigidos por compliance. |
| **6. Performance** | Query N+1 em rotas críticas, loop bloqueante que trava a thread ou vazamento de memória evidente em escala normal. | Micro-otimizações (ex: trocar \`forEach\` por \`for\`, memoização leve) sem impacto mensurável na latência atual. |
| **7. Convenção** | Viola regra explícita documentada no repositório (\`AGENTS.md\`, \`CONTRIBUTING\`) ou usa API \`@deprecated\` proibida. | Uso de helper local que poderia ser extraído para compartilhamento global, ou melhora de nomenclatura fora das regras escritas. |
| **8. Testes** | Nenhuma cobertura para as linhas novas, teste afirmando bug como esperado, ou falha de cobertura exigida pelo CI/projeto. | Adicionar cenários extras de borda em uma suíte que já cobre o caminho feliz e os erros principais com sucesso. |
| **9. Higiene** | Arquivos pessoais/temporários no diff, logs de debug esquecidos, conflitos não resolvidos ou erros de linter que quebram o CI. | Falta de detalhamento na descrição do PR sobre uma decisão técnica válida que já está clara no código. |
`;

interface SeverityMatrixModalProps {
  onClose: () => void;
}

/**
 * Modal de referência exibindo a Matriz de Severidade por Categoria em Markdown
 * para auxiliar na interpretação dos pareceres gerados pelo Code Review.
 */
export function SeverityMatrixModal({ onClose }: SeverityMatrixModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = oldOverflow;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="severity-matrix-title"
      className="history-dialog m-auto h-[85dvh] max-h-[100dvh] w-[calc(100%-1rem)] max-w-4xl overflow-hidden rounded-2xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-elevated px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-page text-accent">
              <Scale size={16} />
            </span>
            <div className="min-w-0">
              <h2 id="severity-matrix-title" className="truncate text-sm font-semibold">
                Matriz de Severidade por Categoria
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-muted">
                Guia de referência para interpretar critérios de Bloqueante e Sugestão no review
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-button"
            onClick={onClose}
            aria-label="Fechar matriz de severidade"
          >
            <X size={14} />
            Fechar
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10">
          <MarkdownContent content={SEVERITY_MATRIX_MARKDOWN} />
        </div>
      </div>
    </dialog>
  );
}
