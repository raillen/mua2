"""Skeleton extraction for MUA2 IGZ v6 (Alchemy 6).

Layout (64-bit, verified against actors.bin):
  igSkeleton2      +0x18 -> igSkeletonBoneList, +0x28 -> inverse joint matrix array
  igSkeletonBoneList  data = array of u64 encoded pointers to igSkeletonBone
  igSkeletonBone   +0x18 parentIndex (i32, -1 = root), +0x1C blendMatrixIndex (i32),
                   +0x20 translation (3 x f32)
  bone name        resolved through the RSTT string-reference table
  inverse joint matrices: 0x40 bytes each (4x4 row-major), indexed by blendMatrixIndex
"""
import struct
import numpy as np


def _ref(obj, offset):
    """Fetch a resolved reference by field offset (int or hex key)."""
    refs = obj.references
    if offset in refs:
        return refs[offset]
    hexkey = hex(offset)
    if hexkey in refs:
        return refs[hexkey]
    return None


def _name_of(reader, global_offset, size=48):
    """Resolve an object's name from the RSTT string-reference table."""
    for rstt in reader.fixups.rstt:
        if global_offset <= rstt < global_offset + size:
            idx = struct.unpack_from('<I', reader.data, rstt)[0]
            if idx < len(reader.fixups.tstr):
                return reader.fixups.tstr[idx]
            return f'#{idx}'
    return None


def parse_skeleton(reader):
    """Return (bones, ibms) for the actor.

    bones: list of dicts with name, parent (0-based, -1 root), children, translation
    ibms:  list of 4x4 numpy inverse-bind matrices (row-major), one per bone
    ibm_flat: the same matrices as flat float32 arrays in glTF (column-major) order
    """
    skels = reader.get_objects_by_type('igSkeleton2')
    if not skels:
        return [], [], []
    skel = skels[0]
    bone_lists = reader.get_objects_by_type('igSkeletonBoneList')
    if not bone_lists:
        return [], [], []
    bl = bone_lists[0]

    n = bl.read_u32(0x10)
    list_ptr = _ref(bl, 0x20)
    if list_ptr is None:
        return [], [], []
    data = reader.data
    encoded = [struct.unpack_from('<Q', data, list_ptr + i * 8)[0] for i in range(n)]
    gobjs = [reader._get_global_offset(e) for e in encoded]

    # inverse joint matrices (stored column-major in the file, i.e. glTF order)
    ibm_ptr = _ref(skel, 0x28)
    ibms = []
    ibm_flat = []
    if ibm_ptr is not None:
        for i in range(n):
            m = struct.unpack_from('<16f', data, ibm_ptr + i * 64)
            ibm_flat.append(np.array(m, np.float32))
            ibms.append(np.array(m, np.float64).reshape(4, 4).T)  # col-major -> row-major

    bones = []
    for i, g in enumerate(gobjs):
        parent, blend = struct.unpack_from('<ii', data, g + 0x18)
        t = struct.unpack_from('<3f', data, g + 0x20)
        bones.append({
            'index': i,
            'name': _name_of(reader, g) or f'bone{i}',
            'parent': parent,          # -1 = root
            'blend': blend,
            'translation': np.array(t, np.float64),
        })
    for b in bones:
        b['children'] = []
    for b in bones:
        if 0 <= b['parent'] < len(bones):
            bones[b['parent']]['children'].append(b['index'])
    return bones, ibms, ibm_flat


def _decompose(m):
    """Split a 4x4 matrix into (translation, quaternion xyzw, scale)."""
    t = m[:3, 3].copy()
    basis = m[:3, :3].copy()
    scale = np.linalg.norm(basis, axis=0)
    scale[scale == 0] = 1.0
    rot = basis / scale
    # quaternion from rotation matrix
    tr = rot[0, 0] + rot[1, 1] + rot[2, 2]
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (rot[2, 1] - rot[1, 2]) / s
        y = (rot[0, 2] - rot[2, 0]) / s
        z = (rot[1, 0] - rot[0, 1]) / s
    elif rot[0, 0] > rot[1, 1] and rot[0, 0] > rot[2, 2]:
        s = np.sqrt(1.0 + rot[0, 0] - rot[1, 1] - rot[2, 2]) * 2
        w = (rot[2, 1] - rot[1, 2]) / s
        x = 0.25 * s
        y = (rot[0, 1] + rot[1, 0]) / s
        z = (rot[0, 2] + rot[2, 0]) / s
    elif rot[1, 1] > rot[2, 2]:
        s = np.sqrt(1.0 + rot[1, 1] - rot[0, 0] - rot[2, 2]) * 2
        w = (rot[0, 2] - rot[2, 0]) / s
        x = (rot[0, 1] + rot[1, 0]) / s
        y = 0.25 * s
        z = (rot[1, 2] + rot[2, 1]) / s
    else:
        s = np.sqrt(1.0 + rot[2, 2] - rot[0, 0] - rot[1, 1]) * 2
        w = (rot[1, 0] - rot[0, 1]) / s
        x = (rot[0, 2] + rot[2, 0]) / s
        y = (rot[1, 2] + rot[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], np.float64)
    q /= np.linalg.norm(q)
    return t, q, scale


def bone_local_transforms(bones, ibms):
    """Return list of (translation, quaternion xyzw, scale) in the original space."""
    n = len(bones)
    world = []
    for i, b in enumerate(bones):
        blend = b['blend']
        if 0 <= blend < len(ibms):
            w = np.linalg.inv(ibms[blend])
        else:
            w = np.eye(4)
        world.append(w)
    out = []
    for i, b in enumerate(bones):
        p = b['parent']
        if 0 <= p < n:
            local = np.linalg.inv(world[p]) @ world[i]
        else:
            local = world[i]
        out.append(_decompose(local))
    return out
