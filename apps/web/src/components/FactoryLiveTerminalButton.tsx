import { useState } from 'react';
import { Terminal } from 'lucide-react';

interface FactoryLiveTerminalButtonProps {
  title: string;
  onOpen: () => boolean;
  onOpened?: () => void;
}

export function FactoryLiveTerminalButton({ title, onOpen, onOpened }: FactoryLiveTerminalButtonProps) {
  const [unavailable, setUnavailable] = useState(false);

  return (
    <>
      <button
        type="button"
        className="modal-button border-accent/35 text-accent hover:bg-selected"
        aria-label={`Abrir terminal ao vivo · ${title}`}
        aria-haspopup="dialog"
        onClick={() => {
          const opened = onOpen();
          setUnavailable(!opened);
          if (opened) {
            onOpened?.();
          }
        }}
      >
        <Terminal size={13} aria-hidden="true" />
        Abrir terminal ao vivo
      </button>
      {unavailable && (
        <p role="alert" className="basis-full text-xs text-danger">
          A sessão da etapa não está mais disponível.
        </p>
      )}
    </>
  );
}
