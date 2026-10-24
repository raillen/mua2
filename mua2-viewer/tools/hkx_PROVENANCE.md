# Havok 6.1 Spline Decompression Provenance & License Documentation

## Reference Implementations

1. **HavokLib / hkaSplineCompressedAnimation**
   - **Author**: Lukas Cone (PredatorCZ)
   - **Repository**: https://github.com/PredatorCZ/HavokLib
   - **License**: GNU General Public License v3.0 (GPL-3.0)
   - **Files referenced**:
     - `hka_spline_decompressor.cpp` / `hka_spline_decompressor.hpp`
   - **Algorithms adapted**:
     - ThreeComp40 quaternion bit-unpacking and scale reconstruction
     - 4-byte/2-byte alignment rules between spline track headers and control point buffers
     - B-spline knot span binary search (NURBS Book 2nd ed. Algorithm A2.1)
     - Time-efficient basis evaluation (Basis_ITS1 / GetPoint_NR1)

2. **soulstruct-havok**
   - **Author**: Grimrukh
   - **Repository**: https://github.com/grimrukh/soulstruct-havok
   - **Commit**: `bf2d41fc83de4a43bd3ed3df8605741f143cad2c`
   - **License**: MIT License
   - **Files referenced**:
     - `src/soulstruct/havok/spline_compression.py`
     - `src/soulstruct/havok/utilities/maths/quaternion.py`
   - **Algorithms adapted**:
     - Pure Python B-spline basis evaluation function implementations
     - ThreeComp40 40-bit integer bitfield masking and implicit component reconstruction
     - Quantized float linear interpolation between [min, max] extremes

## MUA2 Tailoring & Constraints
- Tailored specifically for MUA2 Spider-Man animation packfiles (`09_spiderman.hkx`, `09_spiderman_4_combat.hkx`, `09_spiderman_4_conv.hkx`).
- Invariant across all 97 clips: Havok 6.1.0-r1 64-bit LE, `numBlocks == 1`, `floatTracks == 0`.
- All rotations use `ThreeComp40` (q_type 1) with unit quaternion normalization upon curve evaluation.
