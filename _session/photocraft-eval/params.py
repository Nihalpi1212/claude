import json,re
d=json.load(open('pc_cmds.json'))
for k,v in d.items():
    if not v['defs']: continue
    f,ln=v['defs'][0].split(':')[:2]; ln=int(ln)
    L=open(f).read().splitlines()
    chunk=' '.join(x.strip() for x in L[ln-1:ln+7])
    m=re.search(r'r#*"(.*?)"#*',chunk)
    print(k,'::',(m.group(1)[:400] if m else chunk[:300]))
