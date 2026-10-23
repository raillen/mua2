# Ferramentas de extração — MUA2 PC (Alchemy 6 / IGZ v6)

Este diretório contém o pipeline usado para gerar os `.glb` e a galeria VFX.

> Os arquivos do jogo já foram extraídos em `../../_work/extracted`.
> Você só precisa rodar os passos 2–5 se quiser reextrair/alterar algo.

## 1. Do ISO aos arquivos do jogo

O ISO é um instalador Codex (Inno Setup) com um `setup-1.bin` FreeArc
comprimido em `rep + 4x4:lz4`. O fluxo usado foi:

1. `7z x "Marvel Ultimate Alliance 2.iso" setup.exe setup-1.bin`
2. Extrair o bloco sólido FreeArc (arquivo `setup-1.bin`) com o
   `tools/extract.cpp` + a biblioteca de codecs do
   [FreeArc-ex](https://github.com/YadeWira/FreeArc-ex) (o LZ4 antigo precisa
   ser compilado como **C**, não C++).
3. Separar o bloco sólido nos arquivos usando o diretório FreeArc
   (`tools/split_solid.py`).

Resultado: `actors.bin`, `models.bin`, `materials.bin`, `textures.bin`,
`anims.bin`, `effects_igx.bin`, etc.

Se você já tem esses `.bin`, pule para o passo 2.

## 2. `.bin` → `.igz`

Os `.bin` são arquivos Zoe Mode: header de 0x1C bytes, índice e nomes
comprimidos com zlib e cada bloco XOR-encriptado com uma LCG baseada no
tamanho comprimido. O `mua2bin` faz tudo:

```bash
g++ -O2 -std=c++17 -D_FILE_OFFSET_BITS=64 mua2bin.cpp -lz -o mua2bin

./mua2bin ../../_work/extracted/actors.bin    ../../_work/igz_actors
./mua2bin ../../_work/extracted/models.bin    ../../_work/igz
./mua2bin ../../_work/extracted/materials.bin ../../_work/igz_materials
./mua2bin ../../_work/extracted/textures.bin  ../../_work/igz_textures
./mua2bin ../../_work/extracted/effects_igx.bin ../../_work/igz_effects
```

## 3. Indexar texturas

```bash
export IGB_PKG=/caminho/para/igb_pkg   # veja "Dependência" abaixo
export MUA2_WORK=../../_work
python3 index_textures.py
```

Gera `texture_index.json`: hash de 64 bits → arquivo IGZ, largura, altura,
formato (DXT1/DXT5/ATI2) e offset dos pixels. O hash vem do `igHandleList`
do `igImage2`; ele é o que liga o material do ator à textura.

## 4. IGZ → GLB

```bash
python3 mua2_glb.py ../../_work/igz_actors/0901.igz \
    ../assets/models/spiderman.glb spiderman
```

O script:

- anda na cena `igGroup → igAttrSet → igBlendMatrixSelect → igGeometry`;
- lê os `igTextureBindAttr2` (unit 0 = diffuse, 1 = normal, 2 = specular);
- extrai posições/normais/UVs/índices do VB/IB;
- decodifica as texturas (DXT1 no modo **4 cores**, DXT5 e ATI2/BC5);
- preenche o fundo cinza do atlas por *inpainting* (vizinho mais próximo);
- grava um GLB com texturas embutidas, eixo Y para cima e escala normalizada.

Para exportar o lote de 12 personagens:

```bash
python3 export_all.py
```

## 5. VFX

```bash
python3 index_effects.py     # lê igz_effects/**, gera thumbs e effects.json
```

A galeria usa `assets/vfx/effects_curated.json`. Cada efeito lista as
texturas `.tga` referenciadas no IGZ; a animação no viewer é apenas um
preview visual, não o grafo de partículas original.

## Dependência: parser IGZ

O parser IGZ v6 usado é o do projeto
[igb-blender](https://github.com/KaikoClanworth1/igb-blender) (GPL-3.0).
Ele **não** está vendorizado aqui. Para usar:

```bash
git clone https://github.com/KaikoClanworth1/igb-blender.git
mkdir -p /tmp/opencode/igb_pkg/igb_blender
touch /tmp/opencode/igb_pkg/igb_blender/__init__.py
ln -s "$PWD/igb-blender/igz_format"   /tmp/opencode/igb_pkg/igb_blender/igz_format
ln -s "$PWD/igb-blender/scene_graph"  /tmp/opencode/igb_pkg/igb_blender/scene_graph
ln -s "$PWD/igb-blender/igb_format"   /tmp/opencode/igb_pkg/igb_blender/igb_format
ln -s "$PWD/igb-blender/utils"        /tmp/opencode/igb_pkg/igb_blender/utils
export IGB_PKG=/tmp/opencode/igb_pkg
```

Dependências Python: `numpy`, `scipy`, `Pillow`.


## Verificar o alinhamento UV/textura

`verify_uv_alignment.py` rasteriza as ilhas UV da malha por cima da arte da
textura e reporta o melhor deslocamento e a sobreposição. Serve para
detectar o bug do `data_off` (offset != 0) e para conferir um material novo:

```bash
export IGB_PKG=/caminho/para/igb_pkg
export MUA2_WORK=../../_work
python3 verify_uv_alignment.py ../../_work/igz_actors/0901.igz 0 spiderman_anti_1_d.igz
# esperado: best overlap ~0.91 em offset dx=0 dy=0 texels
```

Se o offset sair diferente de zero, o `data_off` da textura está errado
(o tamanho da cadeia de mips precisa usar a contagem real de mips).

## Notas técnicas

- O `igImage2` de MUA2 tem hash em `+0x48` (64-bit), não `+0x3C`.
- **O tamanho da cadeia de mips tem que usar a contagem real de mips**
  (`igImage2` em `+0x1A`). Calcular a cadeia até 1x1 em vez de usar o
  numero de mips do arquivo acrescenta niveis extras no fim, o que
  adianta `data_off` em um multiplo exato de blocos DXT (23 blocos = 92
  texels). Resultado: **toda textura decodificava deslocada 92 texels
  para o lado**, e as ilhas UV da malha paravam de bater com a arte
  (manchas cinzas no corpo, textura "errada" em todo personagem).
  O sintoma era simetrico no eixo U e nas ilhas, o que descartou
  flip/orientacao e apontou para o offset do pixel buffer.
- O campo de unidade do `igTextureBindAttr2` fica em `+0x10 & 0xffff`
  (64-bit); 0=diffuse, 1=normal, 2=specular, 3=cubemap, 4=mask.
- DXT1 do jogo usa **sempre 4 cores**; o modo padrão 3 cores + alpha
  produz ruído preto nas texturas.
- O bloco FreeArc usa `rep:64mb:h28:a99+4x4:lz4`; o descritor tem CRC
  não-padrão (não valide; use os offsets).
- Os atores são arquivos numéricos (`0901.igz` = Spider-Man, `1501.igz` =
  Iron Man, etc.). O mapeamento ator → personagem é feito pelas texturas
  referenciadas (`spiderman_anti_1`, `ironman_pro_1`, ...).

## Aviso

Assets © Marvel / Activision / Vicarious Visions. Use apenas com uma cópia
legítima do jogo e para uso pessoal. Não redistribua os arquivos extraídos.
