# Step 4 of the skeleton (CONTRACT-05 Part 2): the edits to existing files, as one re-runnable script. Run it on a tree
# whose files are 0.4.0's or carry steps 1-3 (implementer 1): every replacement is anchored on text both versions
# share. Each file is patched only when it does not carry the step-4 change yet. The new files of step 4 are separate
# (lib/brush/*.js, lib/brush-cursor.js, lib/tools/paint-gesture.js, the tests).
import sys, os
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/home/user/claude/pigment'
R = os.path.join(ROOT, 'src', 'renderer')

def patch(rel, rep, marker):
    p = os.path.join(R, rel)
    s = open(p).read()
    if marker in s:
        print('already patched', rel)
        return
    for item in rep:
        if callable(item):
            s = item(s)
            continue
        a, b = item
        assert s.count(a) == 1, (rel, a[:80])
        s = s.replace(a, b)
    open(p, 'w').write(s)
    print('patched', rel)

def cut(start, end, insert=''):
    def f(s):
        i = s.index(start)
        j = s.index(end, i)
        return s[:i] + insert + s[j:]
    return f

exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'step4-edits.py')).read())
