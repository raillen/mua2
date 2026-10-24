import * as THREE from 'three';

/**
 * Authentic Havok animation loader for MUA2 characters.
 *
 * Reads explicit routing from assets/animations/index.json, loads canonical
 * animation files, binds tracks to model bone hierarchies, and builds Three.js
 * AnimationClips. Procedural generators and unsafe name-splitting fallbacks
 * are strictly eliminated.
 */

// Cache for manifest and loaded animation data files
let manifestPromise = null;
const clipCache = new Map();

/**
 * Fetch and cache the canonical animation manifest.
 * @returns {Promise<Record<string, string | null>>}
 */
function getManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch('assets/animations/index.json')
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return manifestPromise;
}

/**
 * Build a map of normalized bone names -> actual bone name in model
 */
function buildBoneMap(model) {
  const map = new Map();
  model.traverse((o) => {
    if (o.isBone) {
      map.set(o.name, o.name);
      // Also map space <-> underscore variants
      map.set(o.name.replace(/ /g, '_'), o.name);
      map.set(o.name.replace(/_/g, ' '), o.name);
    }
  });
  return map;
}

/**
 * Load authentic Havok-decompiled animation clips for a character.
 * @param {string} characterId - e.g. 'spiderman'
 * @param {THREE.Object3D} model - Loaded character model
 * @returns {Promise<Record<string, THREE.AnimationClip>>}
 */
export async function loadGameAnimations(characterId, model) {
  if (!characterId || !model) return {};

  const cleanId = characterId.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const manifest = await getManifest();
  const canonicalFile = manifest[cleanId];

  // Unsupported or empty model: fail visibly with empty clips; no unsafe fallback
  if (!canonicalFile) {
    return {};
  }

  const url = `assets/animations/${canonicalFile}`;

  let animData = clipCache.get(canonicalFile);
  if (!animData) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return {};
      }
      animData = await res.json();
      clipCache.set(canonicalFile, animData);
    } catch {
      return {};
    }
  }

  if (!animData || !Array.isArray(animData.clips) || animData.clips.length === 0) {
    return {};
  }

  const boneMap = buildBoneMap(model);
  const result = {};

  for (const rawClip of animData.clips) {
    if (!rawClip.name || typeof rawClip.duration !== 'number') continue;

    const tracks = [];

    for (const track of (rawClip.tracks || [])) {
      const targetBone = boneMap.get(track.bone);
      if (!targetBone) continue;

      const rotTimes = track.rotTimes || track.times || rawClip.times;
      if (rotTimes && track.quaternions && track.quaternions.length === rotTimes.length * 4) {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${targetBone}.quaternion`,
            rotTimes,
            track.quaternions
          )
        );
      }

      const posTimes = track.posTimes || track.times || rawClip.times;
      if (posTimes && track.positions && track.positions.length === posTimes.length * 3) {
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${targetBone}.position`,
            posTimes,
            track.positions
          )
        );
      }

      const sclTimes = track.sclTimes || track.times || rawClip.times;
      if (sclTimes && track.scales && track.scales.length === sclTimes.length * 3) {
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${targetBone}.scale`,
            sclTimes,
            track.scales
          )
        );
      }
    }

    if (tracks.length > 0) {
      const clip = new THREE.AnimationClip(rawClip.name, rawClip.duration, tracks);
      result[rawClip.name] = clip;
    }
  }

  return result;
}
