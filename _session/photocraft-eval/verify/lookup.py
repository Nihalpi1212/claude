import json,re,glob,sys
S="/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/photocraft-eval/verify/sample-rows.jsonl"
rows=[json.loads(l) for l in open(S)]
pages={}
for f in glob.glob("/home/user/claude/pigment/docs/parity/*.md"):
    p=f.split('/')[-1][:-3]
    pages[p]=[l for l in open(f) if l.startswith('|')]
for i,r in enumerate(rows):
    if len(sys.argv)>1 and str(i) not in sys.argv[1:]: continue
    feat=r['feature']
    hits=[l for l in pages.get(r['page'],[]) if l.split('|')[1].strip()==feat]
    if not hits:
        hits=[l for l in pages.get(r['page'],[]) if feat[:40] in l]
    print(i, feat[:60]); 
    for h in hits[:2]:
        c=[x.strip() for x in h.split('|')]
        print('   STATUS:',c[3],'| IN:',c[4][:400],'| PLAN:',c[6][:120] if len(c)>6 else '')
