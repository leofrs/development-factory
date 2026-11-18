import { Moon, Sun } from 'lucide-react';
import type { Theme } from '../theme';

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro';
  return <button type="button" className="modal-button shrink-0" onClick={onToggle} aria-label={label} title={label}>
    {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    <span className="hidden sm:inline">{theme === 'dark' ? 'Tema claro' : 'Tema escuro'}</span>
  </button>;
}
