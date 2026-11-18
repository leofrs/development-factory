import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, FileText, Folder, History, Home, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { HistoryFileSchema, HistoryListingSchema, type HistoryFile, type HistoryListing } from '@development-factory/shared';
import { MarkdownContent } from './MarkdownContent';

const storageKey = 'development-factory.historyPath';
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

async function fetchHistory<T>(route: string, params: URLSearchParams, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const response = await fetch(`http://127.0.0.1:3001/api/history${route}?${params}`, { signal });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error : 'Não foi possível consultar o histórico.';
    throw new Error(message);
  }
  return parse(value);
}

function errorMessage(error: unknown): string {
  return error instanceof TypeError ? 'Não foi possível conectar ao WSL. Verifique se o backend está em execução.'
    : error instanceof Error ? error.message : 'Não foi possível consultar o histórico.';
}

export function HistoryModal({ initialPath, onClose }: { initialPath: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [location, setLocation] = useState(() => {
    let saved = '';
    try { saved = localStorage.getItem(storageKey) ?? localStorage.getItem('make-and-review.historyPath') ?? ''; } catch { /* A navegação funciona sem persistência. */ }
    return { path: saved || initialPath || undefined, preferReviews: true };
  });
  const [listing, setListing] = useState<HistoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [selectedName, setSelectedName] = useState<string>();
  const [file, setFile] = useState<HistoryFile>();
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog?.close(); document.body.style.overflow = previous; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (location.path) params.set('path', location.path);
    if (location.preferReviews) params.set('preferReviews', '1');
    void fetchHistory('', params, value => HistoryListingSchema.parse(value), controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setListing(value);
        try { localStorage.setItem(storageKey, value.path); } catch { /* Sem persistência neste navegador. */ }
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [location]);

  useEffect(() => {
    if (!selectedName || !listing) return;
    const controller = new AbortController();
    setFileLoading(true);
    setFileError('');
    const params = new URLSearchParams({ path: listing.path, name: selectedName });
    void fetchHistory('/file', params, value => HistoryFileSchema.parse(value), controller.signal)
      .then(value => { if (!controller.signal.aborted) setFile(value); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setFileError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [selectedName, listing]);

  function navigate(path?: string) {
    setLoading(true);
    setFilter('');
    setSelectedName(undefined);
    setFile(undefined);
    setFileError('');
    setFileLoading(false);
    setLocation({ path, preferReviews: false });
  }

  const files = listing?.files.filter(entry => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  return <dialog ref={dialogRef} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="history-title" className="history-dialog m-auto h-[88dvh] w-[calc(100%-1rem)] max-w-6xl overflow-hidden rounded-xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]">
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <History size={20} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1"><h2 id="history-title" className="text-sm font-semibold">Histórico de revisões</h2><p className="mt-1 text-xs text-muted">Escolha uma pasta e abra o parecer ou o registro de uma sessão.</p></div>
        <button type="button" className="modal-button" onClick={onClose} aria-label="Fechar histórico"><X size={17} /></button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="flex max-h-[42%] min-h-0 shrink-0 flex-col border-b border-line md:max-h-none md:w-80 md:border-b-0 md:border-r" aria-label="Pastas e arquivos de histórico">
          <div className="space-y-3 border-b border-line p-4">
            <div className="flex gap-2">
              <button type="button" className="modal-button" onClick={() => navigate()} disabled={loading} title="Pasta pessoal do WSL"><Home size={14} />Início</button>
              <button type="button" className="modal-button" onClick={() => { if (listing?.parentPath) navigate(listing.parentPath); }} disabled={loading || !listing?.parentPath} title="Subir uma pasta" aria-label="Subir uma pasta"><ArrowUp size={14} /></button>
              <button type="button" className="modal-button" onClick={() => navigate(listing?.path ?? location.path)} disabled={loading} title="Atualizar arquivos" aria-label="Atualizar arquivos"><RefreshCw size={14} /></button>
            </div>
            <p className="break-all font-mono text-[11px] leading-5 text-muted" aria-live="polite">{loading ? 'Abrindo pasta…' : error ? location.path || 'Pasta pessoal' : listing?.path}</p>
            <input type="search" className="field pl-3" placeholder="Buscar revisão ou arquivo…" aria-label="Buscar arquivo no histórico" value={filter} onChange={event => setFilter(event.target.value)} disabled={loading || Boolean(error)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>
            {loading ? <p role="status" className="flex items-center justify-center gap-2 p-6 text-xs text-muted"><LoaderCircle size={16} className="animate-spin" />Carregando…</p>
              : error ? <div role="alert" className="space-y-3 p-3 text-xs leading-5 text-danger"><p>{error}</p><button className="modal-button" onClick={() => navigate(location.path)}>Tentar novamente</button></div>
                : <>
                  {Boolean(listing?.directories.length) && <><h3 className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted">Pastas</h3><ul>{listing?.directories.map(directory => <li key={directory.path}><button type="button" onClick={() => navigate(directory.path)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-hover"><Folder size={15} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-all">{directory.name}</span><ChevronRight size={13} className="shrink-0 text-muted" /></button></li>)}</ul></>}
                  <h3 className="px-3 py-3 text-[10px] uppercase tracking-widest text-muted">Arquivos Markdown · {files.length}</h3>
                  {files.length ? <ul>{files.map(entry => <li key={entry.path}><button type="button" aria-pressed={selectedName === entry.name} onClick={() => { if (selectedName === entry.name) return; setFile(undefined); setFileError(''); setFileLoading(true); setSelectedName(entry.name); }} className={`flex w-full gap-2 rounded-md px-3 py-3 text-left ${selectedName === entry.name ? 'bg-selected text-accent' : 'hover:bg-hover'}`}><FileText size={15} className="mt-0.5 shrink-0" /><span className="min-w-0"><span className="block break-all font-mono text-[11px] leading-5">{entry.name}</span><span className="mt-1 block text-[10px] text-muted">{entry.name.endsWith('.session.md') ? 'Registro da sessão' : 'Parecer / Markdown'} · {dateFormat.format(new Date(entry.modifiedAt))}</span></span></button></li>)}</ul>
                    : <p className="px-3 py-5 text-xs leading-5 text-muted">{filter ? 'Nenhum arquivo corresponde à busca.' : 'Nenhum arquivo Markdown nesta pasta. Selecione a pasta .code-reviews do repositório ou navegue até outro histórico.'}</p>}
                </>}
          </div>
        </section>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" aria-label="Conteúdo da revisão" aria-busy={fileLoading}>
          {fileLoading ? <p role="status" className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted"><LoaderCircle size={18} className="animate-spin" />Abrindo revisão…</p>
            : fileError ? <p role="alert" className="p-6 text-sm leading-6 text-danger">{fileError}</p>
              : file ? <><div className="border-b border-line p-4"><h3 className="break-all text-sm font-medium">{file.name}</h3><p className="mt-1 break-all font-mono text-[10px] leading-5 text-muted">{file.path}</p><p className="mt-2 text-[11px] text-muted">Conteúdo Markdown · {dateFormat.format(new Date(file.modifiedAt))} · {new Intl.NumberFormat('pt-BR').format(file.size)} bytes</p></div><div key={file.path} className="min-h-0 flex-1 overflow-auto p-5 sm:p-6">{file.content ? <MarkdownContent content={file.content} /> : <p className="text-sm text-muted">Arquivo vazio.</p>}</div></>
                : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted"><FileText size={30} className="text-accent" /><p className="text-sm">Selecione uma revisão para consultar.</p><p className="max-w-sm text-xs leading-6">Os arquivos são abertos diretamente do WSL. Você pode consultar o parecer final e o registro de cada sessão.</p></div>}
        </section>
      </div>
    </div>
  </dialog>;
}
