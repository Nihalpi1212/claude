import json,glob,collections
rows=json.load(open('il_rows.json'))
pc={}
for f in sorted(glob.glob('work/il_*.tsv')):
    for line in open(f):
        line=line.rstrip('\n')
        if not line: continue
        p=line.split('\t')
        while len(p)<4: p.append('')
        i=int(p[0]); assert i not in pc,(f,i); pc[i]=p[1:]
assert sorted(pc)==list(range(len(rows))),set(range(len(rows)))-set(pc)
pig_over={176:('Done','0.5 presets-panels (working tree): Styles panel, Layer Style dialog Styles page, New Style, Make Default / Reset to Default, .asl import; was Partial. Gap: Make Default does not keep patterns')}
depth={38:'photocraft',40:'photocraft',42:'photocraft',199:'photocraft',200:'photocraft',7:'pigment',22:'pigment'}
rank={'Done':3,'Partial':2,'Approximate':2,'Missing':0,'Not feasible':0}
valid=set(rank)
out=open('map/image-layer.jsonl','w')
for i,r in enumerate(rows):
    st,ev,note=pc[i]
    assert st in valid,(i,st)
    pg=r['status']; pn=''
    if i in pig_over: pg,pn=pig_over[i]
    assert pg in valid,(i,pg)
    a,b=rank[pc[i][0]],rank[pg]
    if a==0 and b==0: ah='neither'
    elif a>b: ah='photocraft'
    elif b>a: ah='pigment'
    else: ah=depth.get(i,'same')
    o={"page":"image-layer","section":r['section'],"feature":r['feature'],"pigment":pg}
    if pn: o["pigmentNote"]=pn
    o.update({"photocraft":st,"evidence":ev,"note":note,"ahead":ah})
    out.write(json.dumps(o,ensure_ascii=False)+'\n')
out.close()
L=[json.loads(l) for l in open('map/image-layer.jsonl')]
print(len(L))
for k in ('pigment','photocraft','ahead'):
    print(k,collections.Counter(x[k] for x in L))
