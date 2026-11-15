import json,sys
rows=[];sec=None
for line in open('/home/user/claude/pigment/docs/parity/file-edit.md'):
    if line.startswith('## '): sec=line[3:].strip(); continue
    if line.startswith('|') and not line.startswith('| Feature') and not line.startswith('|---'):
        cells=[c.strip() for c in line.strip().strip('|').split(' | ')]
        rows.append(dict(section=sec,feature=cells[0],where=cells[1],status=cells[2],inp=cells[3],planned=cells[5] if len(cells)>5 else ''))
json.dump(rows,open('fe_rows.json','w'),indent=0)
print(len(rows))
