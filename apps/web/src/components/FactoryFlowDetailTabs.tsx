import type { KeyboardEvent } from 'react';

const tabs = [
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'diff', label: 'Diff Real' },
  { id: 'iterations', label: 'Histórico Comparativo de Iterações' },
] as const;

export type FactoryFlowDetailTab = (typeof tabs)[number]['id'];

export function FactoryFlowDetailTabs({
  id,
  selected,
  onSelect,
}: {
  id: string;
  selected: FactoryFlowDetailTab;
  onSelect: (tab: FactoryFlowDetailTab) => void;
}) {
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index + tabs.length - 1) % tabs.length;
        break;
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    const tab = tabs[nextIndex];
    if (tab) {
      event.preventDefault();
      onSelect(tab.id);
      document.getElementById(`${id}-${tab.id}-tab`)?.focus();
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Detalhes do fluxo"
      className="flex shrink-0 flex-wrap gap-1 border-b border-line bg-surface px-5 py-2 sm:px-6"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`${id}-${tab.id}-tab`}
          type="button"
          role="tab"
          aria-selected={tab.id === selected}
          aria-controls={`${id}-${tab.id}-panel`}
          tabIndex={tab.id === selected ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={event => handleKey(event, index)}
          className="rounded-md px-3 py-2 text-xs font-medium text-secondary hover:bg-hover aria-selected:bg-selected aria-selected:text-accent"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
