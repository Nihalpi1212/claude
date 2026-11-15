import sys, json
path = sys.argv[1]
pairs = json.load(open(sys.argv[2]))
s = open(path, encoding='utf-8').read()
before = len(s)
bad = 0
for old, new in pairs:
    n = s.count(old)
    if n != 1:
        print('MATCH', n, ':', old[:80].replace('\n', '\\n'))
        bad += 1
        continue
    s = s.replace(old, new)
if bad:
    print('not applied; fix', bad)
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(s)
print('ok', before, '->', len(s))
