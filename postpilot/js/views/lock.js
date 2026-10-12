// Lock screen: GitHub token + passphrase. Also creates the encrypted workspace on first use.

import { passphraseProblem, WrongPassphraseError } from '../../core/crypto.js';
import { html, useEffect, useState } from '../../vendor/preact.js';
import { APP_NAME, ENDPOINTS, guessRepoFromLocation } from '../config.js';
import { createWorkspace, inspectRepo, savedLogin, unlock } from '../session.js';
import { Icon } from '../ui/icons.js';
import { Button, Callout, Field, TextInput, Toggle } from '../ui/kit.js';

function tokenUrl(owner, repo) {
  const p = new URLSearchParams({
    name: `${APP_NAME} (${repo})`,
    description: 'Lets the Postpilot web app read and write its encrypted data branch and start the worker.',
    target_name: owner,
    expires_in: '366',
    contents: 'write',
    actions: 'write',
    secrets: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

export default function LockScreen({ onUnlocked, onChange }) {
  const saved = savedLogin();
  const guess = guessRepoFromLocation();
  const [owner, setOwner] = useState((saved && saved.owner) || (guess && guess.owner) || '');
  const [repo, setRepo] = useState((saved && saved.repo) || (guess && guess.repo) || '');
  const [token, setToken] = useState(ENDPOINTS.mock ? 'mock-token' : '');
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [remember, setRemember] = useState(!!(saved && saved.remember));
  const [step, setStep] = useState('token'); // token -> unlock | create
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = `${APP_NAME} · Locked`;
  }, []);

  async function checkToken(e) {
    e.preventDefault();
    setError('');
    if (!owner.trim() || !repo.trim() || !token.trim()) return setError('Fill in the account, repository and token.');
    setBusy(true);
    try {
      const res = await inspectRepo({ token: token.trim(), owner: owner.trim(), repo: repo.trim() });
      setInfo(res);
      setStep(res.keyring ? 'unlock' : 'create');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlock(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const s = await unlock({ token: token.trim(), owner: owner.trim(), repo: repo.trim(), passphrase, remember, keyring: info.keyring, login: info.login, onChange });
      onUnlocked(s);
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? 'That passphrase is not right. Check for typos and caps lock.' : err.message || String(err));
      setBusy(false);
    }
  }

  async function doCreate(e) {
    e.preventDefault();
    setError('');
    const weak = passphraseProblem(passphrase);
    if (weak) return setError(weak);
    if (passphrase !== passphrase2) return setError('The two passphrases do not match.');
    setBusy(true);
    try {
      const s = await createWorkspace({ token: token.trim(), owner: owner.trim(), repo: repo.trim(), passphrase, remember, login: info.login, onChange });
      location.hash = '#/onboarding';
      onUnlocked(s);
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  }

  return html`<div class="lock">
    <div class="lock-card">
      <div class="lock-brand">
        <span class="brand-mark" aria-hidden="true"><${Icon} name="instagram-outline" size=${24} /></span>
        <div>
          <h1 class="lock-title">${APP_NAME}</h1>
          <p class="muted">Your private Instagram planner, publisher and autopilot.</p>
        </div>
      </div>

      ${step === 'token' &&
      html`<form class="stack" onSubmit=${checkToken}>
        <div class="grid-2">
          <${Field} label="GitHub account">
            <${TextInput} id="lock-owner" value=${owner} onInput=${(e) => setOwner(e.currentTarget.value)} autocomplete="username" spellcheck=${false} />
          <//>
          <${Field} label="Repository">
            <${TextInput} id="lock-repo" value=${repo} onInput=${(e) => setRepo(e.currentTarget.value)} spellcheck=${false} />
          <//>
        </div>
        <${Field}
          label="GitHub access token"
          hint=${html`A fine-grained token for this repository with Contents, Actions and Secrets set to "Read and write".
            <a href=${tokenUrl(owner || 'me', repo || 'repo')} target="_blank" rel="noopener">Create one on GitHub <${Icon} name="external" size=${12} /></a>`}
        >
          <${TextInput} id="lock-token" type="password" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} autocomplete="off" spellcheck=${false} placeholder="github_pat_…" />
        <//>
        ${error && html`<${Callout} tone="danger">${error}<//>`}
        <${Button} type="submit" variant="primary" loading=${busy}>Continue<//>
      </form>`}

      ${step === 'unlock' &&
      html`<form class="stack" onSubmit=${doUnlock}>
        <p>Signed in to GitHub as <strong>${info.login}</strong>. Enter your passphrase to decrypt your workspace.</p>
        <${Field} label="Passphrase">
          <${TextInput} id="lock-passphrase" type="password" value=${passphrase} onInput=${(e) => setPassphrase(e.currentTarget.value)} autocomplete="current-password" autofocus />
        <//>
        <${Toggle} checked=${remember} onChange=${setRemember} label="Remember this device" />
        <p class="hint">Only turn this on for a device you alone use. Anyone with this browser profile could open ${APP_NAME}.</p>
        ${error && html`<${Callout} tone="danger">${error}<//>`}
        <div class="row">
          <${Button} type="submit" variant="primary" icon="unlock" loading=${busy}>Unlock<//>
          <${Button} type="button" variant="ghost" onClick=${() => (setStep('token'), setError(''))}>Use a different token<//>
        </div>
      </form>`}

      ${step === 'create' &&
      html`<form class="stack" onSubmit=${doCreate}>
        <p>Signed in as <strong>${info.login}</strong>. ${APP_NAME} is not set up in <span class="mono">${owner}/${repo}</span> yet.
        Choose a passphrase. It encrypts everything ${APP_NAME} stores in this public repository.</p>
        <${Field} label="New passphrase" hint="At least 12 characters. A short sentence of three or four words is easy to remember and hard to guess. The encrypted key file is public, so a weak passphrase can be guessed offline.">
          <${TextInput} id="lock-new-passphrase" type="password" value=${passphrase} onInput=${(e) => setPassphrase(e.currentTarget.value)} autocomplete="new-password" />
        <//>
        <${Field} label="Repeat passphrase">
          <${TextInput} id="lock-new-passphrase-2" type="password" value=${passphrase2} onInput=${(e) => setPassphrase2(e.currentTarget.value)} autocomplete="new-password" />
        <//>
        <${Callout} tone="warning" title="Write it down">There is no reset. If you forget the passphrase, your scheduled posts and settings cannot be decrypted.<//>
        <${Toggle} checked=${remember} onChange=${setRemember} label="Remember this device" />
        ${error && html`<${Callout} tone="danger">${error}<//>`}
        <div class="row">
          <${Button} type="submit" variant="primary" icon="lock" loading=${busy}>Create encrypted workspace<//>
          <${Button} type="button" variant="ghost" onClick=${() => (setStep('token'), setError(''))}>Back<//>
        </div>
      </form>`}
    </div>
    <p class="lock-foot muted">Data is encrypted in your browser with AES-256 before it is saved to GitHub.</p>
  </div>`;
}
