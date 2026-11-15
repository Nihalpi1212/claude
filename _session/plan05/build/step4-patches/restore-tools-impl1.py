# Restores implementer 1's step-3 changes to src/renderer/lib/tools.js on the 0.4.0 file (exactly as read from the
# working tree before it was overwritten): the keymap:changed re-render, rendererKey() and its two call sites.
import sys
p = sys.argv[1] if len(sys.argv) > 1 else '/home/user/claude/pigment/src/renderer/lib/tools.js'
s = open(p).read()
rep = [
("""    this.toolbox = document.getElementById('toolbox');
    this.optionsBar = document.getElementById('options-bar');""",
"""    this.toolbox = document.getElementById('toolbox');
    // 0.5 (S9.4): the tooltips show the keys as bound now
    app.on?.('keymap:changed', () => {
      if (this.toolboxBuilt) this.renderToolbox();
    });
    this.optionsBar = document.getElementById('options-bar');"""),
("""  updateCursor() {""",
"""  /** The first renderer key of cmd in the effective keymap. keymap (lib/keymap-store.js) */
  rendererKey(cmd) {
    return this.app.keymap ? this.app.keymap.keysFor(cmd, 'renderer')[0] ?? null : RENDERER_KEYS[cmd]?.[0] ?? null;
  }

  updateCursor() {"""),
("""      const key = RENDERER_KEYS[`tool:${slot.id}`]?.[0] ?? RENDERER_KEYS[`tool:${tool.id}`]?.[0];""",
"""      const key = this.rendererKey(`tool:${slot.id}`) ?? this.rendererKey(`tool:${tool.id}`);"""),
("""    const key = RENDERER_KEYS[`tool:${slot.id}`]?.[0];""",
"""    const key = this.rendererKey(`tool:${slot.id}`);"""),
]
for a, b in rep:
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
open(p, 'w').write(s)
print('restored', p)
