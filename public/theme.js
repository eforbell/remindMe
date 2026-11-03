'use strict';

// Light/dark theme: the saved choice, else the system's. Runs before first paint (loaded in <head>).
(function () {
  const KEY = 'rm_theme';
  const icons = {
    light: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  };

  function preferred() {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#FAF8F4' : '#141310');
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.innerHTML = icons[theme];
      btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    });
  }

  apply(preferred());
  window.addEventListener('DOMContentLoaded', () => {
    apply(preferred());
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => {
      const next = (document.documentElement.dataset.theme === 'light') ? 'dark' : 'light';
      localStorage.setItem(KEY, next);
      apply(next);
    }));
  });
}());
