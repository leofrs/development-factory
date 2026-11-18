import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, FolderGit2, Hash, Link2, LockKeyhole, Type, X } from 'lucide-react';
import {
  ClientMessageSchema,
  type FactoryInputType,
  type FactoryRequest,
} from '@development-factory/shared';

interface FactoryTaskModalProps {
  repoPath: string;
  onPickDirectory: () => void;
  onClose: () => void;
  onStart: (request: FactoryRequest) => void;
}

const inputOptions: ReadonlyArray<{
  type: FactoryInputType;
  label: string;
  fieldLabel: string;
  placeholder: string;
  icon: typeof Link2;
}> = [
  {
    type: 'jira_url',
    label: 'URL do JIRA',
    fieldLabel: 'URL da tarefa no JIRA',
    placeholder: 'https://empresa.atlassian.net/browse/PROD-1234',
    icon: Link2,
  },
  {
    type: 'jira_key',
    label: 'Chave da tarefa',
    fieldLabel: 'Chave da tarefa no JIRA',
    placeholder: 'PROD-1234',
    icon: Hash,
  },
  {
    type: 'title',
    label: 'Título da tarefa',
    fieldLabel: 'Título da tarefa',
    placeholder: 'Ex.: Implementar fluxo de recuperação de senha',
    icon: Type,
  },
];

export function FactoryTaskModal({
  repoPath,
  onPickDirectory,
  onClose,
  onStart,
}: FactoryTaskModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [inputType, setInputType] = useState<FactoryInputType>('jira_key');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

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

  const currentOption = inputOptions.find(option => option.type === inputType) ?? inputOptions[0]!;
  const CurrentIcon = currentOption.icon;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoPath) {
      setError('Selecione a pasta do repositório no WSL.');
      return;
    }
    const parsed = ClientMessageSchema.safeParse({
      type: 'start_factory',
      inputType,
      value,
      repoPath,
      cols: 80,
      rows: 24,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Verifique os campos informados.');
      return;
    }
    if (parsed.data.type !== 'start_factory') {
      return;
    }
    setError('');
    onStart({
      inputType: parsed.data.inputType,
      value: parsed.data.value,
      repoPath: parsed.data.repoPath,
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="factory-task-title"
      className="terminal-dialog m-auto w-[calc(100%-1rem)] max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-surface p-0 text-primary shadow-2xl sm:w-full"
    >
      <div className="flex items-center justify-between border-b border-line bg-elevated px-6 py-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
            01 / Triagem &amp; Contexto
          </span>
          <h2 id="factory-task-title" className="mt-1 text-base font-semibold">
            Iniciar planejamento da tarefa
          </h2>
        </div>
        <button
          type="button"
          className="modal-button"
          onClick={onClose}
          aria-label="Fechar modal"
        >
          <X size={14} />
          Fechar
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 p-6">
        <fieldset>
          <legend className="mb-2.5 text-xs font-medium text-secondary">
            Como você quer identificar a tarefa?
          </legend>
          <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-line-subtle bg-page p-1 sm:grid-cols-3">
            {inputOptions.map(({ type, label, icon: Icon }) => (
              <label
                key={type}
                className={`flex cursor-pointer items-center justify-center gap-2 rounded-md px-2.5 py-2.5 text-xs transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                  inputType === type
                    ? 'bg-selected text-accent ring-1 ring-accent/20'
                    : 'text-muted hover:text-primary'
                }`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="factoryInputType"
                  value={type}
                  checked={inputType === type}
                  onChange={() => {
                    setInputType(type);
                    setValue('');
                    setError('');
                  }}
                />
                <Icon size={14} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="factory-task-input" className="mb-2 block text-xs font-medium text-secondary">
            {currentOption.fieldLabel}
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
              <CurrentIcon size={15} />
            </span>
            <input
              id="factory-task-input"
              className="field pl-10"
              value={value}
              onChange={event => setValue(event.target.value)}
              placeholder={currentOption.placeholder}
              required
              maxLength={1000}
              autoComplete="off"
              spellCheck={inputType === 'title'}
            />
          </div>
        </div>

        <div>
          <label htmlFor="factory-repo-path" className="mb-2 block text-xs font-medium text-secondary">
            Repositório no WSL
          </label>
          <button
            id="factory-repo-path"
            type="button"
            onClick={onPickDirectory}
            className="field flex items-center gap-3 px-3 text-left"
            aria-haspopup="dialog"
          >
            <FolderGit2 size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 break-all">
              {repoPath || 'Selecione a pasta do repositório'}
            </span>
            <span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span>
          </button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="flex w-full items-center justify-center gap-3 rounded-lg bg-accent py-3.5 text-sm font-semibold text-on-accent transition hover:bg-accent-hover active:scale-[0.99]"
        >
          Executar agente no Claude Code
          <ArrowRight size={17} />
        </button>

        <p className="flex items-center justify-center gap-2 text-center text-[11px] text-muted">
          <LockKeyhole size={12} />
          Gera o plano estruturado em Markdown dentro de <span className="font-mono">.code-reviews/</span>.
        </p>
      </form>
    </dialog>
  );
}
