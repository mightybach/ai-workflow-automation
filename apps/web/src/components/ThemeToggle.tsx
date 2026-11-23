import { useEffect, useState } from 'react';
import { Icon } from './Icon';
const key = 'flowpilot.theme';
type Theme = 'light' | 'dark';
function savedTheme(): Theme | null {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : null; } catch { return null; }
}
function systemTheme(): Theme { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
export function initializeTheme() { document.documentElement.dataset.theme = savedTheme() ?? systemTheme(); }
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { const next = savedTheme() ?? systemTheme(); document.documentElement.dataset.theme = next; setTheme(next); };
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) update(); };
    media.addEventListener('change', update); window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', update); window.removeEventListener('storage', storage); };
  }, []);
  return <button type="button" className="theme-switch secondary" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={() => {
    const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); document.documentElement.dataset.theme = next;
    try { localStorage.setItem(key, next); } catch { /* Theme still works in memory when browser storage is unavailable. */ }
  }}><Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} /><span>{theme === 'light' ? 'Dark' : 'Light'} mode</span></button>;
}
