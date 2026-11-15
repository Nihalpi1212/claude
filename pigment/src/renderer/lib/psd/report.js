// The report a PSD read or write fills (ARCHITECTURE.md "0.5 features", S4.2, S4.4), skeleton file. Mappers add a code
// (with an optional detail) for every feature they could not carry; the notices registered for those codes
// (registry.js registerPsdNotice) turn the counts into the lines the user sees: toasts after a save, `doc.openNotices`
// after an open. Node-safe.
import { psdNotices } from './registry.js';

/** A fresh report: `add(code, detail?)`, `count(code)`, `details(code)`, `codes()`, `lines(when?)`. */
export function createReport() {
  const counts = new Map(); // code -> { count, details: [] }, in the order codes were first added
  return {
    add(code, detail) {
      if (!code) return;
      const e = counts.get(code) ?? { count: 0, details: [] };
      e.count++;
      if (detail !== undefined) e.details.push(detail);
      counts.set(code, e);
    },
    count: (code) => counts.get(code)?.count ?? 0,
    details: (code) => (counts.get(code)?.details ?? []).slice(),
    codes: () => [...counts.keys()],
    /**
     * The notice lines for the codes added, in the notices' registration order; `when` ('open' | 'save') keeps that
     * direction only. A code without a registered notice gives no line (a mapper's own bookkeeping).
     */
    lines(when = null) {
      return this.notices(when).map((n) => n.text);
    },
    /** `{ code, text, timeout }` for each line of lines(). */
    notices(when = null) {
      const out = [];
      for (const n of psdNotices()) {
        if (when && n.when !== when) continue;
        const e = counts.get(n.code);
        if (!e?.count) continue;
        let text = '';
        try {
          text = n.text(e.count, e.details.slice());
        } catch {
          text = '';
        }
        if (text) out.push({ code: n.code, text, timeout: n.timeout });
      }
      return out;
    },
  };
}

/** Shows the save notices of a report as toasts, one per code (0.4's toasts, in 0.4's order). */
export function toastSaveNotices(app, report) {
  const dialogs = app?.dialogs;
  if (!dialogs?.toast) return;
  for (const n of report.notices('save')) dialogs.toast(n.text, { timeout: n.timeout });
}

