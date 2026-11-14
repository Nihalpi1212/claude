// Boot: resume a remembered session or show the lock screen.

import { html, render, useState } from '../vendor/preact.js';
import { App } from './app.js';
import { handleStoreChange } from './data.js';
import { resume } from './session.js';
import LockScreen from './views/lock.js';

function Root({ initial }) {
  const [session, setSession] = useState(initial);
  if (!session) return html`<${LockScreen} onUnlocked=${setSession} onChange=${handleStoreChange} />`;
  return html`<${App} session=${session} />`;
}

async function boot() {
  applyThemePreference();
  const root = document.getElementById('root');
  let session = null;
  try {
    session = await resume({ onChange: handleStoreChange });
  } catch {
    session = null;
  }
  root.textContent = '';
  render(html`<${Root} initial=${session} />`, root);
}

function applyThemePreference() {
  try {
    const t = localStorage.getItem('postpilot.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch {
    /* ignore */
  }
}

boot();
