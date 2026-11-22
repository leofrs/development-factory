import { useCallback, useState } from 'react';
import { FACTORY_DIFF_PAGE_SIZE } from '@development-factory/shared';
import type { FactoryDiffFile } from '@development-factory/shared';
import { fetchFactoryFlowDiffPage, fetchFactoryFlowDiffPatch } from '../api/factory-flows.js';
import type { FactoryDiffComparison } from '../api/factory-flows.js';
import { useFactoryInspection } from '../hooks/useFactoryInspection.js';

const changeLabels: Record<FactoryDiffFile['change'], string> = {
  added: 'Criado',
  modified: 'Modificado',
  deleted: 'Removido',
};

interface DiffSource {
  flowId: string;
  updatedAt?: string;
  comparison?: FactoryDiffComparison;
}

function fileKey(file: FactoryDiffFile): string {
  return `${file.untracked}:${file.path}`;
}

function PatchLines({ patch, path }: { patch: string; path: string }) {
  let inHunk = false;
  return (
    <pre
      aria-label={`Diff linha a linha de ${path}`}
      tabIndex={0}
      className="max-h-[55vh] overflow-auto rounded-lg border border-line bg-surface py-2 text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-accent"
    >
      <code className="block w-max min-w-full">
        {patch.split('\n').map((line, index) => {
          if (line.startsWith('diff --git ')) {
            inHunk = false;
          } else if (line.startsWith('@@ ')) {
            inHunk = true;
          }
          let tone = 'text-muted';
          if (inHunk && line.startsWith('+')) {
            tone = 'bg-accent/10 text-accent';
          } else if (inHunk && line.startsWith('-')) {
            tone = 'bg-danger/10 text-danger';
          } else if (line.startsWith('@@ ')) {
            tone = 'bg-selected text-secondary';
          }
          return (
            <span key={index} className={`block min-h-[1em] px-3 ${tone}`}>
              {line}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function FactoryFlowFilePatch({
  flowId,
  comparison,
  file,
}: Omit<DiffSource, 'updatedAt'> & { file: FactoryDiffFile }) {
  const { path, untracked } = file;
  const request = useCallback(
    (signal: AbortSignal) =>
      fetchFactoryFlowDiffPatch(flowId, { path, untracked }, comparison, signal),
    [flowId, path, untracked, comparison],
  );
  const { result, reload } = useFactoryInspection(request);

  if (!result) {
    return (
      <p role="status" className="text-xs text-muted">
        Carregando diff do arquivo…
      </p>
    );
  }
  if ('error' in result) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-danger">
          {result.error}
        </p>
        <button type="button" onClick={reload} className="modal-button">
          Tentar novamente
        </button>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="break-all whitespace-pre-wrap font-mono text-xs font-semibold">
        <bdi>{path}</bdi>
      </h3>
      {result.data.patch ? (
        <PatchLines patch={result.data.patch} path={path} />
      ) : (
        <p className="text-xs text-muted">Nenhuma diferença disponível para este arquivo.</p>
      )}
      {result.data.truncated && (
        <p role="status" className="text-xs text-warning">
          O diff atingiu o limite de exibição.
        </p>
      )}
    </div>
  );
}

export function FactoryFlowDiffPanel({
  flowId,
  updatedAt,
  comparison,
  baseBranch,
}: DiffSource & { baseBranch?: string | null }) {
  const [offset, setOffset] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const requestPage = useCallback(
    (signal: AbortSignal) => fetchFactoryFlowDiffPage(flowId, offset, comparison, signal),
    [flowId, offset, comparison],
  );
  const { result, reload } = useFactoryInspection(requestPage, updatedAt);
  const page = result && 'data' in result ? result.data : null;
  const selected = page?.files.find(file => fileKey(file) === selectedKey);
  const nextOffset = page?.nextOffset ?? null;

  function goToPage(next: number) {
    setOffset(next);
    setSelectedKey(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-secondary">
          {comparison ? (
            'Mudanças entre checkpoints'
          ) : (
            <>Worktree atual em relação a <code>{baseBranch ?? 'branch base'}</code></>
          )}
        </p>
        <button type="button" className="modal-button" onClick={reload} disabled={!result}>
          Atualizar diff
        </button>
      </div>

      {!result && (
        <p role="status" className="text-xs text-muted">
          Carregando arquivos alterados…
        </p>
      )}
      {result && 'error' in result && (
        <p role="alert" className="text-xs text-danger">
          {result.error}
        </p>
      )}
      {page?.truncated && (
        <p role="status" className="text-xs text-warning">
          Parte da lista de arquivos ficou indisponível.
        </p>
      )}
      {page?.files.length === 0 && (
        <p className="text-xs text-muted">
          {offset === 0
            ? 'Nenhum arquivo alterado nesta comparação.'
            : 'Nenhum arquivo nesta página.'}
        </p>
      )}
      {page && page.files.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
          <ul aria-label="Arquivos alterados" className="max-h-[55vh] space-y-2 overflow-y-auto p-1">
            {page.files.map(file => {
              const key = fileKey(file);
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-pressed={selectedKey === key}
                    onClick={() => setSelectedKey(value => (value === key ? null : key))}
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-left hover:bg-hover aria-pressed:border-accent aria-pressed:bg-selected"
                  >
                    <bdi className="block break-all whitespace-pre-wrap font-mono text-xs text-primary">
                      {file.path}
                    </bdi>
                    <span className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted">
                      <span>
                        {file.untracked ? 'Criado · Não rastreado' : changeLabels[file.change]}
                      </span>
                      {file.binary || file.additions === null || file.deletions === null ? (
                        <span>{file.binary ? 'Binário' : 'Contagem indisponível'}</span>
                      ) : (
                        <span className="space-x-2 font-mono">
                          <span className="text-accent">+{file.additions}</span>
                          <span className="text-danger">−{file.deletions}</span>
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <FactoryFlowFilePatch
              key={fileKey(selected)}
              flowId={flowId}
              comparison={comparison}
              file={selected}
            />
          ) : (
            <p className="px-1 pt-2 text-xs text-muted">Selecione um arquivo para ver o diff.</p>
          )}
        </div>
      )}
      {(offset > 0 || nextOffset !== null) && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <button
            type="button"
            className="modal-button"
            onClick={() => goToPage(Math.max(0, offset - FACTORY_DIFF_PAGE_SIZE))}
            disabled={offset === 0}
          >
            Página anterior
          </button>
          {page && page.files.length > 0 && (
            <span>Arquivos {offset + 1}–{offset + page.files.length} de {page.totalFiles}</span>
          )}
          <button
            type="button"
            className="modal-button"
            onClick={() => {
              if (nextOffset !== null) {
                goToPage(nextOffset);
              }
            }}
            disabled={nextOffset === null}
          >
            Próxima página
          </button>
        </div>
      )}
    </div>
  );
}
