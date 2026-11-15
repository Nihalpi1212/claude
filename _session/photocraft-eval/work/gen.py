import json,sys
sys.path.insert(0,'work')
from pw_data import *
rank={'Done':3,'Partial':2,'Approximate':2,'Missing':0,'Not feasible':-1}
def rows(f):
    sec=None;out=[]
    for line in open(f):
        if line.startswith('## '): sec=line[3:].strip()
        if line.startswith('| ') and not line.startswith('| Feature') and not line.startswith('|---'):
            c=[x.strip() for x in line.strip().strip('|').split('|')]
            out.append((sec,c[0],c[2]))
    return out
def ahead(pg,pc,ov):
    if ov: return ov
    if pg==pc and pg in ('Missing','Not feasible'): return 'neither'
    if pg in ('Missing','Not feasible') and pc in ('Missing','Not feasible'): return 'neither'
    rp,rc=rank[pg],rank[pc]
    if rp>rc: return 'pigment'
    if rc>rp: return 'photocraft'
    return 'same'
res=[]
base='/home/user/claude/pigment/docs/parity/'
for page,data,ovr,aov in [('panels-workspace',PW,PWOV,AHEAD_PW),('more',MORE,MOREOV,AHEAD_MORE)]:
    rs=rows(base+page+'.md')
    assert len(rs)==len(data),(page,len(rs),len(data))
    for i,(sec,feat,st) in enumerate(rs,1):
        pc,ev,note=data[i]
        pg=st;pn=''
        if i in ovr: pg,pn=ovr[i]
        a=aov.get(i)
        o={"page":page,"section":sec,"feature":feat,"pigment":pg}
        if pn: o["pigmentNote"]=pn
        o.update({"photocraft":pc,"evidence":ev,"note":note,"ahead":ahead(pg,pc,a)})
        res.append(o)
with open('map/panels-workspace.jsonl','w') as f:
    for o in res: f.write(json.dumps(o,ensure_ascii=False)+'\n')
from collections import Counter
print(len(res))
print('pigment',Counter(o['pigment'] for o in res))
print('photocraft',Counter(o['photocraft'] for o in res))
print('ahead',Counter(o['ahead'] for o in res))
