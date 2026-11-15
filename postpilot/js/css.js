// Load a screen's stylesheet (css/views/<name>.css) once, on first import of the screen.

const loaded = new Set();

export function loadViewCss(name) {
  if (loaded.has(name) || typeof document === 'undefined') return;
  loaded.add(name);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL(`../css/views/${name}.css`, import.meta.url).href;
  document.head.appendChild(link);
}
