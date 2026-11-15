import json,re
d=json.load(open('pc_cmds.json'))
for k,v in d.items():
    if not v['defs']: continue
    f,ln=v['defs'][0].split(':')[:2]; ln=int(ln)
    L=open(f).read().splitlines()
    chunk=' '.join(x.strip() for x in L[ln-1:ln+6])
    i=chunk.find('r#'); 
    if i<0: i=chunk.find('r"')
    if i>=0: print(k,'::',chunk[i:i+700]); 
