import json
exec(open('pc_rows.py').read())
rows=json.load(open('fe_rows.json'))
PIG={
 2:('Done','0.5 brush-painting-behaviours: Other Cursors (Standard/Precise), brush preview colour and brush leash colour in Preferences'),
 21:('Done','0.5 brush-painting-behaviours: Standard, Precise, Normal and Full Size Brush Tip, crosshair in tip, only crosshair while painting'),
 56:('Partial','0.5 psd-layers + icc-engine: now reads layer effects, Blending Options, vector masks, shape and fill layers, ICC profile; still no smart objects, 16/32-bit, CMYK/Lab modes, alpha/spot channels, artboards, comps'),
 58:('Partial','0.5 psd-layers: now writes effects, Blending Options, vector masks, live shapes, fill layers, Maximize Compatibility; still 8-bit RGB, smart objects and channels lost'),
 125:('Done','0.5 icc-engine: Don\'t Color Manage, Working RGB, any RGB/Gray profile; one history step'),
 128:('Done','0.5 icc-engine: Color Profile list in New Document'),
 131:('Done','0.5 preset-files-manager: Export/Import Presets (.pigment-bundle) and Migrate Presets'),
 132:('Done','0.5 preset-files-manager: Preset Manager for every preset kind'),
 133:('Partial','0.5 preset-files-manager + brush-settings-panel: .abr, .pat, .grd, .aco, .ase, .csh, .asl, .tpl read and written; .atn not read'),
 187:('Done','0.5 presets-panels: Edit > Define Custom Shape from a path'),
 190:('Done','0.5 brush-engine-core: Edit > Define Brush Preset from the selection'),
}
rank={'Done':3,'Partial':2,'Approximate':2,'Missing':0,'Not feasible':0}
out=open('map/file-edit.jsonl','w')
for i,x in enumerate(rows):
    pc,ev,note,ov=P[i]
    pg=x['status']; pn=''
    if i in PIG: pg,pn=PIG[i]
    a,b=rank[pc],rank[pg]
    if a==0 and b==0: ahead='neither'
    elif a>b: ahead='photocraft'
    elif b>a: ahead='pigment'
    else: ahead=ov or 'same'
    if ov and not(a==0 and b==0) and a==b: ahead=ov
    o=dict(page='file-edit',section=x['section'],feature=x['feature'],pigment=pg)
    if pn: o['pigmentNote']=pn
    o.update(photocraft=pc,evidence=ev,note=note,ahead=ahead)
    out.write(json.dumps(o,ensure_ascii=False)+'\n')
out.close()
