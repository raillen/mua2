#!/usr/bin/env python3
"""Re-export every model in models.json (after the texture data_off fix)."""
import subprocess, json, os, sys

ROOT = os.environ.get('MUA2_ROOT', '/home/raillen/Documentos/decomp-games')
WORK = os.environ.get('MUA2_WORK', f'{ROOT}/_work')
OUT = f'{ROOT}/mua2-viewer/assets/models'
p = f'{OUT}/models.json'
models = json.load(open(p))['models']
models = [m for m in models if not m['id'].startswith(('sp_', 'fix_'))]
print(len(models), 'models to re-export', flush=True)

ok = 0
for i, m in enumerate(models):
    actor = m['source'].split('/')[-1]
    if not actor.endswith('.igz'):
        actor += '.igz'
    src = f'{WORK}/igz_actors/{actor}'
    if not os.path.exists(src):
        print(f'  MISSING {m["id"]} {src}', flush=True)
        continue
    glb = f'{OUT}/{m["id"]}.glb'
    res = subprocess.run(
        [sys.executable, '/tmp/opencode/mua2_glb.py', src, glb, m['id'],
         '--max-texture', '512'],
        capture_output=True, text=True)
    if res.returncode != 0:
        print(f'  FAILED {m["id"]}: {res.stdout[-200:]} {res.stderr[-200:]}', flush=True)
        continue
    try:
        info = json.loads(res.stdout)
    except Exception as e:
        print(f'  BAD {m["id"]}: {e}', flush=True)
        continue
    m['textures'] = info['textures']
    m['verts'] = info['verts']
    m['tris'] = info['tris']
    m['file'] = f'assets/models/{m["id"]}.glb?v=6'
    ok += 1
    if (i + 1) % 20 == 0:
        json.dump({'models': models}, open(p, 'w'), indent=2)
        print(f'  {i+1}/{len(models)} ok={ok}', flush=True)

json.dump({'models': models}, open(p, 'w'), indent=2)
print(f'done: {ok}/{len(models)} re-exported')
