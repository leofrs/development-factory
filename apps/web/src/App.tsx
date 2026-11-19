import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronRight, FolderGit2, GitBranch, GitPullRequest, Layers3, LockKeyhole, ScanLine, Terminal } from 'lucide-react';
import { ClientMessageSchema, type TargetType } from '@development-factory/shared';
import { TerminalModal } from './components/TerminalModal';
import { readSavedTheme, themeStorageKey } from './theme';
import { DirectoryPicker } from './components/DirectoryPicker';
import { HistoryModal } from './components/HistoryModal';
import { FloatingDock, type AppView } from './components/FloatingDock';
import { FactoryPage } from './components/FactoryPage';
import { FactoryTaskModal } from './components/FactoryTaskModal';
import { MarkdownViewerModal } from './components/MarkdownViewerModal';
import { useBackgroundOperations } from './hooks/useBackgroundOperations';

const storageKey = 'development-factory.repoPath';
const steps = [
  { title: 'Contexto antes de código', text: 'A tarefa original e seus critérios de aceite, via MCP.' },
  { title: 'Causa raiz e fluxo completo', text: 'O diff, seus consumidores e tudo que existe ao redor.' },
  { title: 'Um parecer acionável', text: 'Edge cases, severidade e recomendações com evidências.' },
];

export default function App() {
  const [theme, setTheme] = useState(readSavedTheme);
  const toggleTheme = useCallback(() => setTheme(current => current === 'dark' ? 'light' : 'dark'), []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1117' : '#f6f8fa');
    try { localStorage.setItem(themeStorageKey, theme); } catch { /* O tema continua funcionando sem persistência. */ }
  }, [theme]);
  const [view, setView] = useState<AppView>('factory');
  const [targetType, setTargetType] = useState<TargetType>('pr');
  const [identifier, setIdentifier] = useState('');
  const [repoPath, setRepoPath] = useState(() => {
    try { return localStorage.getItem(storageKey) ?? localStorage.getItem('make-and-review.repoPath') ?? ''; } catch { return ''; }
  });
  const {
    sessions,
    activeTerminalSession,
    startReview,
    startFactory,
    minimizeTerminal,
  } = useBackgroundOperations();
  const [configuringFactoryTask, setConfiguringFactoryTask] = useState(false);
  const [savedPlanPath, setSavedPlanPath] = useState<string | null>(null);
  const [viewingMarkdownPath, setViewingMarkdownPath] = useState<string | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try { localStorage.setItem(storageKey, repoPath); setStorageError(false); }
    catch { setStorageError(true); }
  }, [repoPath]);
  const closeModal = useCallback(() => {
    minimizeTerminal();
    submitRef.current?.focus();
  }, [minimizeTerminal]);
  const handleSavedReport = useCallback((reportPath: string) => {
    setSavedPlanPath(reportPath);
  }, []);
  const latestFactoryPlanPath = useMemo(() => {
    const savedFactorySession = sessions.find(
      (item) => item.mode === 'factory' && item.historyState === 'saved' && Boolean(item.reportPath),
    );
    return savedFactorySession?.reportPath ?? null;
  }, [sessions]);
  const effectiveSavedPlanPath = latestFactoryPlanPath ?? savedPlanPath;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoPath) { setError('Selecione a pasta do repositório no WSL.'); return; }
    const parsed = ClientMessageSchema.safeParse({ type: 'start_review', targetType, identifier, repoPath, cols: 80, rows: 24 });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Verifique os campos.'); return; }
    if (parsed.data.type !== 'start_review') return;
    setError('');
    startReview({
      targetType: parsed.data.targetType,
      identifier: parsed.data.identifier,
      repoPath: parsed.data.repoPath,
    });
  }

  return (
    <div className="min-h-screen bg-page text-primary">
      {view === 'factory' ? (
        <FactoryPage
          repoPath={repoPath}
          savedPlanPath={effectiveSavedPlanPath}
          onPickDirectory={() => setPickingDirectory(true)}
          onOpenInitialNode={() => setConfiguringFactoryTask(true)}
          onViewPlan={path => setViewingMarkdownPath(path)}
        />
      ) : (
        <main className="mx-auto max-w-6xl px-6 pb-28 pt-12 sm:px-10 sm:pt-20">
        <div className="mb-10 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent"><ScanLine size={14} /> Seu código. Todo o contexto.</div>
        <div className="grid gap-12 lg:grid-cols-[1fr_1.08fr] lg:gap-16">
          <section className="lg:pt-3">
            <h1 className="max-w-lg text-4xl font-semibold leading-[1.12] tracking-[-0.045em] sm:text-[54px]">Um review que olha<br />além do <span className="text-accent">diff.</span></h1>
            <p className="mt-6 max-w-sm text-[15px] leading-7 text-muted">Conecte uma PR ou branch ao Claude Code e investigue o que realmente importa: o problema, a solução e o que ficou pelo caminho.</p>
            <div className="mt-10 space-y-7">
              {steps.map((step, index) => <div key={step.title} className="flex gap-4">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-line font-mono text-[11px] text-muted">0{index + 1}</span>
                <div><h2 className="text-sm font-medium text-primary">{step.title}</h2><p className="mt-1.5 max-w-xs text-xs leading-5 text-muted">{step.text}</p></div>
              </div>)}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20" aria-labelledby="review-heading">
            <div className="flex items-center gap-3 border-b border-line-subtle px-6 py-5 sm:px-8"><Terminal size={18} className="text-accent" /><h2 id="review-heading" className="text-sm font-medium">Novo code review</h2><span className="ml-auto font-mono text-[10px] text-muted">01 / INICIAR</span></div>
            <form onSubmit={submit} className="space-y-6 p-6 sm:p-8">
              <fieldset>
                <legend className="mb-3 text-xs font-medium text-secondary">O que vamos revisar?</legend>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-line-subtle bg-page p-1">
                  {([{ type: 'pr', label: 'Número da PR', icon: GitPullRequest }, { type: 'branch', label: 'Nome da Branch', icon: GitBranch }] as const).map(({ type, label, icon: Icon }) => <label key={type} className={`flex cursor-pointer items-center justify-center gap-2 rounded-md px-2 py-3 text-xs transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${targetType === type ? 'bg-selected text-accent ring-1 ring-accent/20' : 'text-muted hover:text-primary'}`}>
                    <input className="sr-only" type="radio" name="targetType" value={type} checked={targetType === type} onChange={() => { setTargetType(type); setIdentifier(''); setError(''); }} /><Icon size={15} />{label}
                  </label>)}
                </div>
              </fieldset>
              <div>
                <label htmlFor="identifier" className="mb-2.5 block text-xs font-medium text-secondary">{targetType === 'pr' ? 'Número da pull request' : 'Nome da branch'}</label>
                <div className="relative"><span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center font-mono text-sm text-muted">{targetType === 'pr' ? '#' : <GitBranch size={15} />}</span><input id="identifier" className="field pl-10" value={identifier} onChange={event => setIdentifier(event.target.value)} placeholder={targetType === 'pr' ? '142' : 'feat/minha-feature'} inputMode={targetType === 'pr' ? 'numeric' : 'text'} required maxLength={500} autoComplete="off" spellCheck={false} /></div>
              </div>
              <div>
                <label htmlFor="repoPath" className="mb-2.5 block text-xs font-medium text-secondary">Repositório no WSL</label>
                <button id="repoPath" type="button" onClick={() => setPickingDirectory(true)} className="field flex items-center gap-3 px-3 text-left" aria-describedby="path-help" aria-haspopup="dialog"><FolderGit2 size={16} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-all">{repoPath || 'Selecione a pasta do repositório'}</span><span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span></button>
                <p id="path-help" className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted"><Check size={12} />{storageError ? 'Armazenamento indisponível; o caminho vale para esta página.' : 'Caminho salvo automaticamente neste navegador.'}</p>
                <p className="mt-2 text-[11px] leading-5 text-muted">Parecer e registro da sessão salvos em <span className="font-mono">.code-reviews/</span> dentro da pasta selecionada.</p>
              </div>
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}
              <button ref={submitRef} type="submit" className="flex w-full items-center justify-center gap-3 rounded-lg bg-accent py-3.5 text-sm font-semibold text-on-accent transition hover:bg-accent-hover active:scale-[0.99]">Iniciar code review <ArrowRight size={17} /></button>
              <p className="flex items-center justify-center gap-2 text-center text-[11px] text-muted"><LockKeyhole size={12} />Executado no seu WSL, com suas configurações e MCPs.</p>
            </form>
          </section>
        </div>

        <div className="mt-14 flex flex-wrap items-center justify-between gap-5 border-t border-line-subtle pt-6 text-[11px] text-muted">
          <span className="flex items-center gap-2"><Layers3 size={14} /> Claude Code · Agente default · MCPs locais</span>
          <span className="flex items-center gap-2 font-mono">xterm.js <ChevronRight size={12} /> WebSocket <ChevronRight size={12} /> PTY real</span>
        </div>
        </main>
      )}

      <FloatingDock
        activeView={view}
        onSelectView={setView}
        onOpenHistory={() => setViewingHistory(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {configuringFactoryTask && (
        <FactoryTaskModal
          repoPath={repoPath}
          onPickDirectory={() => setPickingDirectory(true)}
          onClose={() => setConfiguringFactoryTask(false)}
          onStart={factoryRequest => {
            setConfiguringFactoryTask(false);
            startFactory(factoryRequest);
          }}
        />
      )}
      {activeTerminalSession && 'request' in activeTerminalSession && (
        <TerminalModal
          session={activeTerminalSession}
          onClose={closeModal}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSavedReport={activeTerminalSession.mode === 'factory' ? handleSavedReport : undefined}
          onViewMarkdown={path => setViewingMarkdownPath(path)}
        />
      )}
      {viewingMarkdownPath && (
        <MarkdownViewerModal
          filePath={viewingMarkdownPath}
          onClose={() => setViewingMarkdownPath(null)}
        />
      )}
      {pickingDirectory && <DirectoryPicker initialPath={repoPath} onClose={() => setPickingDirectory(false)} onSelect={path => { setRepoPath(path); setError(''); setPickingDirectory(false); }} />}
      {viewingHistory && <HistoryModal initialPath={repoPath} onClose={() => setViewingHistory(false)} />}
    </div>
  );
}
