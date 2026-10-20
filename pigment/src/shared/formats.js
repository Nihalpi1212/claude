// File formats Pigment opens and saves (shared by the main process and the renderer).
export const LAYERED_EXTENSIONS = ['pigment', 'psd', 'psb'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'ico', 'avif', 'svg'];
export const OPEN_EXTENSIONS = [...LAYERED_EXTENSIONS, ...IMAGE_EXTENSIONS];

export const OPEN_DIALOG_FILTERS = [
  { name: 'All supported images', extensions: OPEN_EXTENSIONS },
  { name: 'Pigment documents', extensions: ['pigment'] },
  { name: 'Photoshop documents', extensions: ['psd', 'psb'] },
  { name: 'Images', extensions: IMAGE_EXTENSIONS },
  { name: 'All files', extensions: ['*'] },
];

export function isOpenablePath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(String(path));
  return !!m && OPEN_EXTENSIONS.includes(m[1].toLowerCase());
}
