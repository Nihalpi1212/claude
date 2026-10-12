// Connect an Instagram professional account: pick the login type, follow the numbered steps,
// paste a token, check the account preview, then hand the connection to the caller to save.
//
//   <ConnectInstagram onConnected=${async (connection) => ...} initialMode="instagram" />
//
// `connection` is the IgConnection shape from core/model.js (plus followersCount and status).
// Also exports small helpers shared by Settings and Onboarding: ExtLink, CopyButton.

import { formatNumber } from '../../core/analytics.js';
import { connectInstagram, createIg, IgError } from '../../core/ig.js';
import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { ENDPOINTS } from '../config.js';
import { loadViewCss } from '../css.js';
import { Icon } from './icons.js';
import { Avatar, Badge, Button, Callout, Field, Select, TextInput, cx } from './kit.js';

loadViewCss('onboarding');

/** Link that opens in a new tab and says so to screen readers. */
export function ExtLink({ href, children, class: cls }) {
  return html`<a class=${cx('ext-link', cls)} href=${href} target="_blank" rel="noopener noreferrer"
    >${children}<${Icon} name="external" size=${12} /><span class="sr-only"> (opens in a new tab)</span></a>`;
}

/** Copy `text` to the clipboard, with a short "Copied" confirmation. */
export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary', class: cls, ...rest }) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    const ok = await copyText(text);
    if (!ok) return;
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1600);
  }
  return html`<${Button} size=${size} variant=${variant} icon=${done ? 'check' : 'copy'} class=${cls} onClick=${copy} ...${rest}>${done ? 'Copied' : label}<//>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / denied permission: fall back to a hidden textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const FB_PERMISSIONS = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

const MODES = [
  {
    value: 'instagram',
    title: 'Instagram Login',
    badge: 'Recommended',
    body: 'No Facebook Page needed. Publishing, comments, messages and insights.',
  },
  {
    value: 'facebook',
    title: 'Facebook Login',
    body: 'Needs a Facebook Page linked to your Instagram account. Adds competitor tracking, hashtag research and deleting posts.',
  },
];

const ACCOUNT_TYPES = { BUSINESS: 'Business account', MEDIA_CREATOR: 'Creator account', CREATOR: 'Creator account', PERSONAL: 'Personal account' };

/** Strip what people often paste around a token: quotes, "Bearer", line breaks, a whole URL. */
export function cleanToken(raw) {
  let t = String(raw || '').trim();
  const m = t.match(/access_token=([^&\s#]+)/);
  if (m) {
    try {
      t = decodeURIComponent(m[1]);
    } catch {
      t = m[1];
    }
  }
  t = t.replace(/^bearer\s+/i, '').replace(/^["'`]+|["'`]+$/g, '');
  return t.replace(/\s+/g, '');
}

function precheck(token, mode) {
  if (!token) return { title: 'Paste your access token first', body: 'Follow the steps above, copy the token and paste it into the field.' };
  if (mode === 'instagram' && /^EAA/.test(token)) {
    return {
      title: 'This is a Facebook token',
      body: 'Tokens that start with EAA come from Facebook Login. Choose "Facebook Login" above, or generate the token under "API setup with Instagram business login" (it starts with IG).',
    };
  }
  if (mode === 'facebook' && /^IG/.test(token)) {
    return {
      title: 'This is an Instagram Login token',
      body: 'Tokens that start with IG come from "API setup with Instagram business login". Choose "Instagram Login" above to use it.',
    };
  }
  return null;
}

/** Turn a connect failure into {title, body} that says exactly what to fix. */
export function explainConnectError(err, mode) {
  const host = mode === 'facebook' ? 'graph.facebook.com' : 'graph.instagram.com';
  if (!(err instanceof IgError)) {
    return { title: 'Could not connect', body: `${(err && err.message) || err}. Check your internet connection and try again.` };
  }
  if (err.code === 'network') {
    return {
      title: 'Could not reach Instagram',
      body: `Check your internet connection. If an ad or content blocker is on, allow ${host} for this page, then try again.`,
    };
  }
  if (err.code === 'no_ig_account') return { title: 'No Instagram account found on your Facebook Pages', body: err.userMessage };
  if (err.code === 'no_token') return { title: 'Paste your access token first', body: err.userMessage };
  if (err.isAuth) {
    if (err.subcode === 463) return { title: 'This token has expired', body: 'Generate a new token (see the steps above) and paste it here.' };
    if (err.subcode === 460) return { title: 'This token stopped working', body: 'The account password was changed after the token was made. Generate a new token and paste it here.' };
    if (err.subcode === 458) {
      return { title: 'The app was removed from your account', body: 'Add your account to the app again in the Meta dashboard, generate a new token and paste it here.' };
    }
    return {
      title: 'Instagram did not accept this token',
      body:
        mode === 'facebook'
          ? 'Copy the whole token again from Graph API Explorer or the Access Token Debugger (it is long; make sure nothing is cut off) and check that "Facebook Login" is the right choice.'
          : 'Copy the whole token again from "Generate token" (it is long; make sure nothing is cut off) and check that "Instagram Login" is the right choice.',
    };
  }
  if (err.isPermission) {
    return {
      title: 'The token is missing permissions',
      body:
        mode === 'facebook'
          ? 'In Graph API Explorer add every permission from step 4, click "Generate Access Token" again, and select your Page and Instagram account when Facebook asks.'
          : 'Click "Generate token" again and allow every permission on the Instagram screen.',
    };
  }
  if (err.code === 100 && mode === 'instagram') {
    return {
      title: 'Instagram did not accept this token',
      body: 'Make sure it was generated under "API setup with Instagram business login" and that the account is a professional (Business or Creator) account.',
    };
  }
  if (err.isRateLimit) return { title: 'Instagram is limiting requests', body: 'Wait a few minutes, then try again.' };
  return { title: 'Instagram returned an error', body: err.userMessage };
}

function Steps({ mode }) {
  if (mode === 'facebook') {
    return html`<ol class="ci-steps">
      <li>
        Your Instagram account must be a professional account linked to a Facebook Page. In the Instagram app open your profile → <strong>Edit profile</strong> → <strong>Page</strong> and connect (or create) the Page.
      </li>
      <li>
        Open <${ExtLink} href="https://developers.facebook.com/apps">Meta for Developers<//>, log in and click <strong>Create app</strong>.
        Choose the use case <strong>Other</strong>, then the app type <strong>Business</strong>, give it a name (for example "Postpilot") and create it.
      </li>
      <li>
        Open the <${ExtLink} href="https://developers.facebook.com/tools/explorer/">Graph API Explorer<//>. Under <strong>Meta App</strong> pick your new
        app, and under <strong>User or Page</strong> choose <strong>User Token</strong>.
      </li>
      <li>
        Under <strong>Permissions</strong> add each of these:
        <span class="ci-perms">${FB_PERMISSIONS.map((p) => html`<code key=${p}>${p}</code>`)}</span>
        <${CopyButton} text=${FB_PERMISSIONS.join(',')} label="Copy all permissions" />
        <span class="muted"> Add <code>instagram_manage_contents</code> too if you want to delete posts from Postpilot.</span>
      </li>
      <li>
        Click <strong>Generate Access Token</strong>. In the Facebook window select your Page and its Instagram account, and allow everything.
      </li>
      <li>
        Make the token last: open the <${ExtLink} href="https://developers.facebook.com/tools/debug/accesstoken/">Access Token Debugger<//>, paste the
        token, click <strong>Debug</strong>, then <strong>Extend Access Token</strong> at the bottom and copy the new token.
      </li>
      <li>
        Paste it below and click <strong>Connect</strong>. Postpilot swaps it for your Page's token, which does not expire. Keep <strong>Require App Secret</strong> turned off (App settings → Advanced).
      </li>
    </ol>`;
  }
  return html`<ol class="ci-steps">
    <li>
      Your Instagram account must be a professional account. In the Instagram app open <strong>Settings</strong> → <strong>Account type and tools</strong> → <strong>Switch to professional account</strong> (Business or Creator) if it isn't one yet.
    </li>
    <li>
      Open <${ExtLink} href="https://developers.facebook.com/apps">Meta for Developers<//>, log in with Facebook and click <strong>Create app</strong>.
    </li>
    <li>
      Name the app (for example "Postpilot"). For the use case choose <strong>Manage messaging & content on Instagram</strong>. If you are asked for an
      app type instead, choose <strong>Business</strong> and add the <strong>Instagram</strong> product. Skip connecting a business portfolio and create the app.
    </li>
    <li>
      In the app dashboard open <strong>Use cases</strong> → <strong>Customize</strong> next to the Instagram use case → <strong>API setup with Instagram business login</strong>.
    </li>
    <li>
      Under <strong>1. Generate access tokens</strong> click <strong>Add account</strong> and log in to your Instagram account. If Meta asks for a tester
      invite: go to <strong>App roles</strong> → <strong>Roles</strong> → <strong>Add People</strong> → <strong>Instagram Tester</strong>, enter your username,
      then accept the invite at <${ExtLink} href="https://www.instagram.com/accounts/manage_access/">instagram.com → Apps and websites → Tester invites<//>.
    </li>
    <li>
      Click <strong>Generate token</strong> next to your account, allow every permission, and copy the token. It starts with <code>IG</code> and lasts
      60 days; the worker renews it automatically.
    </li>
    <li>
      Paste it below and click <strong>Connect</strong>. You can leave the app in Development mode: App Review is not needed for your own account.
    </li>
  </ol>`;
}

/** Account preview shown after a successful check, and in Settings. */
export function AccountCard({ connection, children }) {
  const c = connection;
  const type = ACCOUNT_TYPES[c.accountType] || null;
  return html`<div class="ci-account">
    <${Avatar} src=${c.profilePictureUrl} name=${c.name || c.username} size=${56} />
    <div class="ci-account-text">
      <div class="ci-account-name">${c.name || c.username}</div>
      <div class="mono muted">@${c.username}</div>
      <div class="ci-account-meta">
        ${typeof c.followersCount === 'number' ? html`<span><strong class="num">${formatNumber(c.followersCount)}</strong> followers</span>` : null}
        ${type ? html`<span>${type}</span>` : null}
        <${Badge} tone="outline">${c.mode === 'facebook' ? 'Facebook Login' : 'Instagram Login'}<//>
        ${c.mode === 'facebook' && c.pageName ? html`<span>Page: ${c.pageName}</span>` : null}
      </div>
    </div>
    ${children}
  </div>`;
}

/** Reminder for DM features; shown after connecting and in Settings. */
export function MessagesReminder() {
  return html`<${Callout} tone="info" title="One more setting for direct messages">
    To let Postpilot read and answer DMs, open the Instagram app → <strong>Settings</strong> → <strong>Messages and story replies</strong> → <strong>Message controls</strong> → <strong>Connected tools</strong> and turn on <strong>Allow access to messages</strong>.
  <//>`;
}

/**
 * ConnectInstagram {onConnected(connection) => Promise|void, initialMode?, submitLabel?, onCancel?}
 * Validates the token live against Instagram and shows the account before handing it back.
 */
export function ConnectInstagram({ onConnected, initialMode = 'instagram', onCancel }) {
  const [mode, setMode] = useState(initialMode === 'facebook' ? 'facebook' : 'instagram');
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [found, setFound] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  async function check(e, pageId) {
    if (e) e.preventDefault();
    setError(null);
    const clean = cleanToken(token);
    const pre = precheck(clean, mode);
    if (pre) return setError(pre);
    setBusy(true);
    try {
      const conn = await connectInstagram({ mode, token: clean, igBase: ENDPOINTS.igBase, fbBase: ENDPOINTS.fbBase, ruploadBase: ENDPOINTS.rupload, pageId });
      try {
        const me = await createIg({
          mode: conn.mode,
          token: conn.token,
          userId: conn.userId,
          pageId: conn.pageId,
          pageToken: conn.pageToken,
          igBase: ENDPOINTS.igBase,
          fbBase: ENDPOINTS.fbBase,
        }).me();
        if (typeof me.followersCount === 'number') conn.followersCount = me.followersCount;
        if (typeof me.mediaCount === 'number') conn.mediaCount = me.mediaCount;
      } catch {
        // The account is valid; the follower count is only a nicety.
      }
      if (alive.current) setFound(conn);
    } catch (err) {
      if (alive.current) setError(explainConnectError(err, mode));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function use() {
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    try {
      await onConnected({ ...found, status: { state: 'ok', at: now, checkedAt: now } });
    } catch (err) {
      if (alive.current) setError({ title: 'Could not save the connection', body: (err && (err.userMessage || err.message)) || String(err) });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  if (found) {
    const pages = found.pages || [];
    const personal = found.accountType === 'PERSONAL';
    return html`<div class="ci stack">
      <p class="ci-found-label"><${Icon} name="check-circle" size=${16} /> Token works. This is the account Postpilot will manage:</p>
      <${AccountCard} connection=${found} />
      ${found.mode === 'facebook' && pages.length > 1
        ? html`<${Field} label="Facebook Page" hint="You manage several Pages with an Instagram account. Pick the one to use.">
            <${Select}
              value=${found.pageId}
              options=${pages.map((p) => ({ value: p.pageId, label: `${p.pageName || p.pageId} (@${p.username || p.userId})` }))}
              onChange=${(id) => check(null, id)}
              disabled=${busy}
            />
          <//>`
        : null}
      ${personal
        ? html`<${Callout} tone="warning" title="This is a personal account">Instagram only allows publishing and insights for professional accounts.
            Switch it in the Instagram app (Settings → Account type and tools), then connect again.<//>`
        : null}
      <${MessagesReminder} />
      ${error ? html`<${Callout} tone="danger" title=${error.title}>${error.body}<//>` : null}
      <div class="row">
        <${Button} variant="primary" icon="check" loading=${saving} disabled=${busy} onClick=${use}>Use @${found.username}<//>
        <${Button} variant="ghost" disabled=${saving} onClick=${() => (setFound(null), setError(null))}>Use a different token<//>
      </div>
    </div>`;
  }

  return html`<form class="ci stack" onSubmit=${check} noValidate>
    <div class="ci-modes" role="radiogroup" aria-label="Connection type">
      ${MODES.map(
        (m) => html`<label key=${m.value} class=${cx('ci-mode', mode === m.value && 'is-selected')}>
          <input type="radio" name="ci-mode" value=${m.value} checked=${mode === m.value}
            onChange=${() => (setMode(m.value), setError(null))} />
          <span class="ci-mode-text">
            <span class="ci-mode-title">${m.title}${m.badge ? html` <${Badge} tone="accent">${m.badge}<//>` : null}</span>
            <span class="ci-mode-body">${m.body}</span>
          </span>
        </label>`,
      )}
    </div>
    <div class="ci-howto">
      <p class="label-caps">How to get your token</p>
      <${Steps} mode=${mode} />
    </div>
    <${Field}
      id="ci-token"
      label="Access token"
      hint="Paste the whole token. It is stored encrypted in your repository and only sent to Instagram."
      action=${html`<button type="button" class="link-btn" onClick=${() => setReveal((r) => !r)} aria-pressed=${reveal ? 'true' : 'false'}>
        <${Icon} name=${reveal ? 'eye-off' : 'eye'} size=${14} />${reveal ? 'Hide' : 'Show'}
      </button>`}
    >
      <${TextInput}
        type=${reveal ? 'text' : 'password'}
        mono
        value=${token}
        onChange=${(v) => (setToken(v), error && setError(null))}
        placeholder=${mode === 'facebook' ? 'EAA…' : 'IGAA…'}
        autocomplete="off"
        spellcheck=${false}
        autocapitalize="off"
      />
    <//>
    ${error ? html`<${Callout} tone="danger" title=${error.title}>${error.body}<//>` : null}
    <div class="row">
      <${Button} type="submit" variant="primary" icon="link" loading=${busy}>Connect<//>
      ${onCancel ? html`<${Button} variant="ghost" onClick=${onCancel}>Cancel<//>` : null}
    </div>
  </form>`;
}

export default ConnectInstagram;
