#!/usr/bin/env python3
"""Resume splitting the decoded MUA2 solid block into files."""
import os, sys

DIRBLOCK = "/tmp/opencode/dirblock.bin"
SOLID = sys.argv[1] if len(sys.argv) > 1 else "solid.bin"
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else "extracted"

b = open(DIRBLOCK, "rb").read()
pos = 0

def ri():
    global pos
    x = int.from_bytes(b[pos:pos+4].ljust(4, b'\0'), 'little')
    if x & 1 == 0: v = (x & 0xff) >> 1; pos += 1; return v
    if x & 3 == 1: v = (x & 0xffff) >> 2; pos += 2; return v
    if x & 7 == 3: v = (x & 0xffffff) >> 3; pos += 3; return v
    if x & 15 == 7: v = x >> 4; pos += 4; return v
    y = int.from_bytes(b[pos:pos+8].ljust(8, b'\0'), 'little')
    if x & 31 == 15: v = (y & ((1 << 40) - 1)) >> 5; pos += 5; return v
    if x & 63 == 31: v = (y & ((1 << 48) - 1)) >> 6; pos += 6; return v
    if x & 127 == 63: v = (y & ((1 << 56) - 1)) >> 7; pos += 7; return v
    if x & 255 == 127: v = y >> 8; pos += 8; return v
    pos += 1
    y = int.from_bytes(b[pos:pos+8].ljust(8, b'\0'), 'little'); pos += 8
    return y

def rs():
    global pos
    e = b.index(0, pos)
    s = b[pos:e].decode('latin1')
    pos = e + 1
    return s

nb = ri()
nf = [ri() for _ in range(nb)]
comps = [rs() for _ in range(nb)]
offs = [ri() for _ in range(nb)]
cs = [ri() for _ in range(nb)]
nd = ri()
dirs = [rs() for _ in range(nd)]
n = sum(nf)
names = [rs() for _ in range(n)]
dirnums = [ri() for _ in range(n)]
sizes = [ri() for _ in range(n)]
pos += 4 * n
is_dir = b[pos:pos+n]; pos += n
pos += 4 * n

os.makedirs(OUTDIR, exist_ok=True)
src = open(SOLID, "rb")
offset = 0
written_now = 0
skipped = 0
missing = 0

for i in range(n):
    d = dirs[dirnums[i]] if dirnums[i] < len(dirs) else ""
    name = names[i]
    rel = (d + "/" + name) if d else name
    rel = rel.replace("\\", "/")
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    path = os.path.join(OUTDIR, *parts)
    parent = os.path.dirname(path)

    size = sizes[i]
    if is_dir[i] and size == 0:
        os.makedirs(path, exist_ok=True)
        continue
    if parent:
        os.makedirs(parent, exist_ok=True)

    ok = os.path.isfile(path) and os.path.getsize(path) == size
    if ok:
        skipped += 1
    else:
        src.seek(offset)
        left = size
        with open(path, "wb") as out:
            while left:
                chunk = src.read(min(left, 8 * 1024 * 1024))
                if not chunk:
                    raise SystemExit(f"solid exhausted at entry {i} ({rel}), {left} bytes missing")
                out.write(chunk)
                left -= len(chunk)
        written_now += size
        missing += 1
    offset += size
    if (i + 1) % 250 == 0:
        print(f"{i+1}/{n}  offset={offset/1e9:.2f}GB  rewritten={missing}  kept={skipped}", flush=True)

print(f"done: {n} entries, {offset} bytes (expected {sum(sizes)}), rewritten={missing}, kept={skipped}")
