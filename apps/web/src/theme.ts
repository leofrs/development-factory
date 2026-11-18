import type { ITheme } from '@xterm/xterm';

export type Theme = 'dark' | 'light';
export const themeStorageKey = 'development-factory.theme';

export function readSavedTheme(): Theme {
  try { return (localStorage.getItem(themeStorageKey) ?? localStorage.getItem('make-and-review.theme')) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export const terminalThemes: Record<Theme, ITheme> = {
  dark: {
    background: '#0d1117', foreground: '#d1d9e0', cursor: '#6ee7b7', cursorAccent: '#0d1117',
    selectionBackground: '#29483e', black: '#151b23', red: '#f87171', green: '#6ee7b7',
    yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#67e8f9', white: '#d1d9e0',
    brightBlack: '#6e7681', brightRed: '#fca5a5', brightGreen: '#a7f3d0', brightYellow: '#fde047',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#24292f', cursor: '#047857', cursorAccent: '#ffffff',
    selectionBackground: '#cce8df', black: '#24292f', red: '#b42318', green: '#047857',
    yellow: '#856200', blue: '#175cd3', magenta: '#8036ac', cyan: '#0e6877', white: '#59636e',
    brightBlack: '#687482', brightRed: '#c02b21', brightGreen: '#067647', brightYellow: '#946600',
    brightBlue: '#1d4ed8', brightMagenta: '#9333b0', brightCyan: '#0e7490', brightWhite: '#24292f',
  },
};
