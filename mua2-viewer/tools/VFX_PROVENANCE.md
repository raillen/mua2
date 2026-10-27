# Alchemy Engine IGZ v6 VFX Binary Layout & Decompilation Provenance

## 1. Executive Summary & Binary Target

- **Target Binary**: *Marvel: Ultimate Alliance 2* (PC / x64, 2016 re-release), `_work/extracted/Alliance.exe`
- **Engine**: Alchemy Engine (Vicarious Visions / n-Space), File Container Version 6 (`IGZ\x01`)
- **Asset Scope**: 5,333 effect files located in `_work/igz_effects/**/*.igz`
- **Catalog Output**: `mua2-viewer/assets/vfx/effects.json.gz` (~1.8 MB comprimido de ~56 MB de JSON; o viewer descomprime no cliente)
- **Catalog Format**: `mua2_vfx_catalog_v1`
- **Scan Statistics**:
  - Total scanned: 5,333
  - Full decoded: 5,235
  - Partial (isolated primitives or empty effect templates): 98
  - Metadata-only: 0
  - Errors: 0
  - Textures exported (collision-free 16-hex hash): 518

---

## 2. IGZ v6 Container Structure

Alchemy IGZ v6 files package engine metadata, compiled classes, object instances, and runtime fixup relocations into aligned chunks.

### 2.1 File Header

```
Offset  Type     Field
0x00    uint32   Magic (0x49475A01 -> "IGZ\x01")
0x04    uint32   Version (6)
0x08    uint32   Platform (2 = x64 LE)
0x0C    uint32   Pad / Flags
```

### 2.2 Chunk Descriptor Table

Immediately follows the file header at `0x10`. Table consists of 16-byte records terminated by a record with `offset == 0`:

```
Offset  Type     Field
0x00    uint32   Offset in file (bytes)
0x04    uint32   Size of chunk (bytes)
0x08    uint32   Alignment (e.g. 16 or 4096)
0x0C    uint32   Identifier / Flags
```

- **Chunk 0**: Metadata and fixup dictionary section.
- **Chunk 1+**: Object instance data buffers and binary resource payloads.

### 2.3 Section 0 (Fixup Header & Tagged Blocks)

Section 0 begins at `chunks[0].offset`. The inner header is 28 bytes (`0x1C`):

```
Offset  Type     Field
0x00    uint32   Inner Magic (0x49475A01)
0x04    uint32   Unknown 1
0x08    uint32   Unknown 2
0x0C    uint32   Unknown 3
0x10    uint32   Number of Tagged Blocks
0x14    uint32   Reserved
0x18    uint32   Reserved
```

Each tagged block consists of a 24-byte (`0x18`) header followed by block data:

```
Offset  Type     Field
0x00    uint32   Tag ID
0x04    uint32   Param 1
0x08    uint32   Param 2
0x0C    uint32   Item Count
0x10    uint32   Total Size (bytes, including header)
0x14    uint32   Header Size (24 bytes)
```

#### Known Tag Identifiers

| Tag ID | Name | Description |
|---|---|---|
| 0 | `TMET` | Type metadata names (ASCII strings identifying Alchemy classes) |
| 1 | `TSTR` | String pool (null-terminated ASCII texture paths, node names, shader IDs) |
| 2 | `EXNM` | Export names |
| 4 | `RSTT` | String reference fixups (locations in objects pointing into `TSTR`) |
| 5 | `RVTB` | Object definition fixups (vtable/type index pointers defining object instances) |
| 6 | `ROFS` | Object reference fixups (pointers connecting one object to another) |
| 7 | `REXT` | External reference fixups |
| 8 | `ROOT` | Root object offsets |
| 9 | `ONAM` | Object names |
| 11 | `EXID` | Export IDs |
| 12 | `RHND` | Resource handle fixups |
| 13 | `MTSZ` | Type metadata sizes (allocation byte size for each type in `TMET`) |
| 14 | `NSPC` | Namespace table |
| 16 | `RPID` | Resource pool IDs |

### 2.1 String Pool (`TSTR`) Encoding & Parsing Rules

The string pool block (`tag == 1`) contains `count` null-terminated ASCII strings stored sequentially:
- **Null-Byte Handling**: An empty string is encoded as a single `0x00` byte. It is not padded or aligned to 2-byte or 4-byte boundaries.
- **Parser Invariant**: Parsers must strictly increment by `np + 1` (advancing past the terminating null byte). Skipping subsequent null bytes (e.g. attempting to skip presumed word padding) drops valid empty strings from the table, shifting table indices for all subsequent strings.
- **Binary Impact**: Skipping padding nulls corrupts string tables in 2,068 files and shifts string values in 4,257 files across the 5,333 MUA2 `.igz` effect files, causing lookup-table (`LUT`) texture paths or texture filenames to be misread as shader names or audio banks.

---

## 3. Relocation & Fixup Decoding

Fixup offsets in `RVTB`, `ROFS`, and `RSTT` are stored as compressed variable-length delta-nibble streams.

### 3.1 Delta-Nibble Stream Unpacking

Each byte contains two 4-bit nibbles (processed low nibble first, then high nibble):
- Bits 0-2 (mask `0x07`): Value payload (3 bits per nibble, accumulated with `shift += 3`).
- Bit 3 (mask `0x08`): Continuation flag (`1` = more nibbles follow; `0` = end of integer).

When continuation bit is `0`:
$$\text{offset}_{i} = \text{offset}_{i-1} + (\text{decoded\_val} + 1) \times 4$$

### 3.2 Global Offset Resolution

Encoded 32-bit offsets reference specific chunk buffers:
- If $\text{enc} \le \text{0x07FFFFFF}$: Offset is relative to Chunk 1 ($\text{global} = \text{chunks}[1].\text{offset} + \text{enc}$).
- If $\text{enc} > \text{0x07FFFFFF}$: Higher bits select target chunk index:
  $$\text{chunk\_idx} = (\text{enc} \gg 27) + 1$$
  $$\text{global} = \text{chunks}[\text{chunk\_idx}].\text{offset} + (\text{enc} \ \& \ \text{0x07FFFFFF})$$

---

## 4. CFxTemplate & CFxPrimitiveTemplate Binary Layout

### 4.1 CFxTemplate Layout

`CFxTemplate` acts as the root container for an effect emitter hierarchy.

| Offset (hex) | Offset (dec) | Type | Field Name | Description |
|---|---|---|---|---|
| `+0x00` | 0 | `uint32` | `typeIndex` | Index into `TMET` pointing to "CFxTemplate" |
| `+0x10` | 16 | `uint32` | `fileNameIdx` | String fixup (`RSTT`) to template name in `TSTR` (optional) |
| `+0x18` | 24 | `uint32` | `firstPrimitive` | Reference fixup (`ROFS`) to first `CFxPrimitiveTemplate` |
| `+0x20` | 32 | `float` | `loopTime` | Total emitter cycle duration in seconds |
| `+0x24` | 36 | `float` | `randLoopTime` | Variance added to cycle loop time |
| `+0x28` | 40 | `int32` | `persistLoop` | Boolean flag (`0` = single shot, `1` = continuous loop) |
| `+0x2C` | 44 | `int32` | `poolID` | Allocation pool identifier |

### 4.2 CFxPrimitiveTemplate Layout

`CFxPrimitiveTemplate` defines individual emitters, particles, ribbons, flashes, models, or lighting components. Total instance size is typically 1,216 bytes.

#### Quadratic Curve Parameter Blocks (`CRangedQuadraticMetaField`)

Particle temporal evolution is modeled by `CRangedQuadraticMetaField` structures in Alchemy Engine (located in `Alliance.exe` `.rdata` type descriptors). Each `CRangedQuadraticMetaField` occupies exactly 32 bytes (8 contiguous single-precision 32-bit floats):

| Index | Field Name | Description |
|---|---|---|
| `[0]` | `a` | Quadratic acceleration coefficient ($a \cdot t^2$) |
| `[1]` | `b` | Linear velocity coefficient ($b \cdot t$) |
| `[2]` | `c` | Constant baseline offset ($c$) |
| `[3]` | `min` | Minimum clamp boundary |
| `[4]` | `max` | Maximum clamp boundary |
| `[5]` | `varA` | Quadratic variance deviation coefficient |
| `[6]` | `varB` | Linear variance deviation coefficient |
| `[7]` | `varC` | Constant variance deviation offset |

The deterministic curve trajectory at normalized particle progress $t = \frac{\text{localTime}}{\text{life}} \in [0, 1]$ evaluates as:
$$y(t) = \text{clamp}\big((a \cdot t + b) \cdot t + c, \ \text{min}, \ \text{max}\big)$$

When non-zero variance coefficients (`varA`, `varB`, `varC`) are present, each spawned particle perturbs the base polynomial by a randomized variance factor. The JavaScript viewer runtime (`vfx.js::evaluateQuadratic`) consumes the primary 5-float vector `[a, b, c, min, max]`.

`CFxPrimitiveTemplate` contains three consecutive `CRangedQuadraticMetaField` instances:

| Offset (dec) | Size (bytes) | Field Name | Target Property |
|---|---|---|---|
| +16 (`0x10`) | 32 | `_rqSize` | Particle diameter / scale curve over lifespan |
| +48 (`0x30`) | 32 | `_rqAlpha` | Opacity / alpha curve over lifespan |
| +80 (`0x50`) | 32 | `_rqLength` | Particle / ribbon elongation curve over lifespan |

#### Runtime unit normalization (`vfx.js`)

`_rqSize` and `_rqLength` are authored in the rig's local units; the decoded
GLBs bake the unit conversion into a scaled root node (measured examples:
`spiderman` 0.02830, `spiderman_alt` 0.02829, `juggernaut_alt_2` 0.02107,
`a_bomb_anti_1` 0.01875, `hulk` 0.01950). The runtime samples the world scale
of the first `SkinnedMesh` (falling back to a `Bone`) and multiplies every
curve by it, so a `_rqSize` of 40 renders as 40 × 0.0283 ≈ 1.13 m on
Spider-Man. `WORLD_UNIT_METERS = 0.0254` is used only when there is no
measurable rig (scenery effects, no model loaded), and
`DEFAULT_PRIMITIVE_SIZE_IN = 12` remains the last-resort size for primitives
whose `_rqSize` and `_radius` are both zero (2.8% of the catalog, mostly
`CAMERA_SHAKE` and 280 cylinders). `_radius` is authored in metres, so it is
converted back to local units before the rig scale is applied.

Effects whose template `loopTime` is shorter than the primitive `_life` (the
common trail case: `loopTime` 0.3 s, `_life` 1 s) keep the trail ribbon across
loop cycles. Wiping the point history on every wrap would leave the strip at
one or two samples and make it invisible; `VfxPrimitiveRunner.resetCycle()`
therefore preserves the trail history while resetting every other primitive.

The template `loopTime` is the emitter cycle, not the effect duration: 4,219 of
5,235 effects (80.6%) contain at least one primitive whose `_delay + _life`
exceeds it. `VfxRuntime.playDuration` is therefore `max(loopTime,
max(delay + life))` and every timeline boundary (sync wrap, free-run wrap,
one-shot finish, play restart, loop restart) uses it, so a rigid body spawned
1.008 s into a 1 s ram attack is no longer truncated before it appears.

`FXPRIM_TYPE_MODEL` / `HAVOKMODEL` are the exception to the unit rule: their
`_rqSize` is a dimensionless multiplier of the exported GLB's native size
(1,747 of 2,380 primitives author exactly `1.0`), so the runtime applies the
raw curve value instead of multiplying it by the rig scale. Applying the rig
scale there would shrink a full character or prop to roughly 1/50 of its size.

#### Continuous Float Parameter Block (Offset +752 to +812)

| Offset (dec) | Type | Field Name | Description |
|---|---|---|---|
| +752 | `float` | `_spawnDelay` | Delay before first particle emission (seconds) |
| +756 | `float` | `_spawnCount` | Number of particles spawned per emission cycle |
| +760 | `float` | `_life` | Particle lifespan duration (seconds) |
| +764 | `float` | `_drag` | Primary linear drag coefficient |
| +768 | `float` | `_gravity` | Gravity acceleration vector multiplier |
| +772 | `float` | `_radius` | Primary radius / particle dimension |
| +776 | `float` | `_radius2` | Secondary radius / outer extent |
| +780 | `float` | `_height` | Cylinder / ribbon emitter height |
| +784 | `float` | `_drag2` | Secondary drag coefficient |
| +788 | `float` | `_gravity2` | Secondary gravity acceleration coefficient |
| +792 | `float` | `_particleTravelTime` | Travel time along spline or velocity path |
| +796 | `float` | `_particleSpawnTime` | Spawn interval between successive emissions |
| +800 | `float` | `_scrollVelocity[0]` | UV texture animation U-speed |
| +804 | `float` | `_scrollVelocity[1]` | UV texture animation V-speed |
| +808 | `float` | `_scrollVelocity[2]` | UV texture animation W / rotation-speed |

#### Control Flags & Primitive Classification

| Offset (dec) | Type | Field Name | Description |
|---|---|---|---|
| +920 | `int32` | `_primitiveType` | Enum value (0-26) matching `PRIM_TYPES` table |
| +928 | `uint32` | `nextPrimitive` | Reference fixup (`ROFS`) to linked sibling primitive |
| +936 | `uint32` | `_flags` | Primary primitive bitmask (billboard, lighting, blend flags) |
| +940 | `uint32` | `_flags2` | Secondary primitive bitmask |
| +944 | `uint32` | `_spawnFlags` | Particle emission spawn mode bitmask |

#### Color Gradients & Blend Mode

| Offset (dec) | Type | Field Name | Description |
|---|---|---|---|
| +984 | `uint32` | `_colorStart1` | Primary color gradient start (ARGB) |
| +988 | `uint32` | `_colorMid1` | Primary color gradient midpoint (ARGB) |
| +992 | `uint32` | `_colorEnd1` | Primary color gradient end (ARGB) |
| +996 | `uint32` | `_colorStart2` | Secondary color gradient start (ARGB) |
| +1000 | `uint32` | `_colorMid2` | Secondary color gradient midpoint (ARGB) |
| +1004 | `uint32` | `_colorEnd2` | Secondary color gradient end (ARGB) |
| +1008 | `int32` | `_blendMode` | Blend mode integer (0 = Opaque, 1 = Additive, 2 = Alpha Blend, etc.) |

#### Camera Shake & Shader Identifier (Offset +1016 to +1064)

| Offset (dec) | Type | Field Name | Description |
|---|---|---|---|
| +1016 | `float` | `_shakeSpeed` | Camera shake frequency / oscillation speed |
| +1020 | `float` | `_shakeScale` | Camera shake amplitude / displacement magnitude |
| +1024 | `int32` | `_shakeType` | Camera shake profile enumeration |
| +1064 | `RSTT` | `_shaderName` | Specialized material shader identifier (`'ScreenDistortion'`, `'*UberShader'`, or null) |

#### String Resource Pointers (`RSTT` Fixups) & Primitive Disambiguation

String fixups reference zero-based string indices in the file's `TSTR` pool. Offsets +1168 through +1208 are multiplexed depending on `_primitiveType`:

##### Visual / Rendering Primitives (`_primitiveType != 21`)

| Offset (dec) | Field Name | Target Description |
|---|---|---|
| +1064 | `_shaderName` | Specialized material shader identifier (`'ScreenDistortion'`, `'*UberShader'`) |
| +1136 | `_postProcessLutTexture` | Lookup Table (`LUT`) color grading texture path (e.g. `'textures/luts/lut_blank'`) |
| +1168 | `_shaderTexture0` | Primary diffuse / particle texture path |
| +1176 | `_shaderTexture1` | Normal / bump map texture path |
| +1184 | `_shaderTexture2` | Secondary / detail texture path |
| +1192 | `_shaderTexture3` | Mask / alpha texture path |
| +1200 | `_shaderTexture4` | Distortion / displacement texture path |
| +1208 | `_shaderTexture5` | Specular / environment map texture path |

All texture paths resolved from `_shaderTexture0` through `_shaderTexture5` must be filtered strictly for `.tga` and `.dds` file extensions. For non-sound primitives, `soundBank` and `soundName` must always resolve to `null`.

##### Audio Emitter Primitives (`_primitiveType == 21` / `FXPRIM_TYPE_SOUND`)

When `_primitiveType == 21`, offsets +1184 through +1208 map to audio metadata rather than visual shader textures:

| Offset (dec) | Field Name | Target Description |
|---|---|---|
| +1184 | `_audioBankName` | FMOD audio bank name (e.g. `'FX_explosion_container_bank'`) |
| +1192 | `_soundName1` | Primary sound event name (e.g. `'ENV_Cap_Arena_Pipe_Break'`) |
| +1200 | `_soundName2` | Secondary sound event variant name |
| +1208 | `_soundName3` | Tertiary sound event variant name |

#### Primitive Type Enumeration

```c
enum EFxPrimitiveType {
    FXPRIM_TYPE_NONE = 0,
    FXPRIM_TYPE_EMPTY = 1,
    FXPRIM_TYPE_PARTICLE_CLOUD = 2,
    FXPRIM_TYPE_SPRITE = 3,
    FXPRIM_TYPE_FLARE = 4,
    FXPRIM_TYPE_WEATHERFX = 5,
    FXPRIM_TYPE_ORIENTED_SPRITE = 6,
    FXPRIM_TYPE_SPARK = 7,
    FXPRIM_TYPE_LINE = 8,
    FXPRIM_TYPE_LIGHTNING = 9,
    FXPRIM_TYPE_CYLINDER = 10,
    FXPRIM_TYPE_MODEL = 11,
    FXPRIM_TYPE_HAVOKMODEL = 12,
    FXPRIM_TYPE_HAVOKFORCE = 13,
    FXPRIM_TYPE_ENTITY = 14,
    FXPRIM_TYPE_LIGHT = 15,
    FXPRIM_TYPE_SCREENFLASH = 16,
    FXPRIM_TYPE_CAMERA_SHAKE = 17,
    FXPRIM_TYPE_TRAIL = 18,
    FXPRIM_TYPE_BEZIER = 19,
    FXPRIM_TYPE_TEXT = 20,
    FXPRIM_TYPE_SOUND = 21,
    FXPRIM_TYPE_HAVOK_SPRITE = 22,
    FXPRIM_TYPE_HDR = 23,
    FXPRIM_TYPE_SCREEN_SPRITE = 24,
    FXPRIM_TYPE_PARENT_RENDER = 25,
    FXPRIM_TYPE_POST_PROCESS = 26
};
```

---

## 5. Vectorized Texture Decompression Pipeline

Textures in `_work/texture_index.json` are packaged inside multi-asset packfiles. Three compressed formats are supported:

### 5.1 DXT1 (BC1)

- **Block Size**: 8 bytes per 4x4 pixel block.
- **Color Format**: Two RGB565 endpoints $c_0, c_1$ plus 32 bits of 2-bit interpolation indices.
- **Color Formula**:
  - If $c_0 > c_1$: 4 opaque colors:
    $$c_2 = \frac{2c_0 + c_1}{3}, \quad c_3 = \frac{c_0 + 2c_1}{3}$$
  - If $c_0 \le c_1$: 3 opaque colors plus transparent black ($c_3 = 0$).

### 5.2 DXT5 (BC3)

- **Block Size**: 16 bytes per 4x4 pixel block.
- **Alpha Block**: 8 bytes (two 8-bit endpoints $a_0, a_1$ plus 48 bits of 3-bit indices).
  - If $a_0 > a_1$: 6 interpolated values ($a_2 \dots a_7$).
  - If $a_0 \le a_1$: 4 interpolated values, $a_6 = 0, a_7 = 255$.
- **Color Block**: 8 bytes identical to DXT1.

### 5.3 ATI2 (BC5)

- **Block Size**: 16 bytes per 4x4 pixel block.
- **Channels**: Two independent 8-byte BC4 blocks representing Tangent-Space Normal map Red ($X$) and Green ($Y$).
- **Blue Reconstruction**: Blue ($Z$) is normalized to 255 in thumbnails.

### 5.4 Collision-Free Hash Addressing

To eliminate basename collisions (multiple textures named `default.tga` or `fxt_flame01_d.tga` with different contents across character and level archives), textures are exported keyed by their 16-hex handle hash:

```
assets/vfx/textures/<16-hex-key>.png
```

Thumbnails are resized to a maximum bounding box of $256 \times 256$ pixels using high-quality Lanczos resampling.

---

## 6. Character & Model Mapping Architecture

Character directories under `_work/igz_effects/char/<name>/` map to exact 3D model entries in `mua2-viewer/assets/models/models.json`.

### Alias Normalization Table

| Directory Name | Canonical Character | Associated Model IDs |
|---|---|---|
| `bphero` / `blackpantherhero` | `blackpanther` | `['blackpanther', 'blackpanther_pro_1', 'blackpanther_alt_1']` |
| `cablehero` | `cable` | `['cable', 'cable_alt', 'cable_anti_1']` |
| `fury` / `nickfuryhero` | `nickfury` | `['nickfury', 'nickfury_nanite_anti_1', 'nickfury_anti_1']` |
| `herc` | `hercules` | `['hercules']` |
| `spidwm` | `spiderwoman` | `['spiderwoman_pro_1', 'spiderwoman_pro_2']` |
| `thing` | `thething` | `['thething', 'thething_alt']` |
| `vanbardos` | `luciavonbardas` | `['luciavonbardas_pro_1', 'luciavonbardas_cyborg_pro_1']` |
| `warbird` | `msmarvel` | `['msmarvel', 'msmarvel_alt']` |
| `lukecageminiboss` | `lukecage` | `['lukecage', 'lukecage_alt', 'lukecage_2']` |

---

## 7. Verification & Conformance

- All 5,333 original MUA2 effects are cataloged in `effects.json.gz`.
- Zero synthetic effect parameters were invented; unknown primitive types are flagged explicitly as `unknown_primitive_type_<id>` in `unsupported`.
- Automated regression suite `mua2-viewer/tools/test_vfx_regression.py` validates fixup decoding, primitive decompilation, texture decompressors, catalog schema compliance, and thumbnail integrity.
