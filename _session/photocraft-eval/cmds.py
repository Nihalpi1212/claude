import re,subprocess,json,sys
cat=open('/home/user/storytold/photocraft/crates/ui-egui/src/menu_catalog.rs').read()
ids=[]
for m in re.finditer(r'\(&\[([^\]]*)\], "([^"]*)", (?:Some\("[^"]*"\)|None), "([^"]*)"\)',cat):
    path=m.group(1); lab=m.group(2); cid=m.group(3)
    if cid=='---': continue
    if '"File"' in path.split(',')[0] or '"Edit"' in path.split(',')[0]:
        ids.append((path.replace('"',''),lab,cid))
out={}
for path,lab,cid in ids:
    r=subprocess.run(['rg','-n','--no-heading','-g','!*tests*','-g','!*test*','-F','"%s"'%cid,'/home/user/storytold/photocraft/crates'],capture_output=True,text=True).stdout.splitlines()
    defs=[l for l in r if re.search(r'(spec!\(|id: |^\S+:\d+:\s*"%s",\s*$)'%re.escape(cid),l)]
    out[cid]=dict(label=lab,path=path,defs=defs[:4],nrefs=len(r))
json.dump(out,open('pc_cmds.json','w'),indent=1)
for k,v in out.items():
    print(k,'|',v['nrefs'],'|',(v['defs'][0][len('/home/user/storytold/photocraft/'):][:160] if v['defs'] else 'NODEF'))
