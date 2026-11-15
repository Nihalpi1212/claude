// Pure helper: which of the command-line arguments are files to open.
import { isAbsolute, resolve } from 'node:path';

/**
 * @param {string[]} argv       process.argv (or the argv of a second instance)
 * @param {{ isPackaged: boolean, cwd: string, exists?: (p: string) => boolean }} opts
 */
export function filesFromArgv(argv, { isPackaged, cwd, exists = () => true }) {
  // Packaged: [exe, ...args]. Dev ("electron ."): [electron, ".", ...args].
  const args = argv.slice(isPackaged ? 1 : 2);
  const files = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue;
    const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (!/\.pdf$/i.test(abs)) continue;
    if (!exists(abs)) continue;
    if (!files.includes(abs)) files.push(abs);
  }
  return files;
}
