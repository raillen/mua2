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
     - `get_block_index_and_frame`: multi-block shared boundary frame partitioning (`max_frames_per_block - 1` advance per block, matching Havok `getBlockAndTimeInBlock`)

## MUA2 Tailoring & Constraints
- Tailored for MUA2 character and zone animation packfiles.
- Invariants across all 10,377 clips: Havok 6.1.0-r1 64-bit LE, zero float tracks (`mask_quant_size == 4 * num_tracks`).
- Multi-block clips (`num_blocks > 1`):
  - 8 multi-block character clips (2-3 blocks, 281-551 frames): `10_thor_4_combat.hkx` (`fusion_create_tornado_loop`), `110_goliath.hkx` (`idle`), `110_goliath_4_combat.hkx` (`power_18`), `115_yellowjacket.hkx` (`idle`), `158_nanitenickfury.hkx` (`power_26`, `power_28`), `160_cablehero.hkx` (`menu_action`), and `venom_tongue.hkx` (`power_20`).
  - 463 multi-block zone/effect clips (2-6 blocks, up to 1,363 frames).
  - Adjacent blocks share boundary frames (`frames_per_block = max_frames_per_block - 1 = 255`), validated against Havok 6.1 and `soulstruct-havok`.
  - Block transform payloads span `block_offsets[b]` to `block_offsets[b] + float_block_offsets[b]`.
- All rotations use `ThreeComp40` (q_type 1) with unit quaternion normalization upon curve evaluation.
- `MultiBlockCurve` wraps per-block B-spline curves to preserve the transparent `.value(frame)` interface and provide `sample(frame)`.
