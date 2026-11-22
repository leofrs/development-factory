import { useEffect, useState } from 'react';
import type { BackgroundSessionSummary } from '@development-factory/shared';

function formatElapsedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const parts = hours > 0 ? [hours, minutes, seconds % 60] : [minutes, seconds % 60];
  return parts.map(part => String(part).padStart(2, '0')).join(':');
}

export function FactoryStageActivity({ session }: { session: BackgroundSessionSummary }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 1000));
  const activity = session.factoryActivity;
  const entries = [
    { label: 'Último arquivo lido', value: activity?.lastReadFile },
    { label: 'Último arquivo editado', value: activity?.lastEditedFile },
    { label: 'Último comando', value: activity?.lastCommand },
  ];

  return (
    <div className="space-y-2 rounded-lg border border-line-subtle bg-page/50 px-2.5 py-2 text-xs">
      <p className="flex flex-wrap justify-between gap-x-2 text-secondary">
        Tempo decorrido
        <time
          role="timer"
          aria-label="Tempo decorrido da etapa"
          dateTime={`PT${elapsed}S`}
          className="font-mono tabular-nums text-accent"
        >
          {formatElapsedTime(elapsed)}
        </time>
      </p>
      <div aria-live="polite">
        {activity ? (
          <dl className="space-y-1.5">
            {entries.map(({ label, value }) =>
              value ? (
                <div key={label}>
                  <dt className="text-muted">{label}</dt>
                  <dd className="wrap-anywhere font-mono text-[11px] text-primary">{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : (
          <p className="text-muted">Aguardando atividade…</p>
        )}
      </div>
    </div>
  );
}
