import * as THREE from 'three';

/**
 * Authentic Havok animation loader for MUA2 characters.
 *
 * Reads extracted animation track data from assets/animations/{characterId}.json,
 * binds tracks to model bone hierarchies, and builds Three.js AnimationClips.
 * Procedural animations are strictly eliminated.
 */

// Cache for loaded animation data files
const clipCache = new Map();

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
  const url = `assets/animations/${cleanId}.json`;

  let animData = clipCache.get(cleanId);
  if (!animData) {
    try {
      let res = await fetch(url);
      if (!res.ok) {
        const baseId = cleanId.split('_')[0];
        if (baseId !== cleanId) {
          res = await fetch(`assets/animations/${baseId}.json`);
        }
      }
      if (!res.ok) {
        return {};
      }
      animData = await res.json();
      clipCache.set(cleanId, animData);
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
