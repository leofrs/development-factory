import { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Compass,
  FileText,
  GitPullRequest,
  Terminal,
  X,
} from 'lucide-react';
import type { AppNotification } from '../hooks/useBackgroundOperations';
import {
  canOpenTerminalForFactoryStage,
  getFactoryStageLabel,
  getFactoryStageStep,
} from '../utils/factory-flow-status';

interface NotificationToastCenterProps {
  notifications: AppNotification[];
  onOpenTerminal: (sessionId: string) => void;
  onOpenFlowTerminal?: (flowId: string) => void;
  onViewReport: (reportPath: string) => void;
  onDismiss: (id: string) => void;
  onClearAll?: () => void;
}

const RELATIVE_TIME_REFRESH_MS = 30_000;

function formatRelativeTime(isoTimestamp: string, nowMs: number): string {
  const parsedMs = Date.parse(isoTimestamp);
  if (Number.isNaN(parsedMs)) {
    return 'agora';
  }

  const diffSeconds = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (diffSeconds < 60) {
    return 'agora mesmo';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `há ${diffMinutes} min`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `há ${diffHours} h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `há ${diffDays} d`;
}

function getSeverityPresentation(severity: AppNotification['severity']) {
  if (severity === 'error') {
    return {
      Icon: AlertCircle,
      iconClass: 'text-danger',
      borderClass: 'border-danger/35',
      messageClass: 'text-danger',
    };
  }

  if (severity === 'warning') {
    return {
      Icon: AlertTriangle,
      iconClass: 'text-warning',
      borderClass: 'border-warning/35',
      messageClass: 'text-warning',
    };
  }

  return {
    Icon: CheckCircle2,
    iconClass: 'text-accent',
    borderClass: 'border-accent/35',
    messageClass: 'text-accent',
  };
}

export function NotificationToastCenter({
  notifications,
  onOpenTerminal,
  onOpenFlowTerminal,
  onViewReport,
  onDismiss,
  onClearAll,
}: NotificationToastCenterProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (notifications.length === 0) {
      return;
    }

    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, RELATIVE_TIME_REFRESH_MS);

    return () => {
      clearInterval(timer);
    };
  }, [notifications.length]);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <aside
      aria-label="Notificações de operações em background"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(calc(100vw-2rem),24rem)] flex-col gap-2.5 sm:right-6 sm:top-6"
    >
      {notifications.length > 1 && onClearAll && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClearAll}
            className="pointer-events-auto rounded-lg border border-line-strong bg-surface/95 px-2.5 py-1 text-[11px] font-medium text-muted shadow-lg backdrop-blur-md transition hover:bg-hover hover:text-primary"
          >
            Limpar notificações ({notifications.length})
          </button>
        </div>
      )}

      {notifications.map(notification => {
        const isFactory = notification.mode === 'factory';
        const isError = notification.severity === 'error';
        const { Icon, iconClass, borderClass, messageClass } = getSeverityPresentation(
          notification.severity,
        );
        const reportPath = notification.reportPath;

        return (
          <div
            key={notification.id}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? undefined : 'polite'}
            className={`pointer-events-auto rounded-2xl border ${borderClass} bg-surface/95 p-3.5 text-primary shadow-2xl shadow-black/30 backdrop-blur-md`}
          >
            <div className="flex items-start gap-2.5">
              <Icon size={16} className={`mt-0.5 shrink-0 ${iconClass}`} aria-hidden="true" />

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                        isFactory
                          ? 'border-accent/30 bg-selected text-accent'
                          : 'border-line bg-elevated text-secondary'
                      }`}
                    >
                      {isFactory ? <Compass size={10} /> : <GitPullRequest size={10} />}
                      {isFactory ? 'Factory' : 'Review'}
                    </span>
                    {isFactory && notification.stage && (
                      <span className="inline-flex items-center rounded-md border border-line bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                        {getFactoryStageStep(notification.stage)} ·{' '}
                        {getFactoryStageLabel(notification.stage)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <time
                      dateTime={notification.createdAt}
                      className="text-[10px] text-muted"
                    >
                      {formatRelativeTime(notification.createdAt, nowMs)}
                    </time>
                    <button
                      type="button"
                      onClick={() => onDismiss(notification.id)}
                      aria-label={`Fechar notificação de ${notification.title}`}
                      className="rounded-md p-1 text-muted transition hover:bg-hover hover:text-primary"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>

                <p
                  className="mt-1.5 truncate text-xs font-semibold text-primary"
                  title={notification.title}
                >
                  {notification.title}
                </p>
                <p className={`mt-0.5 text-[11px] font-medium ${messageClass}`}>
                  {notification.message}
                </p>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {reportPath && (
                    <button
                      type="button"
                      className="modal-button border-accent/35 px-2.5 py-1 text-[11px] text-accent hover:bg-selected"
                      onClick={() => {
                        onViewReport(reportPath);
                        onDismiss(notification.id);
                      }}
                    >
                      <FileText size={12} />
                      <span>
                        {isFactory
                          ? notification.stage && notification.stage !== 'triage'
                            ? 'Ver artefato'
                            : 'Ver plano'
                          : 'Ver parecer'}
                      </span>
                    </button>
                  )}

                  {(!isFactory ||
                    !notification.stage ||
                    canOpenTerminalForFactoryStage(notification.stage)) &&
                    (notification.sessionId || (notification.flowId && onOpenFlowTerminal)) && (
                    <button
                      type="button"
                      className="modal-button px-2.5 py-1 text-[11px]"
                      onClick={() => {
                        if (notification.sessionId) {
                          onOpenTerminal(notification.sessionId);
                        } else if (notification.flowId) {
                          onOpenFlowTerminal?.(notification.flowId);
                        }
                        onDismiss(notification.id);
                      }}
                    >
                      <Terminal size={12} />
                      <span>Abrir terminal</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="modal-button ml-auto px-2.5 py-1 text-[11px] text-muted hover:text-primary"
                    onClick={() => onDismiss(notification.id)}
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
