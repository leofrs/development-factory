import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronRight, Folder, FolderGit2, GitBranch, GitPullRequest, Layers3, LockKeyhole, ScanLine, Terminal } from 'lucide-react';
import { ClientMessageSchema, ReviewDestinationSchema } from '@development-factory/shared';
import type { FactoryFlowInputType, FactoryStageName, TargetType } from '@development-factory/shared';
import { TerminalModal } from './components/TerminalModal';
import { readSavedTheme, themeStorageKey } from './theme';
import { DirectoryPicker } from './components/DirectoryPicker';
import { HistoryModal } from './components/HistoryModal';
import { FloatingDock, type AppView } from './components/FloatingDock';
import { FactoryPage } from './components/FactoryPage.js';
import { getRunningFactorySession } from './utils/factory-flow-status.js';
import { FactoryFlowRoadmapModal } from './components/FactoryFlowRoadmapModal';
import { FactoryTaskModal } from './components/FactoryTaskModal';
import { MarkdownViewerModal } from './components/MarkdownViewerModal';
import { NotificationToastCenter } from './components/NotificationToastCenter';
import { SeverityMatrixModal } from './components/SeverityMatrixModal';
import { useBackgroundOperations } from './hooks/useBackgroundOperations';
import { useFactoryMetrics } from './hooks/useFactoryMetrics.js';
import { useFactoryPreflight } from './hooks/useFactoryPreflight.js';

const storageKey = 'development-factory.repoPath';
const reportDirectoryKey = 'development-factory.reportDirectory';
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
  const [reportDirectory, setReportDirectory] = useState(() => {
    try {
      return localStorage.getItem(reportDirectoryKey) ?? '';
    } catch {
      return '';
    }
  });
  const [defaultReportDirectory, setDefaultReportDirectory] = useState('');
  const {
    sessions,
    sessionsById,
    factoryFlows,
    activeTerminalSession,
    notifications,
    loadingSessions,
    sessionsError,
    loadingFactoryFlows,
    factoryFlowsError,
    startReview,
    createFlow,
    advanceFlowStage,
    rerunFlowStage,
    returnFlowStage,
    saveReviewTriage,
    savePrReview,
    publishPr,
    retryPrJiraSync,
    cancelFlow,
    openTerminal,
    minimizeTerminal,
    bindActiveSessionId,
    stopSession,
    dismissNotification,
    clearAllNotifications,
  } = useBackgroundOperations();
  const [configuringFactoryTask, setConfiguringFactoryTask] = useState(false);
  const [factoryInputType, setFactoryInputType] = useState<FactoryFlowInputType>('jira_key');
  const repositoryPreflight = useFactoryPreflight(view === 'factory' ? repoPath : '', 'title');
  const taskPreflight = useFactoryPreflight(configuringFactoryTask ? repoPath : '', factoryInputType);
  const metricsRefreshKey = useMemo(
    () =>
      factoryFlows
        .map(
          flow =>
            `${flow.id}:${flow.state}:${flow.currentStage}:${flow.iteration}:${flow.updatedAt}:${flow.prPublication?.status ?? ''}`,
        )
        .join('|'),
    [factoryFlows],
  );
  const factoryMetrics = useFactoryMetrics({
    enabled: view === 'factory',
    refreshKey: metricsRefreshKey,
  });
  const [roadmapFlowId, setRoadmapFlowId] = useState<string | null>(null);
  const [viewingMarkdownPath, setViewingMarkdownPath] = useState<string | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState<'repository' | 'report' | null>(null);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [viewingSeverityMatrix, setViewingSeverityMatrix] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try { localStorage.setItem(storageKey, repoPath); setStorageError(false); }
    catch { setStorageError(true); }
  }, [repoPath]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('http://127.0.0.1:3001/api/review-destination', { signal: controller.signal })
      .then(async response => {
        if (response.ok) {
          const body: unknown = await response.json();
          const destination = ReviewDestinationSchema.parse(body);
          if (!controller.signal.aborted) {
            setDefaultReportDirectory(destination.path);
          }
        }
      })
      .catch(() => {
        // O backend aplica o padrão mesmo quando o caminho não pôde ser exibido.
      });
    return () => controller.abort();
  }, []);

  function selectDirectory(path: string) {
    if (pickingDirectory === 'report') {
      setReportDirectory(path);
      try {
        localStorage.setItem(reportDirectoryKey, path);
      } catch {
        // A pasta vale para esta página mesmo sem armazenamento no navegador.
      }
    } else {
      setRepoPath(path);
    }
    setError('');
    setPickingDirectory(null);
  }
  const closeModal = useCallback(() => {
    minimizeTerminal();
    submitRef.current?.focus();
  }, [minimizeTerminal]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoPath) { setError('Selecione a pasta do repositório no WSL.'); return; }
    const parsed = ClientMessageSchema.safeParse({
      type: 'start_review', targetType, identifier, repoPath,
      reportDirectory: reportDirectory || undefined, cols: 80, rows: 24,
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Verifique os campos.'); return; }
    if (parsed.data.type !== 'start_review') return;
    setError('');
    startReview({
      targetType: parsed.data.targetType,
      identifier: parsed.data.identifier,
      repoPath: parsed.data.repoPath,
      reportDirectory: parsed.data.reportDirectory,
    });
  }

  async function rerunStage(flowId: string, stage: FactoryStageName, approvedNotes?: string) {
    await rerunFlowStage(flowId, {
      stage,
      cols: 120,
      rows: 36,
      ...(approvedNotes !== undefined ? { approvedNotes } : {}),
    });
  }

  const roadmapFlow = roadmapFlowId
    ? (factoryFlows.find(item => item.id === roadmapFlowId) ?? null)
    : null;
  const notificationCenter = (
    <NotificationToastCenter
      notifications={notifications}
      onOpenTerminal={openTerminal}
      onViewReport={setViewingMarkdownPath}
      onDismiss={dismissNotification}
      onClearAll={clearAllNotifications}
    />
  );

  return (
    <div className="min-h-screen bg-page text-primary">
      {view === 'factory' ? (
        <FactoryPage
          repoPath={repoPath}
          preflight={repositoryPreflight}
          factoryFlows={factoryFlows}
          sessionsById={sessionsById}
          loadingFactoryFlows={loadingFactoryFlows}
          factoryFlowsError={factoryFlowsError}
          metrics={factoryMetrics}
          onPickDirectory={() => setPickingDirectory('repository')}
          onOpenNewFlow={() => {
            setFactoryInputType('jira_key');
            setConfiguringFactoryTask(true);
          }}
          onOpenFlowRoadmap={setRoadmapFlowId}
          onCancelFlow={cancelFlow}
          onRerunFlowStage={rerunStage}
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
                <button id="repoPath" type="button" onClick={() => setPickingDirectory('repository')} className="field flex items-center gap-3 px-3 text-left" aria-describedby="path-help" aria-haspopup="dialog"><FolderGit2 size={16} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 break-all">{repoPath || 'Selecione a pasta do repositório'}</span><span className="shrink-0 text-accent">{repoPath ? 'Alterar' : 'Selecionar'}</span></button>
                <p id="path-help" className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted"><Check size={12} />{storageError ? 'Armazenamento indisponível; o caminho vale para esta página.' : 'Caminho salvo automaticamente neste navegador.'}</p>
              </div>
              <div>
                <label htmlFor="report-directory" className="mb-2.5 block text-xs font-medium text-secondary">
                  Salvar code review em
                </label>
                <button
                  id="report-directory"
                  type="button"
                  onClick={() => setPickingDirectory('report')}
                  className="field flex items-center gap-3 px-3 text-left"
                  aria-describedby="report-directory-help"
                  aria-haspopup="dialog"
                >
                  <Folder size={16} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 break-all">{reportDirectory || defaultReportDirectory || 'Pasta padrão do aplicativo'}</span>
                  <span className="shrink-0 text-accent">Alterar</span>
                </button>
                <p id="report-directory-help" className="mt-2 text-[11px] leading-5 text-muted">Escolha uma pasta fora do repositório e do Development Factory.</p>
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

      {!roadmapFlow && notificationCenter}

      <FloatingDock
        activeView={view}
        onSelectView={setView}
        onOpenHistory={() => setViewingHistory(true)}
        onOpenSeverityMatrix={() => setViewingSeverityMatrix(true)}
        sessions={sessions}
        factoryFlows={factoryFlows}
        activeSessionId={activeTerminalSession?.sessionId}
        loadingSessions={loadingSessions}
        sessionsError={sessionsError}
        loadingFactoryFlows={loadingFactoryFlows}
        factoryFlowsError={factoryFlowsError}
        onOpenTerminal={openTerminal}
        onOpenFlowRoadmap={setRoadmapFlowId}
        onViewReport={path => setViewingMarkdownPath(path)}
        onStopSession={stopSession}
        onCancelFlow={cancelFlow}
        onRerunFlowStage={rerunStage}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {configuringFactoryTask && (
        <FactoryTaskModal
          repoPath={repoPath}
          inputType={factoryInputType}
          preflight={taskPreflight}
          onInputTypeChange={setFactoryInputType}
          onPickDirectory={() => setPickingDirectory('repository')}
          onClose={() => setConfiguringFactoryTask(false)}
          onCreateFlow={async task => {
            await createFlow({
              task,
              startSession: true,
              cols: 120,
              rows: 36,
            });
            setConfiguringFactoryTask(false);
          }}
        />
      )}
      {activeTerminalSession && (
        <TerminalModal
          session={activeTerminalSession}
          sessionSummary={
            activeTerminalSession.sessionId
              ? sessionsById.get(activeTerminalSession.sessionId)
              : undefined
          }
          onMinimize={closeModal}
          onBindSessionId={bindActiveSessionId}
          theme={theme}
          onToggleTheme={toggleTheme}
          onViewMarkdown={path => setViewingMarkdownPath(path)}
        />
      )}
      {viewingMarkdownPath && (
        <MarkdownViewerModal
          filePath={viewingMarkdownPath}
          onClose={() => setViewingMarkdownPath(null)}
        />
      )}
      {pickingDirectory && (
        <DirectoryPicker
          initialPath={pickingDirectory === 'report' ? reportDirectory : repoPath}
          purpose={pickingDirectory}
          onClose={() => setPickingDirectory(null)}
          onSelect={selectDirectory}
        />
      )}
      {roadmapFlow && (
        <FactoryFlowRoadmapModal
          flow={roadmapFlow}
          runningSession={getRunningFactorySession(roadmapFlow, sessionsById)}
          notificationCenter={notificationCenter}
          onClose={() => setRoadmapFlowId(null)}
          onAdvanceFlowStage={async (flowId, options) => {
            await advanceFlowStage(flowId, {
              startSession: true,
              cols: 120,
              rows: 36,
              ...(options?.approvedNotes !== undefined
                ? { approvedNotes: options.approvedNotes }
                : {}),
              ...(options?.planningApproval !== undefined
                ? { planningApproval: options.planningApproval }
                : {}),
            });
          }}
          onRerunFlowStage={rerunStage}
          onReturnFlowStage={async (flowId, targetStage, approvedNotes) => {
            await returnFlowStage(flowId, {
              targetStage,
              startSession: true,
              cols: 120,
              rows: 36,
              approvedNotes,
            });
          }}
          onSaveReviewTriage={saveReviewTriage}
          onSavePrReview={savePrReview}
          onPublishPr={publishPr}
          onRetryPrJiraSync={retryPrJiraSync}
          onCancelFlow={async flowId => {
            await cancelFlow(flowId);
          }}
          onViewMarkdown={path => setViewingMarkdownPath(path)}
        />
      )}
      {viewingHistory && (
        <HistoryModal
          initialPath={repoPath}
          factoryFlows={factoryFlows}
          onClose={() => setViewingHistory(false)}
        />
      )}
      {viewingSeverityMatrix && (
        <SeverityMatrixModal onClose={() => setViewingSeverityMatrix(false)} />
      )}
    </div>
  );
}
