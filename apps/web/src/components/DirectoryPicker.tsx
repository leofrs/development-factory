import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Folder, Home, LoaderCircle, X } from 'lucide-react';
import { DirectoryListingSchema, type DirectoryListing } from '@development-factory/shared';

export function DirectoryPicker({ initialPath, onSelect, onClose }: { initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState<string | undefined>(initialPath || undefined);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [attempt, setAttempt] = useState(0);

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
    setFilter('');
    const query = path ? `?${new URLSearchParams({ path })}` : '';
    void fetch(`http://127.0.0.1:3001/api/directories${query}`, { signal: controller.signal })
      .then(async response => {
        const value: unknown = await response.json();
        if (!response.ok) throw new Error('Não foi possível abrir esta pasta. Ela pode não existir ou estar sem permissão de leitura.');
        return DirectoryListingSchema.parse(value);
      })
      .then(value => { if (!controller.signal.aborted) setListing(value); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof TypeError ? 'Não foi possível acessar o WSL. Verifique se o backend está em execução.' : reason instanceof Error ? reason.message : 'Falha ao listar as pastas.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);

  const navigate = (nextPath?: string) => { setLoading(true); setPath(nextPath); setAttempt(current => current + 1); };
  const directories = listing?.directories.filter(directory => directory.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  return <dialog ref={dialogRef} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="directory-title" className="directory-dialog m-auto w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl border border-line-strong bg-surface p-0 text-primary shadow-2xl">
    <div className="flex max-h-[80dvh] flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-4"><Folder size={19} className="text-accent" /><div className="flex-1"><h2 id="directory-title" className="text-sm font-semibold">Selecionar repositório no WSL</h2><p className="mt-1 text-xs text-muted">Navegue até a pasta do projeto.</p></div><button type="button" className="modal-button" onClick={onClose} aria-label="Fechar seletor"><X size={16} /></button></header>
      <div className="space-y-3 border-b border-line px-5 py-4">
        <div className="flex gap-2"><button type="button" className="modal-button" onClick={() => navigate()} disabled={loading} title="Pasta pessoal do WSL"><Home size={14} />Início</button><button type="button" className="modal-button" onClick={() => { if (listing?.parentPath) navigate(listing.parentPath); }} disabled={loading || !listing?.parentPath} title="Subir um nível"><ArrowUp size={14} />Voltar uma pasta</button></div>
        <p className="break-all font-mono text-xs leading-5 text-muted" aria-live="polite">{loading ? 'Abrindo pasta…' : error ? path || 'Pasta pessoal' : listing?.path}</p>
        <input type="search" className="field pl-3" placeholder="Filtrar pastas nesta localização" aria-label="Filtrar pastas" value={filter} onChange={event => setFilter(event.target.value)} disabled={loading || Boolean(error)} />
      </div>
      <div className="min-h-40 flex-1 overflow-y-auto px-3 py-2" aria-busy={loading}>
        {loading ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted"><LoaderCircle size={17} className="animate-spin" />Carregando pastas…</p> : error ? <div role="alert" className="space-y-3 px-2 py-5 text-xs text-danger"><p>{error}</p><button type="button" className="modal-button" onClick={() => setAttempt(current => current + 1)}>Tentar novamente</button></div> : directories.length ? <ul>{directories.map(directory => <li key={directory.path}><button type="button" onClick={() => navigate(directory.path)} className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:bg-hover"><Folder size={17} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-all">{directory.name}</span><ChevronRight size={14} className="shrink-0 text-muted" /></button></li>)}</ul> : <p className="px-2 py-10 text-center text-xs text-muted">{filter ? 'Nenhuma pasta corresponde ao filtro.' : 'Esta pasta não contém subpastas.'}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-4"><button type="button" className="modal-button" onClick={onClose}>Cancelar</button><button type="button" disabled={loading || Boolean(error) || !listing} onClick={() => { if (listing) onSelect(listing.path); }} className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent hover:bg-accent-hover"><Check size={14} />Selecionar esta pasta</button></footer>
    </div>
  </dialog>;
}
