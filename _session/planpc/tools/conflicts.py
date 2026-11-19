import sys
MAX = int(sys.argv[1])
for path in sys.argv[2:]:
    lines = open(path, errors="replace").read().split("\n")
    print(f"######## {path}")
    i = 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<<"):
            ours, theirs, side = [], [], "o"
            start = i
            i += 1
            while i < len(lines) and not lines[i].startswith(">>>>>>>"):
                if lines[i].startswith("======="):
                    side = "t"
                elif side == "o":
                    ours.append(lines[i])
                else:
                    theirs.append(lines[i])
                i += 1
            print(f"--- conflict at line {start+1}: ours {len(ours)} lines, theirs {len(theirs)} lines")
            for l in ours[:MAX]:
                print("  O| " + l[:200])
            if len(ours) > MAX:
                print("  O| ...")
            for l in theirs[:MAX]:
                print("  T| " + l[:200])
            if len(theirs) > MAX:
                print("  T| ...")
        i += 1
