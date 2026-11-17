// Read the theme choice before first paint so the index.html skeleton doesn't
// flash the wrong mode (main.tsx re-applies this on every load; kept in sync here).
// Mirrors lib/theme.ts: explicit choice, else the OS preference.
// A same-origin file, not an inline <script>, because the CSP is script-src 'self'
// (obj 901199). Loaded synchronously from <head>, so it still runs before paint.
(function () {
  var t = null;
  try { t = localStorage.getItem('ok-theme') || localStorage.getItem('cc.preview.theme.v2'); } catch (e) {}
  if (t !== 'dark' && t !== 'light') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'dark') {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', '#0d1117');
  }
})();
