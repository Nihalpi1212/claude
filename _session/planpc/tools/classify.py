import sys, pathlib
W = pathlib.Path(sys.argv[1])
ns = {}
renames = {}
for line in (W / "namestatus.txt").read_text().splitlines():
    parts = line.split("\t")
    st = parts[0]
    ns[parts[1]] = st
    if st.startswith("R"):
        renames[parts[1]] = parts[2]
conf = set((W / "conflicts.txt").read_text().split())
failed = set((W / "failed.txt").read_text().split())
def status(f):
    if f in failed: return "FAILED(del)"
    if f in conf: return "CONFLICT"
    return "clean"
for kind in ("script_only", "hand"):
    files = (W / f"{kind}.txt").read_text().split()
    hit = [f for f in files if f in ns]
    out = []
    for f in sorted(hit):
        st = ns[f]
        extra = (" -> " + renames[f]) if f in renames else ""
        out.append(f"{st[0]}\t{status(f)}\t{f}{extra}")
    (W / f"{kind}_up.txt").write_text("\n".join(out) + "\n")
    print(kind, len(files), "upstream-touched", len(hit))
