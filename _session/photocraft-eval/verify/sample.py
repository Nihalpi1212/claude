import json, glob, os, sys
MAP = "/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/map"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample-rows.jsonl")
def pick(rows, want):
    if not rows: return []
    k = max(1, len(rows)//want)
    return rows[::k][:want]
out=[]
for f in sorted(glob.glob(MAP+"/*.jsonl")):
    rows=[json.loads(l) for l in open(f) if l.strip()]
    g1=[r for r in rows if r.get("ahead")=="photocraft" and r.get("photocraft") in ("Done","Partial") and r.get("pigment")=="Missing"]
    g2=[r for r in rows if r.get("ahead")=="pigment"]
    g3=[r for r in rows if r.get("ahead")=="same"]
    for name,g,w in (("pc-ahead",g1,6),("pig-ahead",g2,4),("same",g3,2)):
        for r in pick(g,w):
            r=dict(r); r["_group"]=name; r["_file"]=os.path.basename(f); out.append(r)
    print(os.path.basename(f), len(rows), len(g1), len(g2), len(g3), file=sys.stderr)
with open(OUT,"w") as o:
    for r in out: o.write(json.dumps(r)+"\n")
print(len(out), file=sys.stderr)
