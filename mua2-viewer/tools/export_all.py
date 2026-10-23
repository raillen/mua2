#!/usr/bin/env python3
import subprocess, json, os, sys
ROOT=os.environ.get('MUA2_ROOT','/home/raillen/Documentos/decomp-games')
OUT=f'{ROOT}/mua2-viewer/assets/models'
os.makedirs(OUT, exist_ok=True)
chars=[
 ('spiderman','Spider-Man','0901.igz','#e62429'),
 ('ironman','Iron Man','1501.igz','#f0b429'),
 ('wolverine','Wolverine','0301.igz','#f5c542'),
 ('captainamerica','Capitão América','0701.igz','#3b6fd4'),
 ('hulk','Hulk','7801.igz','#57b84a'),
 ('deadpool','Deadpool','1701.igz','#c62828'),
 ('thor','Thor','1001.igz','#8fb8ff'),
 ('venom','Venom','1201.igz','#9b59b6'),
 ('magneto','Magneto','16201.igz','#c0392b'),
 ('storm','Storm','0401.igz','#dfe6f0'),
 ('psylocke','Psylocke','16401.igz','#b06ab3'),
 ('mrfantastic','Sr. Fantástico','2001.igz','#4a90d9'),
]
models=[]
for cid,name,actor,accent in chars:
    glb=f'{OUT}/{cid}.glb'
    print("===",cid,actor,flush=True)
    r=subprocess.run([sys.executable,'/tmp/opencode/mua2_glb.py',
                      f'{ROOT}/_work/igz_actors/{actor}', glb, cid],
                     capture_output=True,text=True)
    if r.returncode!=0:
        print(r.stdout[-2000:], r.stderr[-2000:]); continue
    info=json.loads(r.stdout)
    models.append({
        'id':cid,'name':name,'file':f'assets/models/{cid}.glb',
        'source':f'actors/{actor}','textures':info['textures'],
        'verts':info['verts'],'tris':info['tris'],'accent':accent,
    })
    print(" ",info['parts'],"parts",info['tris'],"tris",info['textures'],"tex",f"{info['size']/1e6:.1f}MB",flush=True)
json.dump({'models':models},open(f'{OUT}/models.json','w'),indent=2)
print("wrote models.json",len(models))
