import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// Theme state: in-memory + `?theme=`/`?accent=` URL params only (no
// localStorage — see DESIGN_SPEC §2). `index.html` applies the initial
// class before first paint to avoid a flash; this provider keeps React
// state in sync with that class and exposes toggles.

type Theme = 'dark' | 'light';
type Accent = 'default' | 'claude';

interface ThemeContextValue {
  theme: Theme;
  accent: Accent;
  toggleTheme: () => void;
  setAccent: (a: Accent) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function initialTheme(): Theme {
  const p = new URLSearchParams(window.location.search).get('theme');
  return p === 'light' ? 'light' : 'dark';
}

function initialAccent(): Accent {
  const p = new URLSearchParams(window.location.search).get('accent');
  return p === 'claude' ? 'claude' : 'default';
}

function applyClasses(theme: Theme, accent: Accent) {
  const root = document.documentElement;
  root.classList.toggle('theme-dark', theme === 'dark');
  root.classList.toggle('theme-light', theme === 'light');
  root.classList.toggle('accent-claude', accent === 'claude');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [accent, setAccentState] = useState<Accent>(initialAccent);

  useEffect(() => {
    applyClasses(theme, accent);
  }, [theme, accent]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const setAccent = useCallback((a: Accent) => {
    setAccentState(a);
  }, []);

  const value = useMemo(
    () => ({ theme, accent, toggleTheme, setAccent }),
    [theme, accent, toggleTheme, setAccent],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
