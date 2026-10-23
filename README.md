# Marvel Ultimate Alliance 2 — extração de assets + viewer three.js

Este diretório contém o resultado da extração dos modelos 3D, texturas e
efeitos do **Marvel: Ultimate Alliance 2 (PC, 2016)**, além de um viewer
interativo em three.js.

## Começar por aqui

```bash
cd mua2-viewer
./start.sh
# abra http://localhost:8088
```

![Personagens](mua2-viewer/contact_sheet.png)

## O que foi extraído

| Pacote | Conteúdo | Onde está |
|---|---|---|
| `actors.bin` | 327 modelos de atores/personagens (`.igz`) | `_work/igz_actors` |
| `models.bin` | 5.341 modelos de cenário/props/efeitos | `_work/igz` |
| `materials.bin` | 7.028 texturas/materiais | `_work/igz_materials` |
| `textures.bin` | 1.817 texturas de UI/efeitos | `_work/igz_textures` |
| `effects_igx.bin` | 5.333 definições de VFX | `_work/igz_effects` |
| `anims.bin` | animações (não convertidas) | `_work/extracted` |

O viewer inclui **184 personagens, variantes, NPCs e props** em glTF 2.0 com diffuse + normal map
(Spider-Man, Iron Man, Wolverine, Capitão América, Hulk, Deadpool, Thor,
Venom, Magneto, Storm, Psylocke e Sr. Fantástico) e uma **galeria VFX**
com 54 efeitos e suas texturas originais.

## Pipeline

```
ISO → setup-1.bin (FreeArc 4x4+LZ4+REP) → .bin do jogo
    → .igz (Alchemy 6 / IGZ v6) → glTF 2.0 → three.js
```

Detalhes e ferramentas: [`mua2-viewer/tools/README.md`](mua2-viewer/tools/README.md).

## Limitações

- Modelos com **esqueleto e skinning completos** (glTF `skins` com hierarquia de ossos e pesos de 4 influências por vértice). Animações do jogo catalogadas em Havok `.hkx` (447 arquivos).
- VFX: a galeria mostra as texturas e definições; o grafo de partículas
  original ainda não é simulado.
- Texturas corrigidas: o `data_off` do pixel buffer estava adiantado em
  23 blocos DXT por causa do cálculo da cadeia de mips, o que deslocava
  toda textura 92 texels de lado e desalinhava as ilhas UV da arte.
- Uniformes alternativos (`Alt`/`Anti`) são variantes reais do jogo.

## Aviso legal

Os assets são © Marvel / Activision / Vicarious Visions. Use apenas com uma
cópia legítima do jogo, para uso pessoal/estudo. Não redistribua os arquivos
extraídos.
