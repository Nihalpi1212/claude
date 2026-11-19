"""Crude check of the upstream paths Pigment's own Rust files use: resolve `a::b::c` against an
old and a new upstream tree and report the paths that resolve in old but not in new.

usage: symcheck.py OLD_ROOT NEW_ROOT PIGMENT_ROOT file...
"""
import re, sys, pathlib

OLD, NEW, PIG = (pathlib.Path(a) for a in sys.argv[1:4])
FILES = sys.argv[4:]

def crate_roots(root):
    m = {}
    for toml in list(root.glob("crates/*/Cargo.toml")) + list(root.glob("apps/*/Cargo.toml")):
        txt = toml.read_text(errors="replace")
        name = re.search(r'^name\s*=\s*"([^"]+)"', txt, re.M)
        if not name:
            continue
        src = toml.parent / "src"
        lib = src / "lib.rs"
        if not lib.exists():
            lib = src / "main.rs"
        m[name.group(1).replace("-", "_")] = lib
    return m

def mod_file(root_file, parts):
    """Resolve module parts from a crate root file; return file path or None."""
    cur = root_file
    for p in parts:
        base = cur.parent if cur.name in ("lib.rs", "main.rs", "mod.rs") else cur.with_suffix("")
        cands = [base / f"{p}.rs", base / p / "mod.rs"]
        # #[path] or inline mod: accept inline mod declared in cur
        found = next((c for c in cands if c.exists()), None)
        if found is None:
            txt = cur.read_text(errors="replace") if cur.exists() else ""
            if re.search(r'\bmod\s+' + re.escape(p) + r'\s*\{', txt):
                return cur  # inline module: approximate
            return None
        cur = found
    return cur

DEF = r'(?:fn|struct|enum|const|static|type|trait|mod|macro_rules!|union)\s+{}\b'

def defined(file, ident, depth=0):
    if file is None or not file.exists():
        return False
    txt = file.read_text(errors="replace")
    if re.search(DEF.format(re.escape(ident)), txt):
        return True
    if re.search(r'macro_rules!\s*' + re.escape(ident) + r'\b', txt):
        return True
    # re-export
    if re.search(r'pub(?:\([^)]*\))?\s+use\s+[^;]*\b' + re.escape(ident) + r'\b[^;]*;', txt, re.S):
        return True
    if re.search(r'pub(?:\([^)]*\))?\s+use\s+[^;]*::\*\s*;', txt):
        return True  # glob re-export: give up, assume ok
    # enum variant or assoc item: search the whole crate dir for `ident` as a variant/field/fn
    return False

def resolve(root, crates, path, own_crate):
    parts = path.split("::")
    head = parts[0]
    if head == "crate":
        lib = crates.get(own_crate)
        parts = parts[1:]
    elif head in crates:
        lib = crates[head]
        parts = parts[1:]
    else:
        return None  # not an upstream path
    if lib is None or not parts:
        return True
    # try longest module prefix then ident
    for k in range(len(parts), 0, -1):
        f = mod_file(lib, parts[:k])
        if f is not None:
            if k == len(parts):
                return True
            ident = parts[k]
            if defined(f, ident):
                return True
            # Type::assoc: accept if the type is defined and the assoc ident appears in the crate
            if k + 1 < len(parts) and re.match(r'[A-Z]', ident):
                d = lib.parent
                for rs in d.rglob("*.rs"):
                    if re.search(r'\b' + re.escape(parts[k + 1]) + r'\b', rs.read_text(errors="replace")):
                        return True
            return False
    # first part not a module: maybe an item in the crate root
    return defined(lib, parts[0])

PATH = re.compile(r'\b((?:crate|photocraft_[a-z_]+|craft_[a-z_]+|craft)(?:::[A-Za-z_][A-Za-z0-9_]*)+)')
USE = re.compile(r'\buse\s+([^;]+);', re.S)

def expand_use(tree):
    tree = re.sub(r'\s+', '', tree)
    out = []
    def rec(prefix, t):
        m = re.match(r'^(.*?)\{(.*)\}$', t)
        if m:
            pre = prefix + m.group(1)
            depth, cur, items = 0, '', []
            for ch in m.group(2):
                if ch == ',' and depth == 0:
                    items.append(cur); cur = ''
                    continue
                if ch == '{': depth += 1
                if ch == '}': depth -= 1
                cur += ch
            if cur: items.append(cur)
            for it in items:
                rec(pre, it)
        else:
            t = re.sub(r'as\w+$', '', t)
            t = (prefix + t)
            if t.endswith('::self'):
                t = t[:-6]
            if not t.endswith('*'):
                out.append(t.rstrip(':'))
    rec('', tree)
    return out

def own_crate_of(rel):
    parts = rel.split('/')
    toml = PIG.joinpath(*parts[:2], 'Cargo.toml')
    if toml.exists():
        n = re.search(r'^name\s*=\s*"([^"]+)"', toml.read_text(), re.M)
        if n:
            return n.group(1).replace('-', '_')
    return None

def mod_path_of(rel):
    """crate-relative module path of a file, for `super::`/`self::`."""
    p = rel.split('/')
    i = p.index('src') if 'src' in p else None
    if i is None:
        return None
    mods = p[i+1:]
    last = mods[-1][:-3]
    mods = mods[:-1] + ([] if last in ('lib', 'main', 'mod') else [last])
    return mods

old_c, new_c = crate_roots(OLD), crate_roots(NEW)
results = {}
for rel in FILES:
    f = PIG / rel
    txt = f.read_text(errors="replace")
    # drop comments
    code = re.sub(r'//[^\n]*', '', txt)
    paths = set()
    mods = mod_path_of(rel)
    for m in USE.finditer(code):
        for p in expand_use(m.group(1)):
            if p.startswith('super::') and mods is not None:
                pp, up = p, list(mods)
                while pp.startswith('super::'):
                    pp = pp[7:]; up = up[:-1]
                p = '::'.join(['crate'] + up + [pp])
            elif p.startswith('self::') and mods is not None:
                p = '::'.join(['crate'] + mods + [p[6:]])
            paths.add(p)
    for m in PATH.finditer(code):
        paths.add(m.group(1))
    own = own_crate_of(rel)
    for p in sorted(paths):
        # skip Pigment's own modules
        if re.search(r'(ai_cmds|generative|legacy_pigment|ai_ui|genai|legacy_save_prompt|brand)\b', p):
            continue
        ro = resolve(OLD, old_c, p, own)
        rn = resolve(NEW, new_c, p, own)
        if ro is None:
            continue
        if ro and not rn:
            results.setdefault(p, []).append(rel)
for p, files in sorted(results.items()):
    print(f"{p}\t{len(files)}\t{', '.join(sorted(set(files)))[:300]}")
