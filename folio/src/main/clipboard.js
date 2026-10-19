// Clipboard helpers for the main process. Electron 44 replaced the synchronous clipboard calls
// (readImage, writeImage) with W3C-style async ones (read/write with ClipboardItem); both are
// supported so the code also runs on older Electron versions.
import * as electron from 'electron';

const ClipboardItemClass = electron.ClipboardItem ?? electron.default?.ClipboardItem ?? globalThis.ClipboardItem;

export async function writeClipboardText(clipboard, text) {
  if (typeof text !== 'string') return;
  await clipboard.writeText(text);
}

/** Writes a PNG/JPEG data URL to the clipboard as an image. */
export async function writeClipboardImage(clipboard, nativeImage, dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return;
  if (typeof clipboard.writeImage === 'function') {
    clipboard.writeImage(image);
    return;
  }
  if (!ClipboardItemClass) throw new Error('This version of Electron cannot write images to the clipboard');
  const png = image.toPNG();
  await clipboard.write([new ClipboardItemClass({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

/** PNG bytes of the image on the clipboard, or null. */
export async function readClipboardImage(clipboard, nativeImage) {
  if (typeof clipboard.readImage === 'function') {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : new Uint8Array(image.toPNG());
  }
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (type === 'image/png') return bytes;
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    return image.isEmpty() ? null : new Uint8Array(image.toPNG());
  }
  return null;
}
