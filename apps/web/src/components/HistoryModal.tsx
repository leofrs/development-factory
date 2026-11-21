import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  FileText,
  Folder,
  History,
  Home,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  HistoryFileSchema,
  HistoryListingSchema,
  SavedReviewReportsSchema,
  type FactoryFlow,
  type FactoryFlowArtifact,
  type FactoryFlowDetails,
  type FactoryFlowStage,
  type FactoryStageName,
  type HistoryFile,
  type HistoryListing,
  type SavedReviewReport,
} from '@development-factory/shared';
import { fetchFactoryFlowDetails } from '../api/factory-flows';
import {
  getFactoryArtifactKindLabel,
  getFactoryArtifactStatusPresentation,
  getFactoryStageLabel,
  getFactoryStageStep,
} from '../utils/factory-flow-status';
import { MarkdownContent } from './MarkdownContent';

const storageKey = 'development-factory.historyPath';
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

type HistorySource = 'reports' | 'artifacts' | 'files';

async function fetchHistory<T>(
  route: string,
  params: URLSearchParams,
  parse: (value: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:3001/api/history${route}?${params}`, { signal });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : 'Não foi possível consultar o histórico.';
    throw new Error(message);
  }
  return parse(value);
}

function errorMessage(error: unknown): string {
  return error instanceof TypeError
    ? 'Não foi possível conectar ao WSL. Verifique se o backend está em execução.'
    : error instanceof Error
      ? error.message
      : 'Não foi possível consultar o histórico.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function HistoryModal({
  initialPath,
  factoryFlows = [],
  onClose,
}: {
  initialPath: string;
  factoryFlows?: FactoryFlow[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [location, setLocation] = useState(() => {
    let saved = '';
    try {
      saved =
        localStorage.getItem(storageKey) ?? localStorage.getItem('make-and-review.historyPath') ?? '';
    } catch {
      /* A navegação funciona sem persistência. */
    }
    return { path: saved || initialPath || undefined, preferReviews: true };
  });
  const [source, setSource] = useState<HistorySource>('reports');
  const [savedReports, setSavedReports] = useState<SavedReviewReport[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(
    () => factoryFlows[0]?.id ?? null,
  );
  const [flowDetails, setFlowDetails] = useState<FactoryFlowDetails | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<HistoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>();
  const [file, setFile] = useState<HistoryFile>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  const effectiveFlow = useMemo(() => {
    if (factoryFlows.length === 0) {
      return null;
    }
    if (selectedFlowId) {
      const found = factoryFlows.find(item => item.id === selectedFlowId);
      if (found) {
        return found;
      }
    }
    return factoryFlows[0] ?? null;
  }, [factoryFlows, selectedFlowId]);
  const effectiveFlowId = effectiveFlow?.id ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');

    async function loadHistory() {
      const params = new URLSearchParams();
      if (source === 'reports') {
        const reports = await fetchHistory(
          '/reports',
          params,
          SavedReviewReportsSchema.parse,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSavedReports(reports);
        }
        return;
      }

      if (source === 'artifacts') {
        if (!effectiveFlowId) {
          if (!controller.signal.aborted) {
            setFlowDetails(null);
          }
          return;
        }
        const details = await fetchFactoryFlowDetails(effectiveFlowId, controller.signal);
        if (!controller.signal.aborted) {
          setFlowDetails(details);
        }
        return;
      }

      if (location.path) {
        params.set('path', location.path);
      }
      if (location.preferReviews) {
        params.set('preferReviews', '1');
      }
      const value = await fetchHistory('', params, HistoryListingSchema.parse, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setListing(value);
      try {
        localStorage.setItem(storageKey, value.path);
      } catch {
        // A navegação funciona sem persistência.
      }
    }

    loadHistory()
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [effectiveFlowId, location, refresh, source]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    const controller = new AbortController();
    const separator = selectedPath.lastIndexOf('/');
    const params = new URLSearchParams({
      path: selectedPath.slice(0, separator) || '/',
      name: selectedPath.slice(separator + 1),
    });
    fetchHistory('/file', params, HistoryFileSchema.parse, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setFile(value);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          const message = errorMessage(reason);
          setFileError(
            source === 'reports'
              ? `Parecer indisponível. ${message}`
              : source === 'artifacts'
                ? `Artefato indisponível. ${message}`
                : message,
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFileLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedPath, source]);

  function resetSelection() {
    setSelectedPath(undefined);
    setFile(undefined);
    setFileError('');
    setFileLoading(false);
  }

  function navigate(path?: string) {
    setLoading(true);
    setFilter('');
    resetSelection();
    setLocation({ path, preferReviews: false });
  }

  function switchSource(nextSource: HistorySource) {
    if (nextSource === source) {
      return;
    }
    setLoading(true);
    setError('');
    setFilter('');
    resetSelection();
    setSource(nextSource);
  }

  function reload() {
    setLoading(true);
    resetSelection();
    setRefresh(current => current + 1);
  }

  const combinedFlowArtifacts = useMemo(() => {
    if (!flowDetails || flowDetails.flow.id !== effectiveFlowId) {
      return [];
    }

    const stagesByName = new Map<FactoryStageName, FactoryFlowStage>();
    for (const stage of flowDetails.stages) {
      stagesByName.set(stage.name, stage);
    }

    const seenPaths = new Set(flowDetails.artifacts.map(item => item.path));
    const stagePlanFallbacks: Array<{
      id: string;
      stage: FactoryStageName;
      kindLabel: string;
      path: string;
      status: FactoryFlowArtifact['status'];
      iteration: number;
      viewable: boolean;
    }> = [];

    for (const stage of stagesByName.values()) {
      if (
        stage.name !== 'development' &&
        stage.name !== 'tests' &&
        stage.name !== 'review' &&
        stage.reportPath &&
        !seenPaths.has(stage.reportPath)
      ) {
        seenPaths.add(stage.reportPath);
        stagePlanFallbacks.push({
          id: `stage-report:${stage.id}`,
          stage: stage.name,
          kindLabel: 'Plano técnico',
          path: stage.reportPath,
          status: 'ready',
          iteration: 0,
          viewable: true,
        });
      }
    }

    return [
      ...flowDetails.artifacts.map(artifact => ({
        id: artifact.id,
        stage: artifact.stage,
        kindLabel: getFactoryArtifactKindLabel(artifact.kind),
        path: artifact.path,
        status: artifact.status,
        iteration: artifact.iteration,
        viewable: artifact.format === 'markdown' && artifact.status !== 'failed',
      })),
      ...stagePlanFallbacks,
    ];
  }, [effectiveFlowId, flowDetails]);

  const files =
    source === 'reports'
      ? savedReports.map(report => ({
          key: report.id,
          path: report.path,
          name: report.path.slice(report.path.lastIndexOf('/') + 1),
          description:
            report.target.type === 'pr'
              ? `PR #${report.target.identifier}`
              : `Branch ${report.target.identifier}`,
          context: report.target.repoPath,
          modifiedAt: report.savedAt,
        }))
      : (listing?.files ?? []).map(entry => ({
          ...entry,
          key: entry.path,
          description: entry.name.endsWith('.session.md') ? 'Registro da sessão' : 'Parecer / Markdown',
          context: '',
        }));

  const query = filter.toLocaleLowerCase();
  const visibleFiles = files.filter(entry =>
    [entry.name, entry.path, entry.description, entry.context].some(value =>
      value.toLocaleLowerCase().includes(query),
    ),
  );

  const visibleArtifacts = combinedFlowArtifacts.filter(artifact =>
    [
      artifact.kindLabel,
      artifact.path,
      getFactoryStageLabel(artifact.stage),
      getFactoryStageStep(artifact.stage),
    ].some(value => value.toLocaleLowerCase().includes(query)),
  );

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="history-title"
      className="history-dialog m-auto h-[88dvh] w-[calc(100%-1rem)] max-w-6xl overflow-hidden rounded-xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <History size={20} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 id="history-title" className="text-sm font-semibold">
              Histórico de revisões e artefatos
            </h2>
            <p className="mt-1 text-xs text-muted">
              Abra pareceres salvos, artefatos de fluxos da Factory ou arquivos locais.
            </p>
          </div>
          <button type="button" className="modal-button" onClick={onClose} aria-label="Fechar histórico">
            <X size={17} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <section
            className="flex max-h-[42%] min-h-0 shrink-0 flex-col border-b border-line md:max-h-none md:w-80 md:border-b-0 md:border-r"
            aria-label="Pastas e arquivos de histórico"
          >
            <div className="space-y-3 border-b border-line p-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Origem do histórico">
                <button
                  type="button"
                  className="modal-button"
                  aria-pressed={source === 'reports'}
                  onClick={() => switchSource('reports')}
                >
                  Pareceres salvos
                </button>
                <button
                  type="button"
                  className="modal-button"
                  aria-pressed={source === 'artifacts'}
                  onClick={() => switchSource('artifacts')}
                >
                  Artefatos de fluxos
                </button>
                <button
                  type="button"
                  className="modal-button"
                  aria-pressed={source === 'files'}
                  onClick={() => switchSource('files')}
                >
                  Arquivos locais
                </button>
              </div>

              {source === 'artifacts' && factoryFlows.length > 0 && (
                <label className="grid gap-1 text-[11px] font-medium text-secondary">
                  Fluxo selecionado
                  <select
                    value={effectiveFlowId ?? ''}
                    onChange={event => {
                      resetSelection();
                      setSelectedFlowId(event.target.value || null);
                    }}
                    className="field px-2.5 py-2 text-xs"
                  >
                    {factoryFlows.map(flow => (
                      <option key={flow.id} value={flow.id}>
                        {flow.title} ({getFactoryStageStep(flow.currentStage)} ·{' '}
                        {getFactoryStageLabel(flow.currentStage)})
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="flex gap-2">
                {source === 'files' && (
                  <>
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => navigate()}
                      disabled={loading}
                      title="Pasta pessoal do WSL"
                    >
                      <Home size={14} />
                      Início
                    </button>
                    <button
                      type="button"
                      className="modal-button"
                      onClick={() => {
                        if (listing?.parentPath) {
                          navigate(listing.parentPath);
                        }
                      }}
                      disabled={loading || !listing?.parentPath}
                      aria-label="Subir uma pasta"
                    >
                      <ArrowUp size={14} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="modal-button"
                  onClick={reload}
                  disabled={loading}
                  aria-label="Atualizar histórico"
                >
                  <RefreshCw size={14} />
                </button>
              </div>

              {source === 'files' && (
                <p className="break-all font-mono text-[11px] leading-5 text-muted" aria-live="polite">
                  {loading
                    ? 'Abrindo pasta…'
                    : error
                      ? location.path || 'Pasta pessoal'
                      : listing?.path}
                </p>
              )}

              <input
                type="search"
                className="field pl-3"
                placeholder={
                  source === 'artifacts' ? 'Buscar artefato ou etapa…' : 'Buscar revisão ou arquivo…'
                }
                aria-label="Buscar arquivo no histórico"
                value={filter}
                onChange={event => setFilter(event.target.value)}
                disabled={loading || Boolean(error)}
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>
              {loading ? (
                <p
                  role="status"
                  className="flex items-center justify-center gap-2 p-6 text-xs text-muted"
                >
                  <LoaderCircle size={16} className="animate-spin" />
                  Carregando…
                </p>
              ) : error ? (
                <div role="alert" className="space-y-3 p-3 text-xs leading-5 text-danger">
                  <p>{error}</p>
                  <button type="button" className="modal-button" onClick={reload}>
                    Tentar novamente
                  </button>
                </div>
              ) : source === 'artifacts' ? (
                factoryFlows.length === 0 ? (
                  <p className="px-3 py-5 text-xs leading-5 text-muted">
                    Nenhum fluxo registrado ainda.
                  </p>
                ) : visibleArtifacts.length > 0 ? (
                  <ul className="space-y-1.5">
                    {visibleArtifacts.map(artifact => {
                      const statusInfo = getFactoryArtifactStatusPresentation(artifact.status);
                      const isSelected = selectedPath === artifact.path;

                      return (
                        <li key={artifact.id}>
                          {artifact.viewable ? (
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              title={artifact.path}
                              onClick={() => {
                                if (selectedPath !== artifact.path) {
                                  setFile(undefined);
                                  setFileError('');
                                  setFileLoading(true);
                                  setSelectedPath(artifact.path);
                                }
                              }}
                              className={`flex w-full gap-2 rounded-md px-3 py-3 text-left ${
                                isSelected ? 'bg-selected text-accent' : 'hover:bg-hover'
                              }`}
                            >
                              <FileText size={15} className="mt-0.5 shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                                  <span>{artifact.kindLabel}</span>
                                  <span className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                                    {getFactoryStageStep(artifact.stage)} ·{' '}
                                    {getFactoryStageLabel(artifact.stage)}
                                  </span>
                                  {artifact.iteration > 0 && (
                                    <span className="rounded border border-accent/25 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-accent">
                                      Iteração {artifact.iteration}
                                    </span>
                                  )}
                                  <span className={`font-mono text-[10px] ${statusInfo.textClass}`}>
                                    {statusInfo.label}
                                  </span>
                                </span>
                                <span className="mt-1 block break-all font-mono text-[10px] leading-4 text-muted">
                                  {artifact.path}
                                </span>
                              </span>
                            </button>
                          ) : (
                            <div
                              title={artifact.path}
                              className="flex w-full gap-2 rounded-md border border-line-subtle bg-page/60 px-3 py-3 text-left opacity-80"
                            >
                              <FileText size={15} className="mt-0.5 shrink-0 text-muted" />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                                  <span>{artifact.kindLabel}</span>
                                  <span className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                                    {getFactoryStageStep(artifact.stage)} ·{' '}
                                    {getFactoryStageLabel(artifact.stage)}
                                  </span>
                                  {artifact.iteration > 0 && (
                                    <span className="rounded border border-accent/25 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-accent">
                                      Iteração {artifact.iteration}
                                    </span>
                                  )}
                                  <span className={`font-mono text-[10px] ${statusInfo.textClass}`}>
                                    {statusInfo.label}
                                  </span>
                                </span>
                                <span className="mt-1 block break-all font-mono text-[10px] leading-4 text-muted">
                                  {artifact.path}
                                </span>
                              </span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-3 py-5 text-xs leading-5 text-muted">
                    {filter
                      ? 'Nenhum artefato encontrado para esta busca.'
                      : 'Nenhum artefato gerado para este fluxo ainda.'}
                  </p>
                )
              ) : (
                <>
                  {source === 'files' && Boolean(listing?.directories.length) && (
                    <>
                      <h3 className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted">
                        Pastas
                      </h3>
                      <ul>
                        {listing?.directories.map(directory => (
                          <li key={directory.path}>
                            <button
                              type="button"
                              onClick={() => navigate(directory.path)}
                              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-hover"
                            >
                              <Folder size={15} className="shrink-0 text-accent" />
                              <span className="min-w-0 flex-1 break-all">{directory.name}</span>
                              <ChevronRight size={13} className="shrink-0 text-muted" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {visibleFiles.length > 0 ? (
                    <ul>
                      {visibleFiles.map(entry => (
                        <li key={entry.key}>
                          <button
                            type="button"
                            aria-pressed={selectedPath === entry.path}
                            title={entry.path}
                            onClick={() => {
                              if (selectedPath !== entry.path) {
                                setFile(undefined);
                                setFileError('');
                                setFileLoading(true);
                                setSelectedPath(entry.path);
                              }
                            }}
                            className={`flex w-full gap-2 rounded-md px-3 py-3 text-left ${
                              selectedPath === entry.path ? 'bg-selected text-accent' : 'hover:bg-hover'
                            }`}
                          >
                            <FileText size={15} className="mt-0.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="block break-all font-mono text-[11px] leading-5">
                                {source === 'reports' ? entry.description : entry.name}
                              </span>
                              {entry.context && (
                                <span className="block truncate text-[10px] text-muted">
                                  {entry.context}
                                </span>
                              )}
                              <span className="mt-1 block text-[10px] text-muted">
                                {source === 'files' && `${entry.description} · `}
                                {dateFormat.format(new Date(entry.modifiedAt))}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-3 py-5 text-xs leading-5 text-muted">
                      {filter
                        ? 'Nenhum resultado para esta busca.'
                        : source === 'reports'
                          ? 'Nenhum parecer salvo.'
                          : 'Nenhum arquivo Markdown nesta pasta.'}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

          <section
            className="flex min-h-0 min-w-0 flex-1 flex-col bg-page"
            aria-label="Conteúdo do documento"
            aria-busy={fileLoading}
          >
            {fileLoading ? (
              <p
                role="status"
                className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted"
              >
                <LoaderCircle size={18} className="animate-spin" />
                Abrindo documento…
              </p>
            ) : fileError ? (
              <p role="alert" className="p-6 text-sm leading-6 text-danger">
                {fileError}
              </p>
            ) : file ? (
              <>
                <div className="border-b border-line p-4">
                  <h3 className="break-all text-sm font-medium">{file.name}</h3>
                  <p className="mt-1 break-all font-mono text-[10px] leading-5 text-muted">
                    {file.path}
                  </p>
                  <p className="mt-2 text-[11px] text-muted">
                    Conteúdo Markdown · {dateFormat.format(new Date(file.modifiedAt))} ·{' '}
                    {new Intl.NumberFormat('pt-BR').format(file.size)} bytes
                  </p>
                </div>
                <div key={file.path} className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">
                  {file.content ? (
                    <MarkdownContent content={file.content} />
                  ) : (
                    <p className="text-sm text-muted">Arquivo vazio.</p>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted">
                <FileText size={30} className="text-accent" />
                <p className="text-sm">
                  {source === 'artifacts'
                    ? 'Selecione um artefato de fluxo para consultar.'
                    : 'Selecione uma revisão para consultar.'}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}
