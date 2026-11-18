#!/bin/bash
# End to end: pigment-cli ai status / set-key / consent, and run --cmd ai.generativeFill --allow-ai
# against a mock provider on 127.0.0.1. Nothing reaches the network.
set -u
D=/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/final
CLI=/home/user/claude/pigment/target/debug/pigment-cli
APP=/home/user/claude/pigment/target/debug/pigment
W=$(mktemp -d "$D/e2e.XXXXXX")
KEY="sk-final-check-0123456789abcdefQRST"
mkdir -p "$W/settings" "$W/launcher"
: >"$W/requests.jsonl"
python3 "$D/mock_provider.py" "$W/port" "$KEY" "$W/requests.jsonl" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for i in $(seq 50); do [ -s "$W/port" ] && break; sleep 0.1; done
PORT=$(cat "$W/port")
export PHOTOCRAFT_CONFIG_DIR="$W/settings" CRAFT_MCP_DIR="$W/launcher" CRAFT_FLAGS_FILE="$W/flags.toml"
export PIGMENT_AI_BASE_URL_OPENAI="http://127.0.0.1:$PORT/v1"
unset PIGMENT_AI_BASE_URL_GEMINI CRAFT_FLAGS
export TMPDIR=/dev/shm/pt
n() { wc -l <"$W/requests.jsonl"; }
show() { echo; echo "\$ $*"; }
cd "$W"

show "pigment --version; pigment-cli --version"
"$APP" --version; echo "exit $?"
"$CLI" --version; echo "exit $?"

show "pigment-cli ai status   (fresh settings folder)"
"$CLI" ai status; echo "exit $?  requests so far: $(n)"

show "pigment-cli ai set-key openai KEY   (a key in argv must be refused)"
"$CLI" ai set-key openai "$KEY" </dev/null; echo "exit $?  requests so far: $(n)"

show "printf KEY | pigment-cli ai set-key openai"
printf '%s\n' "$KEY" | "$CLI" ai set-key openai >"$W/setkey.out" 2>"$W/setkey.err"; echo "exit $?  requests so far: $(n)"
cat "$W/setkey.out" "$W/setkey.err"
grep -c "$KEY" "$W/setkey.out" "$W/setkey.err" | sed 's/^/key printed (count): /'
ls -l "$W/settings" | sed 's/^/  /'
stat -c 'ai-keys.json mode %a' "$W/settings/ai-keys.json"

show "pigment-cli ai status --json"
"$CLI" ai status --json | tee "$W/status.json"; echo "exit $?"
grep -c "$KEY" "$W/status.json" | sed 's/^/key in status (count): /'

RUN=(run --new '{"width":64,"height":32}' --cmd select.rect --params '{"x":8,"y":8,"width":16,"height":8}' --cmd ai.generativeFill --params '{"prompt":"a magenta box"}')

show "pigment-cli run ... ai.generativeFill   (no --allow-ai: refused, nothing sent)"
b=$(n); "$CLI" "${RUN[@]}" --out "$W/refused.png"; echo "exit $?  new requests: $(( $(n) - b ))  out exists: $([ -e "$W/refused.png" ] && echo yes || echo no)"

show "pigment-cli run ... --allow-ai   (no agreement yet: refused, nothing sent)"
b=$(n); "$CLI" "${RUN[@]}" --out "$W/noconsent.png" --allow-ai; echo "exit $?  new requests: $(( $(n) - b ))  out exists: $([ -e "$W/noconsent.png" ] && echo yes || echo no)"

show "pigment-cli ai consent"
"$CLI" ai consent; echo "exit $?"

show "pigment-cli run ... --allow-ai --out out.png"
b=$(n); "$CLI" "${RUN[@]}" --out "$W/out.png" --allow-ai; echo "exit $?  new requests: $(( $(n) - b ))"
show "pigment-cli run ... --allow-ai --out out.pigment; pigment-cli info out.pigment"
"$CLI" "${RUN[@]}" --out "$W/out.pigment" --allow-ai; echo "exit $?"
"$CLI" info "$W/out.pigment" | head -30

show "the image: out.png"
python3 - "$W/out.png" <<'PY'
import struct, sys, zlib
data = open(sys.argv[1], 'rb').read()
assert data[:8] == b'\x89PNG\r\n\x1a\n'
pos, idat = 8, b''
while pos < len(data):
    n, t = struct.unpack('>I4s', data[pos:pos+8]); body = data[pos+8:pos+8+n]; pos += 12 + n
    if t == b'IHDR': w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
    if t == b'IDAT': idat += body
raw = zlib.decompress(idat)
ch = {2: 3, 6: 4, 0: 1, 4: 2}[ctype]; bpp = ch * depth // 8; stride = w * bpp
rows, prev = [], bytes(stride)
for y in range(h):
    f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
        if f == 1: line[i] = (line[i] + a) & 255
        elif f == 2: line[i] = (line[i] + b) & 255
        elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(bytes(line)); prev = line
px = lambda x, y: tuple(rows[y][x * bpp:x * bpp + ch])
print(f"PNG {w} x {h}, {depth}-bit, colour type {ctype}")
print("inside the selection (16,12):", px(16, 12))
print("outside it (2,2):", px(2, 2), " (40,20):", px(40, 20))
inside = sum(1 for y in range(h) for x in range(w) if px(x, y)[:3] == (255, 0, 255))
print("magenta pixels:", inside, "(the selection is 16 x 8 = 128)")
PY

show "pigment-cli ai test openai"
"$CLI" ai test openai; echo "exit $?"
show "pigment-cli ai clear-key openai; pigment-cli ai status"
"$CLI" ai clear-key openai; echo "exit $?"
"$CLI" ai status; echo "exit $?"
ls -l "$W/settings" | sed 's/^/  /'
cat "$W/settings/ai.json" 2>/dev/null; echo
grep -rc "$KEY" "$W/settings" 2>/dev/null | sed 's/^/key left in settings (file:count): /'

show "what the mock provider received"
cat "$W/requests.jsonl"
echo "work folder: $W"
