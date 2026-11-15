// type-editing (ARCHITECTURE.md "0.4 features", package 2): the formatted clipboard of the Type tool.
// Pure (the editor does the system clipboard I/O through lib/bridge.js); unit-tested in Node.
//
// Copy and Cut always write the plain text to the system clipboard (other applications, Paste Without Formatting)
// and keep an in-app clipboard { content, text } with the formatting. Paste uses the in-app content only while the
// system clipboard's text still equals its text: when something else was copied since, in Pigment or in another
// application, the system text wins and is pasted with the style at the caret, as Photoshop does.
import * as M from './model.js';

let inApp = null;

/** The plain text a copy writes: paragraphs and forced line breaks both become line feeds. */
export function clipText(content) {
  return M.plainText(content).replace(/\u2028/g, '\n');
}

/** Normalises text read from the system clipboard (CR LF and CR to LF, no NUL). */
export function normalizeSystemText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

/** The clipboard entry for [from, to) of content: { content (formatted slice), text (plain) }. */
export function makeClip(content, from, to) {
  const piece = M.sliceContent(content, Math.min(from, to), Math.max(from, to));
  return { content: piece, text: clipText(piece) };
}

export function setInAppClip(clip) {
  inApp = clip ? { content: clip.content, text: clip.text } : null;
}

export function inAppClip() {
  return inApp;
}

/**
 * What a paste inserts: the in-app formatted content when it is still what the system clipboard holds (and the paste
 * keeps formatting), else the system text. Returns { kind: 'formatted', content, text } | { kind: 'plain', text } |
 * null (nothing to paste).
 */
export function choosePaste(clip, systemText, { plain = false } = {}) {
  const sys = systemText == null ? null : normalizeSystemText(systemText);
  if (!plain && clip && (sys === null || sys === clip.text) && clip.text) return { kind: 'formatted', content: clip.content, text: clip.text };
  const text = sys ?? clip?.text ?? '';
  return text ? { kind: 'plain', text } : null;
}

/**
 * Applies a paste to [from, to) of content. A formatted paste inserts the piece with its runs and paragraph styles
 * (A insertContent); a plain one takes `style` (the caret's insertion style, sparse) or, by default, the style of
 * the first replaced character / the character before the caret. Returns { content, caret }.
 */
export function applyPaste(content, from, to, paste, { style } = {}) {
  const a = Math.min(from, to), b = Math.max(from, to);
  if (!paste) return { content, caret: b };
  if (paste.kind === 'formatted') {
    const cut = M.deleteRange(content, a, b);
    return { content: M.insertContent(cut, a, paste.content), caret: a + M.contentLength(paste.content) };
  }
  // a plain paste keeps the paragraph and run structure of the text around it; a line feed starts a paragraph
  const text = paste.text;
  return { content: M.replaceRange(content, a, b, text, style), caret: a + text.length };
}
