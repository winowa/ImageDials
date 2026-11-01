import React, { useEffect, useState } from 'react';


export default function App() {
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? 'dark',
  );

  useEffect(() => {
    const apply = (value) => {
      document.documentElement.dataset.theme = value;
      const scheme = value === 'light' ? 'only light' : 'dark';
      document.documentElement.style.colorScheme = scheme;
      document
        .querySelector('meta[name="color-scheme"]')
        ?.setAttribute('content', scheme);
    };
    apply(theme);
    try {
      localStorage.setItem('imagedials-theme', theme);
    } catch {
      /* Storage is optional. */
    }
    const onStorage = (event) => {
      if (event.key === 'imagedials-theme')
        setTheme(event.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [theme]);

  return (
    <>
      <header className="app-header">
        <h1>ImageDials</h1>
        <button
          className="theme-toggle"
          type="button"
          aria-label={
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
          }
          title={
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
          }
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            {theme === 'dark' ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
              </>
            ) : (
              <path d="M20 15a8.5 8.5 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z" />
            )}
          </svg>
        </button>
      </header>
      <main className="app-main" />
    </>
  );
}
