import { useCallback, useEffect, useRef, useState } from 'react';
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

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export interface FactoryDiffFocusTarget {
  readonly path: string;
  readonly line?: number;
  readonly requestId: number;
}

interface DiffSource {
  flowId: string;
  updatedAt?: string;
  comparison?: FactoryDiffComparison;
}

function fileKey(file: FactoryDiffFile): string {
  return `${file.untracked}:${file.path}`;
}

function parsePatchLinesWithLineNumbers(patch: string): Array<{
  readonly text: string;
  readonly tone: string;
  readonly lineNumber: number | null;
}> {
  let inHunk = false;
  let currentNewLine: number | null = null;

  return patch.split('\n').map(line => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      currentNewLine = null;
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
      const match = HUNK_HEADER_PATTERN.exec(line);
      currentNewLine = match?.[1] !== undefined ? Number(match[1]) : null;
    }

    let tone = 'text-muted';
    let lineNumber: number | null = null;

    if (line.startsWith('@@ ')) {
      tone = 'bg-selected text-secondary';
    } else if (inHunk && line.startsWith('+')) {
      tone = 'bg-accent/10 text-accent';
      if (currentNewLine !== null) {
        lineNumber = currentNewLine;
        currentNewLine += 1;
      }
    } else if (inHunk && line.startsWith('-')) {
      tone = 'bg-danger/10 text-danger';
    } else if (inHunk && !line.startsWith('\\')) {
      if (currentNewLine !== null) {
        lineNumber = currentNewLine;
        currentNewLine += 1;
      }
    }

    return { text: line, tone, lineNumber };
  });
}

function PatchLines({
  patch,
  path,
  focusLine,
}: {
  patch: string;
  path: string;
  focusLine?: number;
}) {
  const focusLineRef = useRef<HTMLSpanElement | null>(null);
  const parsedLines = parsePatchLinesWithLineNumbers(patch);

  useEffect(() => {
    if (focusLine === undefined) {
      return;
    }
    const target = focusLineRef.current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
  }, [focusLine, patch]);

  let matchedFocus = false;

  return (
    <pre
      aria-label={`Diff linha a linha de ${path}`}
      tabIndex={0}
      className="max-h-[55vh] overflow-auto rounded-lg border border-line bg-surface py-2 text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-accent"
    >
      <code className="block w-max min-w-full">
        {parsedLines.map((entry, index) => {
          const isFocusLine =
            !matchedFocus && focusLine !== undefined && entry.lineNumber === focusLine;
          if (isFocusLine) {
            matchedFocus = true;
          }
          return (
            <span
              key={index}
              ref={isFocusLine ? focusLineRef : undefined}
              data-line={entry.lineNumber ?? undefined}
              aria-current={isFocusLine ? 'location' : undefined}
              className={`block min-h-[1em] px-3 ${entry.tone} ${
                isFocusLine ? 'bg-warning/20 text-primary ring-1 ring-inset ring-warning/60' : ''
              }`}
            >
              {entry.lineNumber !== null ? (
                <span className="mr-3 inline-block w-10 select-none text-right font-mono text-[10px] text-muted">
                  {entry.lineNumber}
                </span>
              ) : (
                <span className="mr-3 inline-block w-10 select-none" aria-hidden="true" />
              )}
              {entry.text}
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
  focusLine,
}: Omit<DiffSource, 'updatedAt'> & { file: FactoryDiffFile; focusLine?: number }) {
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all whitespace-pre-wrap font-mono text-xs font-semibold">
          <bdi>{path}</bdi>
        </h3>
        {focusLine !== undefined && (
          <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-[10px] text-warning">
            Linha {focusLine}
          </span>
        )}
      </div>
      {result.data.patch ? (
        <PatchLines patch={result.data.patch} path={path} focusLine={focusLine} />
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
  focusTarget,
}: DiffSource & {
  baseBranch?: string | null;
  focusTarget?: FactoryDiffFocusTarget | null;
}) {
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<{
    focusRequestId: number | null;
    key: string | null;
  }>({ focusRequestId: null, key: null });
  const requestPage = useCallback(
    (signal: AbortSignal) => fetchFactoryFlowDiffPage(flowId, offset, comparison, signal),
    [flowId, offset, comparison],
  );
  const { result, reload } = useFactoryInspection(requestPage, updatedAt);
  const page = result && 'data' in result ? result.data : null;
  const activeFocus =
    focusTarget && selection.focusRequestId !== focusTarget.requestId ? focusTarget : null;
  const selectedKey = activeFocus
    ? fileKey(
        page?.files.find(file => file.path === activeFocus.path) ?? {
          path: activeFocus.path,
          change: 'modified',
          untracked: false,
          additions: null,
          deletions: null,
          binary: false,
        },
      )
    : selection.key;
  const selectedFromPage = page?.files.find(file => fileKey(file) === selectedKey);
  const selected: FactoryDiffFile | undefined =
    selectedFromPage ??
    (activeFocus
      ? {
          path: activeFocus.path,
          change: 'modified',
          untracked: false,
          additions: null,
          deletions: null,
          binary: false,
        }
      : undefined);
  const focusLine =
    selected && focusTarget && selected.path === focusTarget.path ? focusTarget.line : undefined;
  const nextOffset = page?.nextOffset ?? null;

  function goToPage(next: number) {
    setOffset(next);
    setSelection({ focusRequestId: focusTarget?.requestId ?? null, key: null });
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
                    onClick={() =>
                      setSelection({
                        focusRequestId: focusTarget?.requestId ?? null,
                        key: selectedKey === key ? null : key,
                      })
                    }
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
              key={`${fileKey(selected)}:${focusLine ?? 'none'}`}
              flowId={flowId}
              comparison={comparison}
              file={selected}
              focusLine={focusLine}
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
