// Postpilot UI kit: Preact + htm function components styled by css/app.css.
//
// Conventions
// - Every component accepts `class` (merged onto its root element).
// - Form controls call onChange(value, event) with the VALUE first (string, boolean,
//   array, ISO string...), never the raw event. Native handlers such as onInput,
//   onBlur, onKeyDown pass straight through to the underlying element.
// - TextInput/TextArea fire onChange on every keystroke (native `input` event).
// - A control inside <Field> picks up the field's id, hint/error aria-describedby and
//   aria-invalid automatically. Put one control per Field.
// - Overlays (Modal, Drawer, ConfirmDialog) close on Escape and backdrop click, trap
//   Tab focus, focus [data-autofocus] or the first focusable element on open, restore
//   focus on close and lock body scroll. Only the topmost overlay reacts to Escape.

import { html, createContext, useState, useEffect, useRef, useMemo, useLayoutEffect, useId, useContext } from '../../vendor/preact.js';
import { Icon } from './icons.js';
import { Sparkline, formatValue, formatDelta } from './charts.js';
import { zonedToUtc, dayKey, timeKey } from '../../core/time.js';

export { Icon, formatValue, formatDelta };

/** Join class names, skipping falsy values. */
export function cx(...parts) {
  return parts.flat().filter(Boolean).join(' ');
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** True while the viewport matches `query` (re-renders on change). */
export function useMediaQuery(query) {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** True on phone-sized viewports (< 760px), matching the CSS breakpoint. */
export function usePhone() {
  return useMediaQuery('(max-width: 759px)');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * Button {variant: 'primary'|'secondary'|'ghost'|'danger', size: 'sm'|'md', icon, iconRight,
 *         loading, disabled, type='button', href?, onClick}
 * With `href` it renders a link styled as a button.
 */
export function Button({ variant = 'secondary', size = 'md', icon, iconRight, loading = false, disabled = false, type = 'button', href, class: cls, children, ...rest }) {
  const hasLabel = children != null && children !== false && children !== '';
  const iconSize = size === 'sm' ? 15 : 17;
  const classes = cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', !hasLabel && 'btn-icon-only', loading && 'is-loading', cls);
  const content = html`${loading ? html`<${Spinner} size=${iconSize - 2} label="" />` : icon ? html`<${Icon} name=${icon} size=${iconSize} />` : null}${hasLabel ? html`<span class="btn-label">${children}</span>` : null}${iconRight && !loading ? html`<${Icon} name=${iconRight} size=${iconSize} />` : null}`;
  if (href && !disabled) return html`<a class=${classes} href=${href} ...${rest}>${content}</a>`;
  return html`<button type=${type} class=${classes} disabled=${disabled || loading} aria-busy=${loading ? 'true' : undefined} ...${rest}>${content}</button>`;
}

/** IconButton {icon, label (required: aria-label + title), onClick, size: 'sm'|'md', variant: 'ghost'|'secondary', pressed?} */
export function IconButton({ icon, label, size = 'md', variant = 'ghost', pressed, type = 'button', class: cls, ...rest }) {
  return html`<button type=${type} class=${cx('icon-btn', `icon-btn-${variant}`, size === 'sm' && 'icon-btn-sm', cls)}
    aria-label=${label} title=${label} aria-pressed=${pressed == null ? undefined : String(!!pressed)} ...${rest}>
    <${Icon} name=${icon} size=${size === 'sm' ? 16 : 18} />
  </button>`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Panel {title, subtitle?, actions?, plain?, flush?, as='section'}
 * plain: no box, just a heading over a hairline rule (use for secondary groupings).
 * flush: body has no padding (tables, lists that run edge to edge).
 */
export function Panel({ title, subtitle, actions, plain = false, flush = false, as = 'section', class: cls, children, ...rest }) {
  const Tag = as;
  const headingId = useId();
  return html`<${Tag} class=${cx('panel', plain && 'panel-plain', flush && 'panel-flush', cls)} aria-labelledby=${title ? headingId : undefined} ...${rest}>
    ${title || actions
      ? html`<header class="panel-head">
          <div class="panel-titles">
            ${title ? html`<h2 class="panel-title" id=${headingId}>${title}</h2>` : null}
            ${subtitle ? html`<p class="panel-subtitle">${subtitle}</p>` : null}
          </div>
          ${actions ? html`<div class="panel-actions">${actions}</div>` : null}
        </header>`
      : null}
    <div class="panel-body">${children}</div>
  </${Tag}>`;
}

/** PageHeader {title, subtitle?, eyebrow?, actions?} - the title block at the top of each screen. */
export function PageHeader({ title, subtitle, eyebrow, actions, class: cls, children }) {
  return html`<header class=${cx('page-header', cls)}>
    <div class="page-heading">
      ${eyebrow ? html`<div class="page-eyebrow">${eyebrow}</div>` : null}
      <h1 class="page-title">${title}</h1>
      ${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : null}
      ${children}
    </div>
    ${actions ? html`<div class="page-actions">${actions}</div>` : null}
  </header>`;
}

/** Tabs {tabs: [{id, label, badge?, icon?}], value, onChange(id), label?} - arrow keys move between tabs. */
export function Tabs({ tabs = [], value, onChange, label, class: cls }) {
  const refs = useRef([]);
  const selectedIndex = Math.max(0, tabs.findIndex((t) => t.id === value));
  const onKey = (e, i) => {
    const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const j = (map[e.key] + tabs.length) % tabs.length;
    onChange?.(tabs[j].id);
    refs.current[j]?.focus();
  };
  return html`<div class=${cx('tabs', cls)} role="tablist" aria-label=${label}>
    ${tabs.map(
      (t, i) => html`<button key=${t.id} ref=${(el) => (refs.current[i] = el)} type="button" role="tab" class="tab"
        aria-selected=${t.id === value ? 'true' : 'false'} tabindex=${i === selectedIndex ? 0 : -1}
        onClick=${() => onChange?.(t.id)} onKeyDown=${(e) => onKey(e, i)}>
        ${t.icon ? html`<${Icon} name=${t.icon} size=${16} />` : null}
        <span>${t.label}</span>
        ${t.badge != null && t.badge !== '' && t.badge !== 0 && t.badge !== false ? html`<span class="tab-badge num">${t.badge}</span>` : null}
      </button>`,
    )}
  </div>`;
}

/**
 * Segmented {options: [{value, label, icon?, title?}] | string[], value, onChange(value), size?: 'sm', label?}
 * A radio group rendered as a compact switcher. Icon-only options need `title`.
 */
export function Segmented({ options = [], value, onChange, size = 'md', label, class: cls }) {
  const opts = options.map((o) => (o && typeof o === 'object' ? o : { value: o, label: String(o) }));
  const refs = useRef([]);
  const sel = Math.max(0, opts.findIndex((o) => o.value === value));
  const onKey = (e, i) => {
    const map = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 };
    if (!(e.key in map)) return;
    e.preventDefault();
    const j = (map[e.key] + opts.length) % opts.length;
    onChange?.(opts[j].value);
    refs.current[j]?.focus();
  };
  return html`<div class=${cx('segmented', size === 'sm' && 'segmented-sm', cls)} role="radiogroup" aria-label=${label}>
    ${opts.map(
      (o, i) => html`<button key=${String(o.value)} ref=${(el) => (refs.current[i] = el)} type="button" role="radio" class="seg"
        aria-checked=${o.value === value ? 'true' : 'false'} tabindex=${i === sel ? 0 : -1}
        aria-label=${o.label ? undefined : o.title} title=${o.title}
        onClick=${() => onChange?.(o.value)} onKeyDown=${(e) => onKey(e, i)}>
        ${o.icon ? html`<${Icon} name=${o.icon} size=${15} />` : null}${o.label ? html`<span>${o.label}</span>` : null}
      </button>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

const overlayStack = [];
let scrollLocks = 0;
let savedPadding = '';
function lockScroll() {
  if (scrollLocks++ > 0) return;
  const sb = window.innerWidth - document.documentElement.clientWidth;
  savedPadding = document.body.style.paddingRight;
  document.body.style.overflow = 'hidden';
  if (sb > 0) document.body.style.paddingRight = `${sb}px`;
}
function unlockScroll() {
  if (--scrollLocks > 0) return;
  scrollLocks = 0;
  document.body.style.overflow = '';
  document.body.style.paddingRight = savedPadding;
}

const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
function focusables(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'));
}

function useOverlay(open, panelRef, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Layout effect so focus moves in and is restored synchronously with the open/close render.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const token = {};
    overlayStack.push(token);
    const previous = document.activeElement;
    lockScroll();
    const panel = panelRef.current;
    if (panel) {
      const body = panel.querySelector('.overlay-body');
      const target =
        panel.querySelector('[data-autofocus],[autofocus]') || focusables(body)[0] || focusables(panel.querySelector('.overlay-foot'))[0] || panel;
      target.focus({ preventScroll: true });
    }
    const onKey = (e) => {
      if (overlayStack[overlayStack.length - 1] !== token) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current?.();
      } else if (e.key === 'Tab' && panel) {
        const els = focusables(panel);
        if (!els.length) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = overlayStack.indexOf(token);
      if (i >= 0) overlayStack.splice(i, 1);
      unlockScroll();
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);
}

function OverlayHead({ title, titleId, onClose, hideClose }) {
  return html`<header class="overlay-head">
    ${title ? html`<h2 class="overlay-title" id=${titleId}>${title}</h2>` : html`<span></span>`}
    ${hideClose ? null : html`<${IconButton} icon="x" label="Close" onClick=${onClose} class="overlay-close" />`}
  </header>`;
}

/**
 * Modal {open, title, onClose, footer?, wide?, closeOnBackdrop=true, hideClose?}
 * Centered dialog. `footer` is a slot for action buttons (right aligned).
 */
export function Modal({ open, title, onClose, footer, wide = false, closeOnBackdrop = true, hideClose = false, class: cls, children }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useOverlay(open, panelRef, onClose);
  if (!open) return null;
  return html`<div class="overlay overlay-modal">
    <div class="overlay-backdrop" aria-hidden="true" onClick=${closeOnBackdrop ? () => onClose?.() : undefined}></div>
    <div class=${cx('modal', wide && 'modal-wide', cls)} role="dialog" aria-modal="true" aria-labelledby=${title ? titleId : undefined} tabindex="-1" ref=${panelRef}>
      <${OverlayHead} title=${title} titleId=${titleId} onClose=${onClose} hideClose=${hideClose} />
      <div class="overlay-body">${children}</div>
      ${footer ? html`<footer class="overlay-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

/**
 * Drawer {open, title, onClose, footer?, width=560}
 * Slides in from the right on desktop; a full-height sheet from the bottom on phones.
 */
export function Drawer({ open, title, onClose, footer, width, closeOnBackdrop = true, class: cls, children }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useOverlay(open, panelRef, onClose);
  if (!open) return null;
  return html`<div class="overlay overlay-drawer">
    <div class="overlay-backdrop" aria-hidden="true" onClick=${closeOnBackdrop ? () => onClose?.() : undefined}></div>
    <div class=${cx('drawer', cls)} role="dialog" aria-modal="true" aria-labelledby=${title ? titleId : undefined} tabindex="-1" ref=${panelRef}
      style=${width ? { '--drawer-w': typeof width === 'number' ? `${width}px` : width } : null}>
      <${OverlayHead} title=${title} titleId=${titleId} onClose=${onClose} />
      <div class="overlay-body">${children}</div>
      ${footer ? html`<footer class="overlay-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

/**
 * ConfirmDialog {open, title, body, confirmLabel='Confirm', cancelLabel='Cancel', danger?, onResolve(bool)}
 * Escape/backdrop/cancel resolve false. Danger dialogs focus Cancel first.
 */
export function ConfirmDialog({ open, title = 'Are you sure?', body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onResolve }) {
  const no = () => onResolve?.(false);
  const yes = () => onResolve?.(true);
  return html`<${Modal} open=${open} title=${title} onClose=${no} class="modal-confirm"
    footer=${html`<${Button} variant="ghost" onClick=${no} data-autofocus=${danger ? '' : undefined}>${cancelLabel}</${Button}>
      <${Button} variant=${danger ? 'danger' : 'primary'} onClick=${yes} data-autofocus=${danger ? undefined : ''}>${confirmLabel}</${Button}>`}>
    ${typeof body === 'string' ? html`<p class="confirm-body">${body}</p>` : body}
  </${Modal}>`;
}

/**
 * Menu {items: [{label, icon?, onClick, danger?, disabled?, hint?} | '-'], trigger?, label='More actions', icon='more', align='end'|'start'}
 * trigger: omitted -> icon button; string -> button with that text; function(props) -> your own
 * element (spread props onto a <button>). The popover is position:fixed so it never gets clipped
 * by scrolling containers; it closes on outside click, Escape, Tab, scroll and resize.
 */
export function Menu({ items = [], trigger, label = 'More actions', icon = 'more', align = 'end', size = 'md', class: cls }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const menuId = useId();
  const triggerEl = () => rootRef.current?.querySelector('[aria-haspopup]');

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const t = triggerEl();
    const pop = listRef.current;
    if (t && pop) {
      const r = t.getBoundingClientRect();
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const left = clamp(align === 'start' ? r.left : r.right - pw, 8, Math.max(8, vw - pw - 8));
      let top = r.bottom + 4;
      if (top + ph > vh - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4;
      // Position before focusing: hidden elements can't take focus.
      Object.assign(pop.style, { left: `${left}px`, top: `${top}px`, visibility: '' });
      setPos({ left, top });
    }
    pop?.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    const onDown = (e) => rootRef.current && !rootRef.current.contains(e.target) && setOpen(false);
    const onScroll = (e) => listRef.current && !listRef.current.contains(e.target) && setOpen(false);
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerEl()?.focus();
  };
  const onKey = (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') setOpen(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const els = [...(listRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
      if (!els.length) return;
      const i = els.indexOf(document.activeElement);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
      els[j].focus();
    }
  };
  const triggerProps = {
    'aria-haspopup': 'menu',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };
  let trig;
  if (typeof trigger === 'function') trig = trigger(triggerProps);
  else if (trigger) trig = html`<${Button} ...${triggerProps} size=${size} iconRight="chevron-down">${trigger}</${Button}>`;
  else trig = html`<${IconButton} ...${triggerProps} icon=${icon} label=${label} size=${size} />`;

  return html`<div class=${cx('menu', cls)} ref=${rootRef} onKeyDown=${onKey}>
    ${trig}
    ${open
      ? html`<div class="menu-pop" role="menu" id=${menuId} aria-label=${label} ref=${listRef}
          style=${pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '0px', top: '0px', visibility: 'hidden' }}>
          ${items.filter(Boolean).map((it, i) =>
            it === '-' || it.divider
              ? html`<div key=${'sep' + i} class="menu-sep" role="separator"></div>`
              : html`<button key=${it.label} type="button" role="menuitem" tabindex="-1" class=${cx('menu-item', it.danger && 'is-danger')} disabled=${it.disabled}
                  onClick=${() => {
                    close();
                    it.onClick?.();
                  }}>
                  ${it.icon ? html`<${Icon} name=${it.icon} size=${16} />` : html`<span class="menu-icon-pad"></span>`}
                  <span class="menu-label">${it.label}</span>
                  ${it.hint ? html`<span class="menu-hint">${it.hint}</span>` : null}
                </button>`,
          )}
        </div>`
      : null}
  </div>`;
}

/** ToastHost {toasts: [{id, message, kind: 'info'|'success'|'error', action?: {label, onClick}}], onDismiss(id)} */
export function ToastHost({ toasts = [], onDismiss }) {
  const icons = { error: 'alert', success: 'check', info: 'info' };
  return html`<div class="toasts" aria-live="polite">
    ${toasts.map(
      (t) => html`<div key=${t.id} class=${cx('toast', `toast-${t.kind || 'info'}`)} role=${t.kind === 'error' ? 'alert' : 'status'}>
        <${Icon} name=${icons[t.kind] || 'info'} size=${18} class="toast-icon" />
        <div class="toast-msg">${t.message}</div>
        ${t.action
          ? html`<button type="button" class="toast-action" onClick=${() => {
              t.action.onClick?.();
              onDismiss?.(t.id);
            }}>${t.action.label}</button>`
          : null}
        <${IconButton} icon="x" label="Dismiss" size="sm" class="toast-close" onClick=${() => onDismiss?.(t.id)} />
      </div>`,
    )}
  </div>`;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const FieldCtx = createContext(null);

function useFieldProps(props = {}) {
  const ctx = useContext(FieldCtx);
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': props['aria-describedby'] ?? ctx?.describedBy,
    'aria-invalid': props['aria-invalid'] ?? (ctx?.invalid ? 'true' : undefined),
  };
}

/** Field {label, hint?, error?, required?, action? (node shown right of the label), inline?} wraps exactly one control. */
export function Field({ label, hint, error, required = false, action, inline = false, id: idProp, class: cls, children }) {
  const auto = useId();
  const id = idProp || `f-${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const ctx = useMemo(() => ({ id, describedBy: [errId, hintId].filter(Boolean).join(' ') || undefined, invalid: !!error }), [id, errId, hintId, error]);
  return html`<${FieldCtx.Provider} value=${ctx}>
    <div class=${cx('field', inline && 'field-inline', error && 'has-error', cls)}>
      ${label || action
        ? html`<div class="field-label-row">
            ${label ? html`<label class="field-label" for=${id}>${label}${required ? html`<span class="field-req" aria-hidden="true">*</span>` : null}</label>` : html`<span></span>`}
            ${action || null}
          </div>`
        : null}
      <div class="field-control">${children}</div>
      ${error ? html`<p class="field-error" id=${errId}><${Icon} name="alert" size=${14} /><span>${error}</span></p>` : null}
      ${hint ? html`<p class="field-hint" id=${hintId}>${hint}</p>` : null}
    </div>
  </${FieldCtx.Provider}>`;
}

/**
 * TextInput {value, onChange(value, event), type='text', placeholder, icon?, prefix?, suffix?, mono?}
 * type="number" reports a number (or null when empty).
 */
export function TextInput({ value, onChange, onInput, type = 'text', icon, prefix, suffix, mono = false, class: cls, ...rest }) {
  const f = useFieldProps(rest);
  const handle = (e) => {
    onInput?.(e);
    const v = e.currentTarget.value;
    onChange?.(type === 'number' ? (v === '' ? null : Number(v)) : v, e);
  };
  const grouped = icon || prefix || suffix;
  const input = html`<input type=${type} class=${cx('input', mono && 'mono', !grouped && cls)} value=${value ?? ''} onInput=${handle} ...${rest} ...${f} />`;
  if (!grouped) return input;
  return html`<div class=${cx('input-group', cls)}>
    ${icon ? html`<span class="input-icon" aria-hidden="true"><${Icon} name=${icon} size=${16} /></span>` : null}
    ${prefix ? html`<span class="input-affix">${prefix}</span>` : null}
    ${input}
    ${suffix ? html`<span class="input-affix">${suffix}</span>` : null}
  </div>`;
}

/** TextArea {value, onChange(value, event), autosize=true, rows=3, maxRows=16} - grows with content up to maxRows. */
export function TextArea({ value, onChange, onInput, autosize = true, rows = 3, maxRows = 16, class: cls, ...rest }) {
  const ref = useRef(null);
  const f = useFieldProps(rest);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !autosize) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 21;
    const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const max = lh * maxRows + chrome;
    el.style.height = 'auto';
    const want = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${Math.min(want, max)}px`;
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [value, autosize, maxRows]);
  const handle = (e) => {
    onInput?.(e);
    onChange?.(e.currentTarget.value, e);
  };
  return html`<textarea ref=${ref} class=${cx('input', 'textarea', autosize && 'is-autosize', cls)} rows=${rows} value=${value ?? ''} onInput=${handle} ...${rest} ...${f}></textarea>`;
}

/**
 * Select {options: [{value, label, disabled?}] | primitive[], value, onChange(value, event), placeholder?}
 * Values keep their original type (numbers stay numbers).
 */
export function Select({ options = [], value, onChange, placeholder, class: cls, ...rest }) {
  const f = useFieldProps(rest);
  const opts = options.map((o) => (o && typeof o === 'object' ? o : { value: o, label: String(o) }));
  const idx = opts.findIndex((o) => o.value === value);
  return html`<div class=${cx('select', cls)}>
    <select class="input" value=${idx >= 0 ? String(idx) : ''} onChange=${(e) => {
      const i = e.currentTarget.value;
      onChange?.(i === '' ? null : opts[Number(i)].value, e);
    }} ...${rest} ...${f}>
      ${placeholder != null || idx < 0 ? html`<option value="" disabled=${idx >= 0}>${placeholder || ''}</option>` : null}
      ${opts.map((o, i) => html`<option key=${i} value=${String(i)} disabled=${o.disabled}>${o.label}</option>`)}
    </select>
    <${Icon} name="chevron-down" size=${16} class="select-caret" />
  </div>`;
}

/** Toggle {checked, onChange(bool), label?, hint?, disabled?} - a switch. Give `aria-label` when there is no label. */
export function Toggle({ checked = false, onChange, label, hint, disabled = false, class: cls, id, ...rest }) {
  const auto = useId();
  const tid = id || `t-${auto}`;
  return html`<label class=${cx('toggle', disabled && 'is-disabled', cls)} for=${tid}>
    <button type="button" id=${tid} role="switch" class="toggle-track" aria-checked=${checked ? 'true' : 'false'} disabled=${disabled}
      onClick=${(e) => onChange?.(!checked, e)} ...${rest}><span class="toggle-thumb"></span></button>
    ${label || hint
      ? html`<span class="toggle-text">${label ? html`<span class="toggle-label">${label}</span>` : null}${hint ? html`<span class="toggle-hint">${hint}</span>` : null}</span>`
      : null}
  </label>`;
}

/** Checkbox {checked, onChange(bool), label?, hint?, indeterminate?, disabled?} */
export function Checkbox({ checked = false, onChange, label, hint, indeterminate = false, disabled = false, class: cls, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return html`<label class=${cx('checkbox', disabled && 'is-disabled', cls)}>
    <input ref=${ref} type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange?.(e.currentTarget.checked, e)} ...${rest} />
    <span class="checkbox-box" aria-hidden="true"><${Icon} name=${indeterminate ? 'minus' : 'check'} size=${14} strokeWidth=${2.5} /></span>
    ${label || hint
      ? html`<span class="checkbox-text">${label ? html`<span class="checkbox-label">${label}</span>` : null}${hint ? html`<span class="checkbox-hint">${hint}</span>` : null}</span>`
      : null}
  </label>`;
}

/**
 * DateTimeField {value: ISO|null, tz, onChange(ISO|null), min?: ISO, defaultTime='09:00', clearable?, disabled?}
 * Native date + time inputs showing wall-clock time in `tz`; emits a UTC ISO string once both are set.
 */
export function DateTimeField({ value, tz = 'UTC', onChange, min, defaultTime = '09:00', clearable = false, disabled = false, required = false, showTz = true, class: cls }) {
  const f = useFieldProps({});
  const toParts = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? { date: dayKey(d, tz), time: timeKey(d, tz) } : { date: '', time: '' };
  };
  const [draft, setDraft] = useState(() => toParts(value));
  useEffect(() => setDraft(toParts(value)), [value, tz]);
  const commit = (next) => {
    if (next.date && !next.time) next = { ...next, time: defaultTime };
    setDraft(next);
    if (!next.date) return; // incomplete; keep the draft and the previous value
    const y = Number(next.date.slice(0, 4));
    if (!(y >= 1970 && y <= 2999)) return;
    const d = zonedToUtc(next.date, next.time, tz);
    if (!Number.isNaN(d.getTime())) onChange?.(d.toISOString());
  };
  const minDate = min ? dayKey(new Date(min), tz) : undefined;
  return html`<div class=${cx('datetime', cls)}>
    <input type="date" class="input" value=${draft.date} min=${minDate} disabled=${disabled} required=${required}
      id=${f.id} aria-describedby=${f['aria-describedby']} aria-invalid=${f['aria-invalid']} aria-label=${f.id ? undefined : 'Date'}
      onInput=${(e) => commit({ ...draft, date: e.currentTarget.value })} />
    <input type="time" class="input" value=${draft.time} step="60" disabled=${disabled} required=${required} aria-label="Time"
      onInput=${(e) => e.currentTarget.value && commit({ ...draft, time: e.currentTarget.value })} />
    ${showTz ? html`<span class="datetime-tz" title="Time zone">${tz}</span>` : null}
    ${clearable && value ? html`<${IconButton} icon="x" label="Clear date and time" size="sm" disabled=${disabled} onClick=${() => {
      setDraft({ date: '', time: '' });
      onChange?.(null);
    }} />` : null}
  </div>`;
}

/** Chip {selected?, onClick?, onRemove?, icon?} - hashtags, keywords, filters. */
export function Chip({ selected, onClick, onRemove, icon, title, removeLabel, class: cls, children }) {
  const inner = html`${icon ? html`<${Icon} name=${icon} size=${14} />` : null}<span class="chip-label">${children}</span>`;
  return html`<span class=${cx('chip', selected && 'is-selected', onClick && 'is-interactive', onRemove && 'has-remove', cls)} title=${title}>
    ${onClick
      ? html`<button type="button" class="chip-main" aria-pressed=${selected == null ? undefined : String(!!selected)} onClick=${onClick}>${inner}</button>`
      : html`<span class="chip-main">${inner}</span>`}
    ${onRemove
      ? html`<button type="button" class="chip-remove" aria-label=${removeLabel || (typeof children === 'string' ? `Remove ${children}` : 'Remove')} onClick=${onRemove}>
          <${Icon} name="x" size=${12} strokeWidth=${2.25} />
        </button>`
      : null}
  </span>`;
}

/**
 * ChipInput {values: string[], onChange(values), placeholder?, normalize?(s) => string|null, max?}
 * Type and press Enter or comma to add; Backspace on an empty input removes the last chip.
 * Pasting "a, b, c" (or "#a #b #c") adds them all. normalize returning null/'' rejects an entry.
 */
export function ChipInput({ values = [], onChange, placeholder = 'Type and press Enter', normalize, max, disabled = false, class: cls, ...rest }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);
  const f = useFieldProps(rest);
  const add = (raw) => {
    let parts = String(raw).split(/[,\n]+/);
    if (parts.length === 1 && /^\s*#\S+(\s+#?\S+)+\s*$/.test(parts[0])) parts = parts[0].split(/\s+/);
    const next = [...values];
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      if (normalize) p = normalize(p);
      if (!p || next.includes(p)) continue;
      if (max && next.length >= max) break;
      next.push(p);
    }
    if (next.length !== values.length) onChange?.(next);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (!text.trim()) {
        if (e.key === ',') e.preventDefault();
        return;
      }
      e.preventDefault();
      add(text);
      setText('');
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange?.(values.slice(0, -1));
    }
  };
  const onPaste = (e) => {
    const t = e.clipboardData?.getData('text') || '';
    if (/[,\n]/.test(t) || /^\s*#\S+\s+#/.test(t)) {
      e.preventDefault();
      add(text + t);
      setText('');
    }
  };
  const full = max != null && values.length >= max;
  return html`<div class=${cx('input', 'chip-input', disabled && 'is-disabled', cls)} onClick=${(e) => e.target === e.currentTarget && inputRef.current?.focus()}>
    ${values.map((v, i) => html`<${Chip} key=${v} onRemove=${disabled ? undefined : () => onChange?.(values.filter((_, j) => j !== i))}>${v}</${Chip}>`)}
    <input ref=${inputRef} value=${text} disabled=${disabled || full} placeholder=${full ? `Limit of ${max} reached` : values.length ? '' : placeholder}
      onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onKeyDown} onPaste=${onPaste}
      onBlur=${() => {
        if (text.trim()) {
          add(text);
          setText('');
        }
      }} ...${rest} ...${f} />
  </div>`;
}

/** CharCounter {value: string|number, max} - "1,234 / 2,200"; turns warning near the limit and danger over it. */
export function CharCounter({ value = '', max, class: cls }) {
  const n = typeof value === 'number' ? value : String(value || '').length;
  const state = max && n > max ? 'is-over' : max && n > max * 0.9 ? 'is-near' : '';
  return html`<span class=${cx('char-counter', state, cls)} aria-live=${state ? 'polite' : 'off'}>
    ${formatValue(n)}${max ? html`<span class="char-counter-max"> / ${formatValue(max)}</span>` : null}
  </span>`;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Badge {tone: 'neutral'|'info'|'accent'|'success'|'warning'|'danger'|'marker'|'outline', icon?} */
export function Badge({ tone = 'neutral', icon, class: cls, children, ...rest }) {
  return html`<span class=${cx('badge', `badge-${tone}`, cls)} ...${rest}>${icon ? html`<${Icon} name=${icon} size=${12} strokeWidth=${2} />` : null}${children}</span>`;
}

const STATUS = {
  draft: ['Draft', 'neutral'],
  scheduled: ['Scheduled', 'accent'],
  publishing: ['Publishing', 'marker'],
  published: ['Published', 'ok'],
  failed: ['Failed', 'bad'],
  canceled: ['Canceled', 'canceled'],
  'needs-approval': ['Needs approval', 'marker'],
  pending: ['Pending', 'accent'],
  queued: ['Queued', 'accent'],
  done: ['Done', 'ok'],
  active: ['Active', 'ok'],
  enabled: ['On', 'ok'],
  paused: ['Paused', 'neutral'],
  disabled: ['Off', 'neutral'],
  expired: ['Expired', 'bad'],
  error: ['Error', 'bad'],
};

/** StatusPill {status, label?} - post/outbox/rule states with a colored dot; publishing pulses. */
export function StatusPill({ status, label, class: cls }) {
  const key = String(status || '').replace(/_/g, '-');
  const [text, tone] = STATUS[key] || [String(status || 'Unknown'), 'neutral'];
  return html`<span class=${cx('status', `status-${tone}`, key === 'publishing' && 'is-live', cls)}>
    <span class="status-dot" aria-hidden="true"></span>${label || text}
  </span>`;
}

/** EmptyState {icon='image', title, body?, action?, compact?} */
export function EmptyState({ icon = 'image', title, body, action, compact = false, class: cls }) {
  return html`<div class=${cx('empty', compact && 'is-compact', cls)}>
    <span class="empty-frame" aria-hidden="true"><${Icon} name=${icon} size=${compact ? 18 : 22} /></span>
    ${title ? html`<p class="empty-title">${title}</p>` : null}
    ${body ? html`<p class="empty-body">${body}</p>` : null}
    ${action ? html`<div class="empty-action">${action}</div>` : null}
  </div>`;
}

/** Spinner {size=16, label='Loading'} - pass label="" when decorative (e.g. inside a button). */
export function Spinner({ size = 16, label = 'Loading', class: cls }) {
  const a11y = label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': 'true' };
  return html`<span class=${cx('spinner', cls)} style=${{ width: `${size}px`, height: `${size}px` }} ...${a11y}></span>`;
}

/** Skeleton {lines=3} text placeholder, or {height, width} for a block. */
export function Skeleton({ lines = 3, height, width, class: cls }) {
  if (height != null) {
    return html`<div class=${cx('skeleton', cls)} style=${{ height: typeof height === 'number' ? `${height}px` : height, width: typeof width === 'number' ? `${width}px` : width }} aria-hidden="true"></div>`;
  }
  return html`<div class=${cx('skeleton-lines', cls)} aria-hidden="true">
    ${Array.from({ length: lines }, (_, i) => html`<div key=${i} class="skeleton skeleton-line" style=${{ width: lines > 1 && i === lines - 1 ? '62%' : width || '100%' }}></div>`)}
  </div>`;
}

function initialsOf(name = '') {
  const words = String(name).replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}
function hashOf(s = '') {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

/** Avatar {src?, name, size=32} - falls back to initials on a tinted circle when src is missing or fails. */
export function Avatar({ src, name = '', size = 32, class: cls }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const px = `${size}px`;
  if (src && !failed) {
    return html`<img class=${cx('avatar', cls)} src=${src} alt=${name} width=${size} height=${size} style=${{ width: px, height: px }}
      loading="lazy" decoding="async" referrerpolicy="no-referrer" onError=${() => setFailed(true)} />`;
  }
  return html`<span class=${cx('avatar', 'avatar-initials', cls)} role="img" aria-label=${name || 'Avatar'}
    style=${{ width: px, height: px, fontSize: `${Math.max(10, Math.round(size * 0.38))}px`, '--tint': `var(--series-${(hashOf(name) % 6) + 1})` }}>${initialsOf(name)}</span>`;
}

/**
 * Stat {label, value (number|string), delta? (fraction, 0.12 = +12%), deltaLabel?, format='number'|'percent'|'compact'|'duration',
 *       sparkline?: number[], hint?, invert? (true when down is good), loading?}
 * Group several inside <div class="stats"> for a hairline-divided KPI strip.
 */
export function Stat({ label, value, delta, deltaLabel, format = 'number', sparkline, hint, invert = false, loading = false, class: cls }) {
  const display = typeof value === 'number' ? formatValue(value, format) : value ?? '—';
  const has = typeof delta === 'number' && Number.isFinite(delta);
  const dir = !has || Math.abs(delta) < 0.0005 ? 'flat' : delta > 0 ? 'up' : 'down';
  const good = dir === 'flat' ? null : (dir === 'up') !== invert;
  const showFoot = delta !== undefined || deltaLabel;
  return html`<div class=${cx('stat', cls)}>
    <div class="stat-head">
      <div class="stat-label">${label}</div>
      ${!loading && Array.isArray(sparkline) && sparkline.length > 1 ? html`<${Sparkline} values=${sparkline} width=${64} height=${22} label=${`${label} trend`} />` : null}
    </div>
    <div class="stat-value">${loading ? html`<${Skeleton} height=${26} width=${90} />` : display}</div>
    ${showFoot
      ? html`<div class="stat-foot">
          <span class=${cx('stat-delta', good === true && 'is-good', good === false && 'is-bad')}>
            ${has ? html`<span aria-hidden="true">${dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'}</span>${formatDelta(delta)}` : '—'}
          </span>
          ${deltaLabel ? html`<span class="stat-delta-label">${deltaLabel}</span>` : null}
        </div>`
      : null}
    ${hint ? html`<div class="stat-hint">${hint}</div>` : null}
  </div>`;
}

/** Callout {tone: 'info'|'success'|'warning'|'danger'|'marker'|'neutral', title?, icon?, action?} */
export function Callout({ tone = 'info', title, icon, action, class: cls, children }) {
  const icons = { info: 'info', success: 'check', warning: 'alert', danger: 'alert', marker: 'bolt', neutral: 'info' };
  return html`<div class=${cx('callout', `callout-${tone}`, cls)}>
    <span class="callout-icon" aria-hidden="true"><${Icon} name=${icon || icons[tone] || 'info'} size=${18} /></span>
    <div class="callout-content">
      ${title ? html`<p class="callout-title">${title}</p>` : null}
      ${children ? html`<div class="callout-body">${children}</div>` : null}
    </div>
    ${action ? html`<div class="callout-action">${action}</div>` : null}
  </div>`;
}

/** Kbd - keyboard key hint. */
export function Kbd({ class: cls, children }) {
  return html`<kbd class=${cx('kbd', cls)}>${children}</kbd>`;
}

/** ProgressBar {value, max=100, label? (aria), tone: 'accent'|'ok'|'warn'|'bad'} - track is a lighter step of the same hue. */
export function ProgressBar({ value = 0, max = 100, label, tone = 'accent', class: cls }) {
  const pct = max > 0 ? clamp((Number(value) || 0) / max, 0, 1) : 0;
  return html`<div class=${cx('progress', `progress-${tone}`, cls)} role="progressbar" aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${value} aria-label=${label}>
    <span class="progress-fill" style=${{ width: `${pct * 100}%` }}></span>
  </div>`;
}

/**
 * DataTable {columns: [{key, label, render?(row), align?: 'left'|'right'|'center', sortable?, width?, sortValue?(row), class?}],
 *            rows, initialSort?: {key, dir: 'asc'|'desc'}, sortable? (all columns), onRowClick?(row), empty?, rowKey?(row),
 *            maxHeight? (enables vertical scroll + sticky header), dense?, caption?}
 * Clicks on buttons/links inside a row don't trigger onRowClick.
 */
export function DataTable({ columns = [], rows = [], initialSort = null, sortable = false, onRowClick, empty, rowKey, maxHeight, dense = false, caption, class: cls }) {
  const [sort, setSort] = useState(initialSort);
  const isSortable = (c) => !!(c.sortable ?? sortable);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sortValue || ((r) => r[col.key]);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return rows
      .map((r, i) => [r, i, get(r)])
      .sort(([, ia, va], [, ib, vb]) => {
        const an = va == null || va === '' || (typeof va === 'number' && Number.isNaN(va));
        const bn = vb == null || vb === '' || (typeof vb === 'number' && Number.isNaN(vb));
        if (an || bn) return an && bn ? ia - ib : an ? 1 : -1;
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        return c ? c * dir : ia - ib;
      })
      .map(([r]) => r);
  }, [rows, sort, columns]);
  const toggle = (c) =>
    setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.defaultDir || (c.align === 'right' ? 'desc' : 'asc') }));

  if (!rows.length && empty !== undefined) {
    return typeof empty === 'string' ? html`<${EmptyState} compact icon="list" title=${empty} />` : empty;
  }
  const rowClick = (r) => (e) => {
    const hit = e.target.closest?.('a,button,input,select,textarea,label,[role="menuitem"]');
    if (hit && hit !== e.currentTarget && e.currentTarget.contains(hit)) return;
    onRowClick(r, e);
  };
  return html`<div class=${cx('table-wrap', maxHeight && 'is-scroll', cls)} style=${maxHeight ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight } : null}>
    <table class=${cx('table', dense && 'table-dense', onRowClick && 'table-clickable')}>
      ${caption ? html`<caption class="sr-only">${caption}</caption>` : null}
      <thead>
        <tr>
          ${columns.map((c) => {
            const active = sort && sort.key === c.key;
            const can = isSortable(c);
            return html`<th key=${c.key} scope="col" class=${cx(c.align && `align-${c.align}`)} style=${c.width ? { width: typeof c.width === 'number' ? `${c.width}px` : c.width } : null}
              aria-sort=${active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : can ? 'none' : undefined}>
              ${can
                ? html`<button type="button" class="th-sort" onClick=${() => toggle(c)}>
                    <span>${c.label}</span>
                    <${Icon} name=${active ? (sort.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort'} size=${13} class=${active ? '' : 'th-sort-idle'} />
                  </button>`
                : c.label}
            </th>`;
          })}
        </tr>
      </thead>
      <tbody>
        ${sorted.map(
          (r, i) => html`<tr key=${rowKey ? rowKey(r) : r.id ?? i} onClick=${onRowClick ? rowClick(r) : undefined} tabindex=${onRowClick ? 0 : undefined}
            onKeyDown=${onRowClick ? (e) => e.key === 'Enter' && e.target === e.currentTarget && onRowClick(r, e) : undefined}>
            ${columns.map((c) => html`<td key=${c.key} class=${cx(c.align && `align-${c.align}`, c.class)}>${c.render ? c.render(r) : r[c.key] ?? ''}</td>`)}
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/**
 * Frame {src?, alt?, number? (7 -> "07", or "07A"), label?, ratio='1 / 1', kind?: 'image'|'video'|'reel'|'carousel'|'story',
 *        selected?, marked? (grease-pencil circle), onClick?, badge?, fit='cover'|'contain', size?}
 * Contact-sheet thumbnail: 3px surface frame + hairline, mono frame number on the film edge.
 * Children render inside the media box (as the placeholder when there is no src, or as an overlay).
 */
export function Frame({ src, alt = '', number, label, ratio = '1 / 1', kind, selected, marked = false, onClick, badge, fit = 'cover', size, class: cls, children, ...rest }) {
  const no = number == null || number === '' ? null : typeof number === 'number' ? String(number).padStart(2, '0') : String(number);
  const kindIcon = { video: 'play', reel: 'reel', carousel: 'carousel', story: 'story' }[kind];
  const Tag = onClick ? 'button' : 'div';
  return html`<${Tag} type=${onClick ? 'button' : undefined} class=${cx('frame', selected && 'is-selected', marked && 'is-marked', onClick && 'is-interactive', cls)}
    style=${size ? { width: typeof size === 'number' ? `${size}px` : size, flex: 'none' } : null} onClick=${onClick}
    aria-pressed=${onClick && selected != null ? String(!!selected) : undefined} ...${rest}>
    <span class="frame-media" style=${{ aspectRatio: ratio }}>
      ${src ? html`<img src=${src} alt=${alt} loading="lazy" decoding="async" draggable="false" style=${{ objectFit: fit }} />` : null}
      ${src ? children : children || html`<span class="frame-blank"><${Icon} name=${kind === 'video' || kind === 'reel' ? 'video' : 'image'} size=${20} /></span>`}
      ${kindIcon ? html`<span class="frame-kind" aria-hidden="true"><${Icon} name=${kindIcon} size=${13} /></span>` : null}
      ${badge != null && badge !== '' ? html`<span class="frame-badge">${badge}</span>` : null}
      ${selected ? html`<span class="frame-check" aria-hidden="true"><${Icon} name="check" size=${12} strokeWidth=${2.75} /></span>` : null}
    </span>
    ${no != null || label ? html`<span class="frame-edge"><span class="frame-no">${no}</span>${label ? html`<span class="frame-label">${label}</span>` : null}</span>` : null}
  </${Tag}>`;
}
