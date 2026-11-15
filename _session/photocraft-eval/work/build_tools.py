import json
exec(open('tools_pc.py').read())
rows=json.load(open('tools_rows.json'))
assert len(rows)==175 and len(D)==175
rank={'Done':3,'Partial':2,'Approximate':2,'Missing':0,'Not feasible':0}
EQ={27:'photocraft',114:'pigment',20:'photocraft',126:'photocraft',141:'photocraft',64:'photocraft'}
out=open('../map/tools.jsonl','w')
for i,x in enumerate(rows,1):
    pc,ev,note,ov,pn=D[i]
    pig=x['status']; pnote=''
    if ov:
        pnote=pn if ov!=pig or pn else ''
        pig=ov
    a,b=rank[pc],rank[pig]
    if a>b: ah='photocraft'
    elif b>a: ah='pigment'
    elif a==0: ah='neither'
    else: ah=EQ.get(i,'same')
    o={"page":"tools","section":x['section'],"feature":x['feature'],"pigment":pig}
    if pnote: o["pigmentNote"]=pnote
    o.update({"photocraft":pc,"evidence":ev,"note":note,"ahead":ah})
    out.write(json.dumps(o,ensure_ascii=False)+'\n')
out.close()
