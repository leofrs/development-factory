import { useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, X } from 'lucide-react';
import { HistoryFileSchema, type HistoryFile } from '@development-factory/shared';
import { MarkdownContent } from './MarkdownContent';

const apiBaseUrl = 'http://127.0.0.1:3001';

function splitFilePath(fullPath: string): { directory: string; name: string } | null {
  const lastSlash = fullPath.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === fullPath.length - 1) {
    return null;
  }
  return {
    directory: fullPath.slice(0, lastSlash),
    name: fullPath.slice(lastSlash + 1),
  };
}

export function MarkdownViewerModal({
  filePath,
  title = 'Plano da tarefa',
  onClose,
}: {
  filePath: string;
  title?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [file, setFile] = useState<HistoryFile | null>(null);

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

  useEffect(() => {
    const parts = splitFilePath(filePath);
    if (!parts) {
      setError('Caminho do arquivo Markdown inválido.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');

    const params = new URLSearchParams({ path: parts.directory, name: parts.name });
    void fetch(`${apiBaseUrl}/api/history/file?${params.toString()}`, { signal: controller.signal })
      .then(async response => {
        const body = (await response.json()) as unknown;
        if (!response.ok) {
          const message =
            typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
              ? body.error
              : 'Não foi possível ler o arquivo Markdown.';
          throw new Error(message);
        }
        const parsed = HistoryFileSchema.safeParse(body);
        if (!parsed.success) {
          throw new Error('Resposta incompatível ao ler o arquivo Markdown.');
        }
        setFile(parsed.data);
      })
      .catch(err => {
        if (controller.signal.aborted) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Falha ao carregar o arquivo Markdown.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [filePath]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="markdown-viewer-title"
      className="history-dialog m-auto h-[85dvh] max-h-[100dvh] w-[calc(100%-1rem)] max-w-4xl overflow-hidden rounded-2xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-[calc(100%-3rem)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-elevated px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-page text-accent">
              <FileText size={16} />
            </span>
            <div className="min-w-0">
              <h2 id="markdown-viewer-title" className="truncate text-sm font-semibold">
                {title}
              </h2>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted" title={filePath}>
                {filePath}
              </p>
            </div>
          </div>
          <button type="button" className="modal-button" onClick={onClose} aria-label="Fechar visualização">
            <X size={14} />
            Fechar
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted" role="status">
              <LoaderCircle size={15} className="animate-spin text-accent" />
              Carregando documento Markdown...
            </div>
          )}
          {!loading && error && (
            <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-xs text-danger">
              {error}
            </p>
          )}
          {!loading && !error && file && <MarkdownContent content={file.content} />}
        </div>
      </div>
    </dialog>
  );
}
