import { createNativeEffect, isNativeEffect } from './vfx-native.js';

const PAGE_SIZE = 100;
const PLAYBACK_NOTICE = 'Reprodução indisponível: emissor ainda não decodificado';
const STATUS_LABELS = { decoded: 'Decodificado', partial: 'Parcial', 'metadata-only': 'Metadados', error: 'Erro' };
// World units are inches. The ribbon keeps half a second of anchor history,
// resampled at 30 Hz so the trail length is frame-rate independent.
const TRAIL_HISTORY_SECONDS = 0.5;
const TRAIL_SAMPLE_INTERVAL = 1 / 30;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function textureUrl(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  // Catalog images stay within the shipped texture directory, never remote URLs.
  return /^assets\/vfx\/[\w./-]+$/.test(path) && !path.split('/').includes('..') ? path : null;
}

export function normalizeEffect(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const path = typeof raw.path === 'string' ? raw.path.replace(/\\/g, '/') : '';
  const id = typeof raw.id === 'string' && raw.id ? raw.id : path || raw.name;
  if (typeof id !== 'string' || !id.trim()) return null;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : path.split('/').pop() || id;
  const character = typeof raw.character === 'string' && raw.character.trim()
    ? raw.character.trim() : path.startsWith('char/') ? path.split('/')[1] : null;
  return {
    id,
    path,
    name,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : path.split('/')[0] || 'other',
    character,
    // No path/name guessing for model associations, including curated fallback entries.
    modelIds: Array.isArray(raw.modelIds) ? raw.modelIds.filter((id) => typeof id === 'string' && id) : [],
    textures: Array.isArray(raw.textures) ? raw.textures.filter((item) => typeof item === 'string') : [],
    thumb: textureUrl(raw.thumb) || textureUrl(typeof raw.preview === 'string' ? `assets/vfx/thumbs/${raw.preview}` : null),
    definition: raw.definition && typeof raw.definition === 'object' ? raw.definition : null,
    status: Object.hasOwn(STATUS_LABELS, raw.status) ? raw.status : 'metadata-only',
    unsupported: raw.unsupported ?? [],
  };
}

export function matches(effect, query, category, character) {
  return (category === 'all' || effect.category === category)
    && (character === 'all' || effect.character === character)
    && (!query || `${effect.id} ${effect.name} ${effect.path} ${effect.character || ''} ${effect.category} ${effect.textures.join(' ')}`.toLowerCase().includes(query));
}

export function badge(effect) {
  const native = isNativeEffect(effect?.id)
    ? '<span class="vfx-badge status-decoded" title="Simulação recriada em Three.js com os valores autênticos do .igz">Nativo</span>'
    : '';
  return `<span class="vfx-badge status-${effect.status}">${STATUS_LABELS[effect.status]}</span>${native}`;
}

// ========================================================
// COLOR RAMPS & BLEND MODES (Alchemy CFxPrimitiveTemplate)
// ========================================================

export function parseHexColor(hex) {
  if (!hex || typeof hex !== 'string') return { r: 1, g: 1, b: 1, a: 1 };
  const val = parseInt(hex.replace(/^0x/i, ''), 16) || 0;
  const aRaw = (val >>> 24) & 0xff;
  const r = ((val >>> 16) & 0xff) / 255;
  const g = ((val >>> 8) & 0xff) / 255;
  const b = (val & 0xff) / 255;
  const a = aRaw > 0 ? aRaw / 255 : 1.0;
  return { r, g, b, a };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function evaluateColorRamp(colors, t) {
  const start = parseHexColor(colors?.start1);
  const mid = parseHexColor(colors?.mid1 || colors?.start1);
  const end = parseHexColor(colors?.end1 || colors?.mid1 || colors?.start1);
  const clamped = Math.max(0, Math.min(1, t));
  let r;
  let g;
  let b;
  let a;
  if (clamped <= 0.5) {
    const u = clamped / 0.5;
    r = lerp(start.r, mid.r, u);
    g = lerp(start.g, mid.g, u);
    b = lerp(start.b, mid.b, u);
    a = lerp(start.a, mid.a, u);
  } else {
    const u = (clamped - 0.5) / 0.5;
    r = lerp(mid.r, end.r, u);
    g = lerp(mid.g, end.g, u);
    b = lerp(mid.b, end.b, u);
    a = lerp(mid.a, end.a, u);
  }
  // Alpha is authored by the primitive's rqAlpha curve; the colour ramp only
  // supplies the channel fallback. No synthetic envelope: the decoded curve
  // already contains the authentic fade in/out (a second envelope double-fades).
  return { r, g, b, a: Math.min(1.0, Math.max(0.0, a)) };
}

export function evaluateQuadratic(curve, t, fallback = 0) {
  if (!Array.isArray(curve) || curve.length !== 5 || !curve.every(Number.isFinite)) return fallback;
  const [a, b, c, min, max] = curve;
  if (min > max) return fallback;
  if (a === 0 && b === 0 && c === 0) return fallback;
  return Math.max(min, Math.min(max, (a * t + b) * t + c));
}

export function resolveBlendMode(mode, THREE, shaderName = null) {
  if (!THREE) return 0;
  if (shaderName === 'ScreenDistortion') {
    return THREE.AdditiveBlending;
  }
  switch (mode) {
    case 1: // Additive
    case 3: // Screen / Additive
      return THREE.AdditiveBlending;
    case 4: // Multiply
      return THREE.MultiplyBlending;
    case 5: // Subtractive
      return THREE.SubtractiveBlending;
    case 0: // Opaque / Normal
    case 2: // Alpha blend
    default:
      return THREE.NormalBlending;
  }
}

// ========================================================
// BONE ATTACHMENT RESOLUTION
// ========================================================

export function resolveAttachmentTarget(effectId, textures = []) {
  const text = (String(effectId || '') + ' ' + (textures || []).join(' ')).toLowerCase();

  // Specific left hand keywords
  if (/lhand|left_hand|l_hand|lefthand|clawl|l_arm|l_wrist|l_finger/.test(text)) {
    return { boneName: 'Bip01 L Hand', slot: 'Mão Esquerda', priority: 10 };
  }
  // Specific right hand / weapon / projectile keywords
  if (/rhand|right_hand|r_hand|righthand|clawr|r_arm|r_wrist|r_finger|handblast|webyank|webzip|hammer|sword|shieldthrow/.test(text)) {
    return { boneName: 'Bip01 R Hand', slot: 'Mão Direita', priority: 10 };
  }
  // Unibeam / chest power
  if (/uniblast|chest|torso|bodyflame|body_fx|heart|core/.test(text)) {
    return { boneName: 'Bip01 Spine2', slot: 'Peito / Tórax', priority: 8 };
  }
  // Generic hand / punch / slash / fist
  if (/hand|fist|punch|slash|claw|grab|cast/.test(text)) {
    return { boneName: 'Bip01 R Hand', slot: 'Mão Direita', priority: 7 };
  }
  // Head / eyes / vision / breath / face
  if (/head|eye|mouth|face|mask|breath|jaw|gaze|vision|helmet/.test(text)) {
    return { boneName: 'Bip01 Head', slot: 'Cabeça', priority: 8 };
  }
  // Left foot
  if (/lfoot|left_foot|l_foot|l_leg/.test(text)) {
    return { boneName: 'Bip01 L Foot', slot: 'Pé Esquerdo', priority: 9 };
  }
  // Right foot / kick / stomp
  if (/rfoot|right_foot|r_foot|r_leg|kick/.test(text)) {
    return { boneName: 'Bip01 R Foot', slot: 'Pé Direito', priority: 9 };
  }
  // Ground / impact / floor / crater / shockwave
  if (/ground|floor|crater|shockwave|puddle|stomp|quake|earthquake/.test(text)) {
    return { boneName: null, slot: 'Chão / Impacto', isGround: true, priority: 6 };
  }
  // Default to chest / spine for full body aura / character power
  return { boneName: 'Bip01 Spine', slot: 'Centro do Personagem', priority: 1 };
}

export function findBoneInModel(model, boneName) {
  if (!model || !boneName) return null;
  const target = boneName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!target) return null;
  let exact = null;
  let partial = null;
  model.traverse((obj) => {
    if (exact || !obj.isBone) return;
    const name = (obj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name) return;
    if (name === target) {
      exact = obj;
      return;
    }
    // Attach bones share a prefix with their parent ("Bip01 R Hand" vs
    // "Bip01 R HandAttach"); only accept a prefix match when no exact bone
    // exists in the rig.
    if (!partial && name.includes(target)) partial = obj;
  });
  return exact || partial;
}

// ========================================================
// AUTHENTIC ACTION BINDING (powerstyles/*.muc -> data.bin)
// ========================================================

// The Alchemy rqSize curves are authored in the rig's local units, and the
// decoded GLBs usually bake the unit conversion into a scaled root node
// (spiderman 0.0283, hulk 0.0195, ...). The runtime therefore measures that
// world scale and multiplies every curve by it; 0.0254 m/in is only the
// fallback used for scenery or a rig without a measurable scale.
export const WORLD_UNIT_METERS = 0.0254;
export const METERS_TO_INCHES = 1 / WORLD_UNIT_METERS;
export const DEFAULT_PRIMITIVE_SIZE_IN = 12;
export const SCENERY_CATEGORIES = new Set(['map', 'common', 'flares', 'menu', 'renderfx']);

// EBOLT_* -> ordered bone candidates. Mirrors vfx_actions.py, which resolves
// the enums from the .muc files; kept in JS so runtime fallbacks are explicit.
export const BOLT_CANDIDATES = {
  EBOLT_LHAND: ['Bip01 L Hand'],
  EBOLT_RHAND: ['Bip01 R Hand'],
  EBOLT_LHANDATTACH: ['Bip01 L HandAttach', 'Bip01 L Hand'],
  EBOLT_RHANDATTACH: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLT_TORSO: ['Bip01 Spine2', 'Bip01 Spine1', 'Bip01 Spine'],
  EBOLT_LOWER_TORSO: ['Bip01 Spine', 'Bip01 Spine1', 'Bip01 Pelvis'],
  EBOLT_PELVIS: ['Bip01 Pelvis'],
  EBOLT_ROOT: ['Bip01'],
  EBOLT_HEAD: ['Bip01 Head'],
  EBOLT_NECK: ['Bip01 Neck'],
  EBOLT_LFOOT: ['Bip01 L Foot'],
  EBOLT_RFOOT: ['Bip01 R Foot'],
  EBOLT_LFOOTATTACH01: ['Bip01 L FootAttach01', 'Bip01 L Foot'],
  EBOLT_RFOOTATTACH01: ['Bip01 R FootAttach01', 'Bip01 R Foot'],
  EBOLT_LFOREARM: ['Bip01 L Forearm'],
  EBOLT_RFOREARM: ['Bip01 R Forearm'],
  EBOLT_LFOREARMATTACH01: ['Bip01 L ForearmAttach01', 'Bip01 L Forearm'],
  EBOLT_LFOREARMATTACH02: ['Bip01 L ForearmAttach02', 'Bip01 L ForearmAttach01', 'Bip01 L Forearm'],
  EBOLT_RFOREARMATTACH: ['Bip01 R ForearmAttach', 'Bip01 R Forearm'],
  EBOLT_RFOREARMATTACH01: ['Bip01 R ForearmAttach01', 'Bip01 R Forearm'],
  EBOLT_LUPPERARM: ['Bip01 L UpperArm'],
  EBOLT_RUPPERARM: ['Bip01 R UpperArm'],
  EBOLT_LCLAVICLE: ['Bip01 L Clavicle'],
  EBOLT_RCLAVICLE: ['Bip01 R Clavicle'],
  EBOLT_LTHIGH: ['Bip01 L Thigh'],
  EBOLT_RTHIGH: ['Bip01 R Thigh'],
  EBOLT_LCALF: ['Bip01 L Calf'],
  EBOLT_RCALF: ['Bip01 R Calf'],
  EBOLT_LANKLE: ['Bip01 L Foot', 'Bip01 L Calf'],
  EBOLT_RANKLE: ['Bip01 R Foot', 'Bip01 R Calf'],
  EBOLT_LHIPATTACH: ['Bip01 L HipAttach', 'Bip01 Pelvis'],
  EBOLT_RHIPATTACH: ['Bip01 R HipAttach', 'Bip01 Pelvis'],
  EBOLT_LSHOULDERATTACH: ['Bip01 L ShoulderAttach', 'Bip01 L UpperArm'],
  EBOLT_RSHOULDERATTACH: ['Bip01 R ShoulderAttach', 'Bip01 R UpperArm'],
  EBOLT_CARRYATTACH: ['Bip01 CarryAttach', 'Bip01 R Hand'],
  EBOLT_OBJECT_TRANSFORM: [],
  EBOLT_ORIGIN: [],
  EBOLT_NONE: [],
  EBOLT_BOLTBASE: [],
  EBOLT_BOLTEND: [],
  EBOLT_SPECIAL1: ['Bip01 Spine2', 'Bip01 Spine'],
  EBOLTON_WEAPON: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_ALT_WEAPON: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_ALT_WEAPON2: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_ALT_WEAPON3: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_ALT_WEAPON4: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_ALT_WEAPON5: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_CLAW_LEFT: ['Bip01 L HandAttach', 'Bip01 L Hand'],
  EBOLTON_CLAW_RIGHT: ['Bip01 R HandAttach', 'Bip01 R Hand'],
  EBOLTON_CAPE: ['Bip01 Spine2', 'Bip01 Spine'],
  EBOLTON_HAIR: ['Bip01 Head'],
  EBOLTON_TAIL: ['Bip01 Pelvis'],
  EBOLTON_WINGS: ['Bip01 Spine2', 'Bip01 Spine'],
  EBOLTON_NONE: [],
  EBOLTON_MAX: [],
};
for (let index = 1; index <= 7; index += 1) {
  BOLT_CANDIDATES[`EBOLT_FX${String(index).padStart(2, '0')}`] = [`fx${String(index).padStart(2, '0')}`, 'Bip01 Spine2', 'Bip01 Spine'];
}
for (let index = 1; index <= 5; index += 1) {
  BOLT_CANDIDATES[`EBOLT_BOLT${String(index).padStart(2, '0')}`] = [`Bolt_${String(index).padStart(2, '0')}`, 'Bip01 Spine2', 'Bip01 Spine'];
}
export function resolveBoltCandidates(label) {
  if (typeof label !== 'string' || !label.trim()) return [];
  const raw = label.trim();
  const upper = raw.toUpperCase();
  if (Object.hasOwn(BOLT_CANDIDATES, upper)) return [...BOLT_CANDIDATES[upper]];
  if (upper.startsWith('EBOLT_FX')) {
    const index = Number(upper.split('FX').pop()) || 1;
    return [`fx${String(index).padStart(2, '0')}`, 'Bip01 Spine2', 'Bip01 Spine'];
  }
  if (upper.startsWith('EBOLT_BOLT')) {
    const index = Number(upper.split('BOLT').pop()) || 1;
    return [`Bolt_${String(index).padStart(2, '0')}`, 'Bip01 Spine2', 'Bip01 Spine'];
  }
  if (upper.startsWith('EBOLT_FLOAT')) return ['Bip01 Spine2', 'Bip01 Spine'];
  if (upper.startsWith('EBOLT_')) return ['Bip01 Spine2', 'Bip01 Spine', 'Bip01 Pelvis'];
  if (raw.toLowerCase() === 'bip01') return ['Bip01'];
  if (raw.toLowerCase() === 'motion') return ['Motion', 'Bip01'];
  if (/^fx0?\d+$/i.test(raw)) {
    const index = Number(raw.replace(/\D/g, '')) || 1;
    return [`fx${String(index).padStart(2, '0')}`, 'Bip01 Spine2', 'Bip01 Spine'];
  }
  return [raw];
}

/**
 * Plan how an effect may be anchored/played for the currently loaded model.
 *
 * Sources of truth (in order):
 *  1. assets/vfx/action_map.json (powerstyles/*.muc) -> actor, clip, trigger, bone.
 *  2. effects.json `character`/`modelIds` -> ownership.
 *  3. The effect category -> scenery effects never anchor on a character.
 *
 * Returns a serialisable plan; `suspended` means the effect belongs to another
 * character and no representative model exists to load, so it must not render.
 */
export function planEffectBinding(effect, {
  actionMap = null,
  loadedModel = null,
  models = [],
  isProp = () => false,
  modelCharacter = null,
} = {}) {
  const base = {
    effectId: effect?.id || null,
    effectCharacter: effect?.character || null,
    actors: [],
    actor: null,
    entry: null,
    clip: null,
    animEnum: null,
    time: null,
    triggerTime: 0,
    persistent: false,
    kind: null,
    bolt: null,
    bone: null,
    boneCandidates: [],
    anchor: null,
    loadedCharacter: null,
    targetCharacter: null,
    targetModel: null,
    targetModelId: null,
    compatible: false,
    ownerModelMatch: false,
    requiresModelLoad: false,
    suspended: false,
    anchorMode: 'origin',
    hasAction: false,
    scenery: false,
    clipAvailable: null,
    recipient: 'caster',
  };
  if (!effect) return base;

  const characters = actionMap?.characters || {};
  const entries = Array.isArray(actionMap?.effects?.[effect.id]) ? actionMap.effects[effect.id] : [];
  const actors = Array.isArray(actionMap?.actors?.[effect.id]) ? actionMap.actors[effect.id].slice() : [];
  const effectModels = Array.isArray(effect.modelIds) ? effect.modelIds : [];
  const loadedId = loadedModel?.id || null;

  const characterFor = (model) => {
    if (!model) return null;
    if (typeof modelCharacter === 'function') {
      const resolved = modelCharacter(model);
      if (resolved) return resolved;
    }
    const id = model.id;
    for (const [name, info] of Object.entries(characters)) {
      if (info?.representativeModel === id || (info?.modelIds || []).includes(id)) return name;
    }
    return null;
  };

  const loadedCharacter = characterFor(loadedModel);
  const propMatch = Boolean(loadedId && loadedModel && isProp(loadedModel) && effectModels.includes(loadedId));
  const explicitOwner = Boolean(effect.character) || effectModels.length > 0;
  const scenery = !propMatch && SCENERY_CATEGORIES.has(effect.category);

  let actor = null;
  if (loadedCharacter && actors.includes(loadedCharacter)) actor = loadedCharacter;
  else if (effect.character && actors.includes(effect.character)) actor = effect.character;
  else if (actors.length) actor = actors[0];
  else if (effect.character) actor = effect.character;

  const score = (entry) => {
    let value = 0;
    if (entry?.kind === 'fx_core') value += 4;
    if (entry?.anchor === 'bone' && entry?.bone) value += 3;
    else if (entry?.anchor === 'bone') value += 1;
    if (entry?.clip) value += 2;
    if (Number.isFinite(entry?.time) && entry.time >= 0) value += 1;
    if (entry?.boltResolved) value += 0.5;
    return value;
  };
  const actorEntries = entries.filter((entry) => entry.actor === actor);
  const pool = actorEntries.length ? actorEntries : entries;
  const entry = pool.slice().sort((a, b) => score(b) - score(a))[0] || null;

  let targetCharacter = null;
  if (!scenery && explicitOwner) targetCharacter = effect.character || actor || null;

  // Candidate models for the owning character. `action_map.characters` is the
  // primary source; `effects.json modelIds` is the fallback when the powerstyle
  // map has no entry (or failed to load).
  let targetModel = null;
  if (!scenery && explicitOwner) {
    const info = characters[targetCharacter];
    const candidateIds = [];
    if (info?.representativeModel) candidateIds.push(info.representativeModel);
    if (!targetCharacter || effect.character === targetCharacter) {
      for (const id of effectModels) if (!candidateIds.includes(id)) candidateIds.push(id);
    }
    for (const id of (info?.modelIds || [])) if (!candidateIds.includes(id)) candidateIds.push(id);
    for (const id of candidateIds) {
      const found = models.find((model) => model.id === id);
      if (found) {
        targetModel = found;
        break;
      }
    }
  }

  const ownerMatch = Boolean(loadedCharacter && targetCharacter && loadedCharacter === targetCharacter);
  const actorMatch = Boolean(loadedCharacter && actors.includes(loadedCharacter));
  const ownerModelMatch = Boolean(loadedId && effectModels.includes(loadedId));
  const compatible = Boolean(loadedModel) && !scenery && (propMatch || ownerModelMatch || ownerMatch || actorMatch);

  const requiresModelLoad = !scenery && explicitOwner && !compatible && Boolean(targetModel);
  const suspended = !scenery && explicitOwner && !compatible && !targetModel;

  const recipient = entry?.recipient || 'caster';
  const isNonCaster = recipient !== 'caster';

  let anchorMode = 'origin';
  if (compatible && !isNonCaster) {
    anchorMode = entry?.anchor === 'bone' && (entry?.bone || entry?.boneCandidates?.length)
      ? 'bone'
      : (entry?.anchor === 'origin' ? 'origin' : 'model');
  }

  const bolt = !isNonCaster ? (entry?.bolt || null) : null;
  const bone = !isNonCaster ? (entry?.bone || null) : null;
  const boneCandidates = !isNonCaster && Array.isArray(entry?.boneCandidates) && entry.boneCandidates.length
    ? entry.boneCandidates.slice()
    : (!isNonCaster ? resolveBoltCandidates(bolt || bone) : []);

  return {
    ...base,
    actors,
    actor,
    entry,
    clip: entry?.clip || null,
    animEnum: entry?.animEnum || null,
    time: Number.isFinite(entry?.time) ? entry.time : null,
    triggerTime: Number.isFinite(entry?.time) && entry.time > 0 ? entry.time : 0,
    persistent: Boolean(entry?.persistent) || (Number.isFinite(entry?.time) && entry.time < 0),
    kind: entry?.kind || null,
    bolt,
    bone,
    boneCandidates,
    anchor: isNonCaster ? 'origin' : (entry?.anchor || null),
    recipient,
    loadedCharacter,
    targetCharacter,
    targetModel,
    targetModelId: targetModel?.id || null,
    compatible,
    ownerModelMatch,
    requiresModelLoad,
    suspended,
    anchorMode,
    hasAction: Boolean(entry),
    scenery,
    clipAvailable: null,
  };
}


function createFallbackGlowTexture(THREE) {
  if (typeof document === 'undefined' || !THREE) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.8)');
  grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.25)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ========================================================
// PRIMITIVE RUNNER (WebGL Alchemy Interpreter)
// ========================================================

class VfxPrimitiveRunner {
  constructor(primitive, runtime, effectThumb) {
    this.primitive = primitive;
    this.runtime = runtime;
    this.THREE = runtime.THREE;
    this.delay = Math.max(0, primitive.delay || 0);
    this.life = Math.max(0.1, primitive.life > 0 ? primitive.life : runtime.loopTime);
    this.mesh = null;
    this.particles = null;
    this.soundPlayed = false;
    this.shakeTriggered = false;
    this.ownedTexture = null;
    this.disposed = false;
    this.ownedGeometries = [];
    this.ownedMaterials = [];
    this.trail = null;
    this.isScreenFlash = false;
    this.screenSpace = false;

    if (!this.THREE) return;

    const texPath = runtime.resolveTexturePath(primitive.shaderTextures, effectThumb);
    this.texture = runtime.loadTexture(texPath);
    const scroll = primitive.scrollVelocity || [0, 0, 0];
    if (this.texture && (scroll[0] !== 0 || scroll[1] !== 0)) {
      this.texture = this.texture.clone();
      this.texture.needsUpdate = true;
      this.ownedTexture = this.texture;
    }
    this.isDistortion = primitive.shaderName === 'ScreenDistortion';
    this.blendMode = resolveBlendMode(primitive.blendMode, this.THREE, primitive.shaderName);

    this._createMesh();
  }

  _createMesh() {
    const THREE = this.THREE;
    const p = this.primitive;
    const baseSize = this._fallbackSize();

    switch (p.typeName) {
      case 'FXPRIM_TYPE_SPRITE':
      case 'FXPRIM_TYPE_FLARE':
      case 'FXPRIM_TYPE_SCREEN_SPRITE':
      case 'FXPRIM_TYPE_HAVOK_SPRITE':
      case 'FXPRIM_TYPE_ENTITY': {
        const mat = new THREE.SpriteMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
        });
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Sprite(mat);
        this.mesh.scale.set(baseSize, baseSize, 1);
        break;
      }

      case 'FXPRIM_TYPE_TRAIL': {
        // Ribbons are built from the anchor's world-space history so they
        // follow the animation instead of staying glued to the bone. The
        // buffer covers one second at the 30 Hz sample rate; the history
        // window comes from the authentic primitive life (clamped so a 12 s
        // web strand does not turn into a two-second motion smear).
        const count = 64;
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 2 * 3);
        const uvs = new Float32Array(count * 2 * 2);
        const indices = [];
        for (let i = 0; i < count; i += 1) {
          const v = i / (count - 1);
          uvs[i * 4] = 0;
          uvs[i * 4 + 1] = v;
          uvs[i * 4 + 2] = 1;
          uvs[i * 4 + 3] = v;
          if (i < count - 1) {
            const a = i * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geom.setIndex(indices);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 10;
        this.screenSpace = true;
        this.trail = {
          points: [],
          maxPoints: count,
          width: baseSize,
          history: Math.max(0.15, Math.min(1, Number(p.life) || TRAIL_HISTORY_SECONDS)),
          clock: 0,
          anchor: new THREE.Vector3(),
          tangent: new THREE.Vector3(),
          side: new THREE.Vector3(),
          toCamera: new THREE.Vector3(),
        };
        break;
      }

      case 'FXPRIM_TYPE_SCREENFLASH': {
        const geom = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
          toneMapped: false,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 9999;
        this.screenSpace = true;
        this.isScreenFlash = true;
        break;
      }

      case 'FXPRIM_TYPE_ORIENTED_SPRITE': {
        const geom = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Mesh(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        const geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.isDistortion ? THREE.AdditiveBlending : (this.blendMode === THREE.NormalBlending ? THREE.AdditiveBlending : this.blendMode),
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.rotation.x = Math.PI / 2;
        break;
      }

      case 'FXPRIM_TYPE_PARTICLE_CLOUD':
      case 'FXPRIM_TYPE_SPARK':
      case 'FXPRIM_TYPE_WEATHERFX': {
        const count = Math.min(48, Math.max(6, Math.round(p.count || 16)));
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        this.particles = [];

        for (let i = 0; i < count; i++) {
          const theta = Math.random() * Math.PI * 2;
          const phi = (Math.random() - 0.5) * Math.PI;
          const dist = Math.random() * (baseSize * 0.5);
          const px = Math.cos(phi) * Math.cos(theta) * dist;
          const py = Math.sin(phi) * dist;
          const pz = Math.cos(phi) * Math.sin(theta) * dist;

          const speed = (0.5 + Math.random()) * Math.max(0.5, baseSize * 0.4);
          this.particles.push({
            pos: new THREE.Vector3(px, py, pz),
            basePos: new THREE.Vector3(px, py, pz),
            vel: new THREE.Vector3(px, py + 0.2, pz).normalize().multiplyScalar(speed),
            seed: Math.random(),
          });

          positions[i * 3] = px;
          positions[i * 3 + 1] = py;
          positions[i * 3 + 2] = pz;
          colors[i * 3] = 1;
          colors[i * 3 + 1] = 1;
          colors[i * 3 + 2] = 1;
        }

        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const mat = new THREE.PointsMaterial({
          size: Math.max(this.runtime.worldScale * 0.3, baseSize * 0.18),
          map: this.texture,
          vertexColors: true,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          sizeAttenuation: true,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Points(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_LINE':
      case 'FXPRIM_TYPE_LIGHTNING':
      case 'FXPRIM_TYPE_BEZIER': {
        const segCount = 10;
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(segCount * 3);

        for (let i = 0; i < segCount; i++) {
          positions[i * 3] = 0;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = i / (segCount - 1);
        }
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          blending: this.blendMode,
          linewidth: 2,
        });
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Line(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_LIGHT': {
        const color = parseHexColor(p.colors?.start1);
        const light = new THREE.PointLight(
          new THREE.Color(color.r, color.g, color.b),
          1.5,
          Math.max(this.runtime.worldScale * 24, baseSize * 5)
        );
        this.mesh = light;
        break;
      }

      case 'FXPRIM_TYPE_HAVOKMODEL':
      case 'FXPRIM_TYPE_MODEL': {
        const group = new THREE.Group();
        this.mesh = group;

        if (p.modelRef && typeof this.runtime.loadVfxModel === 'function') {
          this.runtime.loadVfxModel(p.modelRef, (clonedScene) => {
            if (this.disposed || !this.mesh) return;
            const prev = group.getObjectByName('_vfx_fallback');
            if (prev) {
              group.remove(prev);
              if (prev.geometry) prev.geometry.dispose();
              if (prev.material) prev.material.dispose();
            }
            clonedScene.traverse((obj) => {
              if (obj.isMesh && obj.material) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                const cloned = mats.map((m) => {
                  const cm = m.clone();
                  this.ownedMaterials.push(cm);
                  cm.transparent = true;
                  cm.depthWrite = false;
                  if (this.blendMode !== THREE.NormalBlending) {
                    cm.blending = this.blendMode;
                  }
                  return cm;
                });
                obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
              }
            });
            group.add(clonedScene);
          });
        }
        break;
      }

      case 'FXPRIM_TYPE_CAMERA_SHAKE':
      case 'FXPRIM_TYPE_SOUND':
      default:
        // Unsupported renderers stay invisible; never substitute invented meshes.
        break;
    }

    if (this.mesh) {
      this.mesh.visible = false;
      const parent = this.screenSpace && this.runtime.scene ? this.runtime.scene : this.runtime.root;
      parent.add(this.mesh);
    }
  }

  _fallbackSize() {
    // rqSize is authoritative. Radius is only a last-resort authored fallback
    // and is stored in metres by Alchemy, hence the conversion to local units
    // before the measured rig scale turns it back into metres.
    const radius = Number(this.primitive.radius) || 0;
    const local = radius > 0 ? radius * METERS_TO_INCHES : DEFAULT_PRIMITIVE_SIZE_IN;
    return local * this.runtime.worldScale;
  }

  _curveSize(progress) {
    const curve = evaluateQuadratic(this.primitive.rqSize, progress, null);
    return curve === null ? null : Math.abs(curve) * this.runtime.worldScale;
  }

  _lengthFactor(progress) {
    const curve = evaluateQuadratic(this.primitive.rqLength, progress, null);
    return curve !== null && curve > 0 ? curve : 1;
  }

  update(cycleTime, delta) {
    const localTime = cycleTime - this.delay;
    if (localTime < 0 || localTime >= this.life) {
      if (this.mesh) this.mesh.visible = false;
      return;
    }

    const p = this.primitive;

    // Audio playback trigger at start of active window
    if (!this.soundPlayed && (p.soundBank || p.soundName)) {
      this.soundPlayed = true;
      this.runtime.playSound(p.soundBank, p.soundName);
    }

    // Camera shake trigger
    if (!this.shakeTriggered && p.shakeScale > 0) {
      this.shakeTriggered = true;
      this.runtime.triggerCameraShake(p.shakeSpeed, p.shakeScale, p.shakeType);
    }

    if (!this.mesh) return;
    this.mesh.visible = true;

    const progress = Math.max(0, Math.min(1, localTime / this.life));
    const color = evaluateColorRamp(this.primitive.colors, progress);
    const scroll = this.primitive.scrollVelocity || [0, 0, 0];

    // Authentic quadratic curve evaluation for size, length, and alpha
    const curAlphaVal = evaluateQuadratic(p.rqAlpha, progress, color.a);
    const curAlpha = this.isDistortion ? Math.min(curAlphaVal, 0.25) : Math.max(0, Math.min(1, curAlphaVal));

    // Texture UV scrolling
    if (this.ownedTexture?.offset && (scroll[0] !== 0 || scroll[1] !== 0)) {
      this.ownedTexture.offset.x = (this.ownedTexture.offset.x + scroll[0] * delta) % 1.0;
      this.ownedTexture.offset.y = (this.ownedTexture.offset.y + scroll[1] * delta) % 1.0;
    }

    const baseSize = this._fallbackSize();
    const sizeCurve = this._curveSize(progress);
    const size = sizeCurve !== null ? Math.max(0.001, sizeCurve) : baseSize;
    const lengthFactor = this._lengthFactor(progress);
    const height = Math.max(0.001, size * lengthFactor);

    switch (p.typeName) {
      case 'FXPRIM_TYPE_SPRITE':
      case 'FXPRIM_TYPE_FLARE':
      case 'FXPRIM_TYPE_SCREEN_SPRITE':
      case 'FXPRIM_TYPE_HAVOK_SPRITE':
      case 'FXPRIM_TYPE_ENTITY': {
        this.mesh.scale.set(size, size, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_TRAIL': {
        this._updateTrail(size, curAlpha, color, delta);
        break;
      }

      case 'FXPRIM_TYPE_SCREENFLASH': {
        this._updateScreenFlash(curAlpha, color);
        break;
      }

      case 'FXPRIM_TYPE_ORIENTED_SPRITE': {
        this.mesh.scale.set(size, height, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        if (scroll[2]) this.mesh.rotation.z += scroll[2] * delta;
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        this.mesh.scale.set(size, height, size);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_PARTICLE_CLOUD':
      case 'FXPRIM_TYPE_SPARK':
      case 'FXPRIM_TYPE_WEATHERFX': {
        if (!this.particles) break;
        this.mesh.scale.setScalar(Math.max(0.001, size / Math.max(0.001, baseSize)));
        if (this.mesh.material) {
          this.mesh.material.size = Math.max(this.runtime.worldScale * 0.3, size * 0.18);
        }
        const geom = this.mesh.geometry;
        const posAttr = geom.attributes.position;
        const colAttr = geom.attributes.color;
        const positions = posAttr.array;
        const colors = colAttr.array;
        const grav = p.gravity || 0;
        const drag = p.drag || 0;

        for (let i = 0; i < this.particles.length; i++) {
          const pt = this.particles[i];
          pt.vel.y -= grav * 3.0 * delta;
          pt.vel.multiplyScalar(Math.max(0, 1.0 - drag * delta * 1.5));
          pt.pos.addScaledVector(pt.vel, delta);

          positions[i * 3] = pt.pos.x;
          positions[i * 3 + 1] = pt.pos.y;
          positions[i * 3 + 2] = pt.pos.z;

          colors[i * 3] = color.r;
          colors[i * 3 + 1] = color.g;
          colors[i * 3 + 2] = color.b;
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_LINE':
      case 'FXPRIM_TYPE_LIGHTNING':
      case 'FXPRIM_TYPE_BEZIER': {
        const posAttr = this.mesh.geometry.attributes.position;
        const positions = posAttr.array;
        const segCount = positions.length / 3;
        const isLightning = p.typeName === 'FXPRIM_TYPE_LIGHTNING';
        const length = size * (lengthFactor > 1 ? lengthFactor : 3);

        for (let i = 1; i < segCount - 1; i++) {
          if (isLightning) {
            positions[i * 3] = (Math.random() - 0.5) * 0.05 * size;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 0.05 * size;
          }
        }
        posAttr.needsUpdate = true;
        this.mesh.scale.set(1, 1, length);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_LIGHT': {
        this.mesh.color.setRGB(color.r, color.g, color.b);
        this.mesh.intensity = curAlpha * 2.0;
        this.mesh.distance = Math.max(this.runtime.worldScale * 24, size * 5);
        break;
      }

      case 'FXPRIM_TYPE_HAVOKMODEL':
      case 'FXPRIM_TYPE_MODEL': {
        // A model's rqSize is a dimensionless multiplier of its exported
        // native size (1747 of 2380 primitives author exactly 1.0 = as-is).
        // Applying the rig world scale here would shrink every prop to 1/50.
        const rawSize = evaluateQuadratic(p.rqSize, progress, null);
        const curScale = rawSize !== null && Math.abs(rawSize) > 1e-6 ? Math.abs(rawSize) : 1.0;
        this.mesh.scale.set(curScale, curScale, curScale);
        this.mesh.traverse((obj) => {
          if (obj.isMesh && obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of mats) {
              if (mat.color) mat.color.setRGB(color.r, color.g, color.b);
              mat.opacity = curAlpha;
            }
          }
        });
        break;
      }

      default: {
        const curScale = sizeCurve !== null && sizeCurve > 0 ? sizeCurve : size;
        this.mesh.scale.set(curScale, curScale, curScale);
        if (this.mesh.material) {
          this.mesh.material.color.setRGB(color.r, color.g, color.b);
          this.mesh.material.opacity = curAlpha * (1.0 - progress);
        }
        break;
      }
    }
  }

  _updateTrail(size, alpha, color, delta) {
    const trail = this.trail;
    if (!trail || !this.mesh) return;
    trail.clock += delta;

    const root = this.runtime.root;
    if (root && typeof root.getWorldPosition === 'function') {
      root.getWorldPosition(trail.anchor);
    } else {
      trail.anchor.set(0, 0, 0);
    }

    const points = trail.points;
    const last = points[points.length - 1];
    // Sample at a fixed cadence so the ribbon length does not depend on the
    // frame rate, and skip stationary frames so an idle anchor collapses
    // instead of stacking points on top of each other.
    const due = !last || trail.clock - last.t >= TRAIL_SAMPLE_INTERVAL;
    const moved = !last || last.pos.distanceToSquared(trail.anchor) > 1e-4;
    if (due && moved) {
      points.push({ pos: trail.anchor.clone(), t: trail.clock });
    }
    const history = Number(trail.history) > 0 ? trail.history : TRAIL_HISTORY_SECONDS;
    while (points.length && trail.clock - points[0].t > history) {
      points.shift();
    }
    while (points.length > trail.maxPoints) points.shift();

    const count = points.length;
    const geom = this.mesh.geometry;
    if (count < 2) {
      this.mesh.visible = false;
      if (typeof geom.setDrawRange === 'function') geom.setDrawRange(0, 0);
      return;
    }

    const posAttr = geom.attributes.position;
    const uvAttr = geom.attributes.uv;
    const positions = posAttr.array;
    const uvs = uvAttr?.array || null;
    const camera = this.runtime.camera;
    const side = trail.side;
    const tangent = trail.tangent;
    const toCamera = trail.toCamera;
    // Half a metre is the floor in local units, scaled like every other size.
    const halfWidth = Math.max(this.runtime.worldScale * 0.5, size * 0.5);

    for (let i = 0; i < count; i += 1) {
      const point = points[i].pos;
      const prev = points[Math.max(0, i - 1)].pos;
      const next = points[Math.min(count - 1, i + 1)].pos;
      tangent.copy(next).sub(prev);
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 1, 0);
      if (camera?.position) toCamera.copy(camera.position).sub(point);
      else toCamera.set(0, 0, 1);
      // Billboard the ribbon: the width axis is perpendicular to both the
      // path and the view ray, so the trail stays visible from any angle.
      side.copy(tangent).cross(toCamera);
      if (side.lengthSq() < 1e-8) side.set(0, 0, 1).cross(tangent);
      side.normalize();

      const taper = 0.15 + 0.85 * (i / (count - 1));
      const w = halfWidth * taper;
      const base = i * 6;
      positions[base] = point.x + side.x * w;
      positions[base + 1] = point.y + side.y * w;
      positions[base + 2] = point.z + side.z * w;
      positions[base + 3] = point.x - side.x * w;
      positions[base + 4] = point.y - side.y * w;
      positions[base + 5] = point.z - side.z * w;

      if (uvs) {
        const v = i / (count - 1);
        uvs[i * 4] = 0;
        uvs[i * 4 + 1] = v;
        uvs[i * 4 + 2] = 1;
        uvs[i * 4 + 3] = v;
      }
    }

    posAttr.needsUpdate = true;
    if (uvAttr) uvAttr.needsUpdate = true;
    if (typeof geom.setDrawRange === 'function') geom.setDrawRange(0, (count - 1) * 6);
    this.mesh.material.color.setRGB(color.r, color.g, color.b);
    this.mesh.material.opacity = alpha;
    this.mesh.visible = alpha > 0.001;
  }

  _updateScreenFlash(alpha, color) {
    if (!this.mesh) return;
    this.mesh.material.color.setRGB(color.r, color.g, color.b);
    this.mesh.material.opacity = alpha;
    const camera = this.runtime.camera;
    if (!camera?.position) {
      this.mesh.position.set(0, 0, 0);
      this.mesh.quaternion.identity();
      this.mesh.scale.set(100, 100, 1);
      return;
    }

    const THREE = this.THREE;
    const direction = this._flashDirection || (this._flashDirection = new THREE.Vector3());
    if (typeof camera.getWorldDirection === 'function') camera.getWorldDirection(direction);
    else direction.set(0, 0, -1);

    // Sit just in front of the camera and match the view frustum at that
    // distance, so the flash covers the screen without being clipped.
    const distance = 10;
    this.mesh.position.copy(camera.position).addScaledVector(direction, distance);
    this.mesh.quaternion.copy(camera.quaternion);
    const fov = Number.isFinite(camera.fov) ? camera.fov : 50;
    const height = 2 * Math.tan((fov * Math.PI) / 360) * distance;
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
    this.mesh.scale.set(height * aspect * 1.08, height * 1.08, 1);
    this.mesh.visible = alpha > 0.001;
  }

  reset() {
    this.soundPlayed = false;
    this.shakeTriggered = false;
    if (this.ownedTexture?.offset) {
      this.ownedTexture.offset.set(0, 0);
    }
    if (this.trail) {
      this.trail.points.length = 0;
      this.trail.clock = 0;
      if (this.mesh?.geometry && typeof this.mesh.geometry.setDrawRange === 'function') {
        this.mesh.geometry.setDrawRange(0, 0);
      }
      if (this.mesh) this.mesh.visible = false;
    }
    if (!this.particles) return;
    const geom = this.mesh?.geometry;
    if (!geom) return;
    const posAttr = geom.attributes.position;
    const positions = posAttr.array;

    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      pt.pos.copy(pt.basePos);
      const speed = (0.5 + Math.random()) * Math.max(0.5, (this.primitive.radius || 0.4) * 2.0);
      pt.vel.set(pt.basePos.x, pt.basePos.y + 0.2, pt.basePos.z).normalize().multiplyScalar(speed);

      positions[i * 3] = pt.pos.x;
      positions[i * 3 + 1] = pt.pos.y;
      positions[i * 3 + 2] = pt.pos.z;
    }
    posAttr.needsUpdate = true;
  }

  // Loop restart. A trail keeps its ribbon across cycles: the trail's own life
  // (often 1 s) outlives the template's loopTime (0.3 s), so clearing the
  // points on every wrap would leave the strip permanently at one or two
  // samples. Everything else restarts from scratch like a normal reset.
  resetCycle() {
    if (!this.trail) {
      this.reset();
      return;
    }
    this.soundPlayed = false;
    this.shakeTriggered = false;
    if (this.ownedTexture?.offset) {
      this.ownedTexture.offset.set(0, 0);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    for (const geom of this.ownedGeometries) {
      geom.dispose();
    }
    this.ownedGeometries = [];
    for (const mat of this.ownedMaterials) {
      mat.dispose();
    }
    this.ownedMaterials = [];
    if (this.ownedTexture) {
      this.ownedTexture.dispose();
      this.ownedTexture = null;
    }
    this.mesh = null;
    this.particles = null;
    this.trail = null;
  }
}

// ========================================================
// VFX WEBGL RUNTIME ENGINE
// ========================================================

export class VfxRuntime {
  constructor({
    scene = null,
    camera = null,
    renderer = null,
    controls = null,
    gltfLoader = null,
    getMixer = () => null,
    getCurrentAction = () => null,
    getAnimPlaying = () => false,
    getAnimClips = () => null,
    applyAnimation = () => {},
    getModel = () => null,
    THREE = null,
  } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.gltfLoader = gltfLoader;
    this.getMixer = getMixer;
    this.getCurrentAction = getCurrentAction;
    this.getAnimPlaying = getAnimPlaying;
    this.getAnimClips = getAnimClips;
    this.applyAnimation = applyAnimation;
    this.getModel = getModel;
    this.THREE = THREE || (typeof window !== 'undefined' && window.THREE ? window.THREE : null);

    this.root = null;
    if (this.scene && this.THREE) {
      this.root = new this.THREE.Group();
      this.root.name = 'VfxRuntimeRoot';
      this.scene.add(this.root);
    }

    this.activeEffect = null;
    this.primitives = [];
    this.runners = [];
    this.nativeEffect = null;
    this.isPlaying = false;
    this.isLooping = true;
    this.speed = 1.0;
    this.elapsed = 0.0;
    this.loopTime = 1.0;
    // Longest primitive end (delay + life). A template's loopTime is often
    // much shorter than its own primitives (a ram attack triggers a rigid
    // body 1 s in and keeps it for 16 s), so the timeline must not truncate
    // at loopTime or that primitive never renders.
    this.duration = 0.0;

    // Animation sync
    this.syncAnimation = true;
    this.lastSyncTime = null;

    // Camera shake
    this.shakeDuration = 0.0;
    this.shakeTotalDuration = 0.0;
    this.shakeSpeed = 0.0;
    this.shakeScale = 0.0;
    this.shakeType = 0;
    this.shakeOffset = this.THREE ? new this.THREE.Vector3() : null;
    this.shakeApplied = false;

    // Audio playback (FMOD extracted samples)
    this.audioEnabled = true;
    this.soundMap = null;
    this.soundVolume = 0.7;
    this.activeAudio = [];

    // Mesh models (.igb -> .glb)
    this.modelMap = null;
    this.modelCache = new Map();

    this.attachmentSlot = 'Origem';
    this.attachmentBoneName = null;
    // Alchemy effect sizes are authored in rig-local units. The decoded GLBs
    // bake the unit conversion into a scaled root node, so the runtime
    // measures that world scale per model and feeds it to every primitive.
    this.worldScale = WORLD_UNIT_METERS;
    this.worldScaleSource = null;
    this.isGroundTarget = false;
    this.attachmentBone = null;
    this.attachmentBoneCandidates = [];
    this.anchorMode = 'bone';
    this.boneMissing = null;
    this.binding = null;
    this.triggerTime = 0;
    this.persistent = false;
    this.waitingForTrigger = false;
    this.waitingForClip = false;
    this.lastSyncLocal = null;
    this.suspensionReason = null;

    this.textureLoader = (this.THREE && typeof this.THREE.TextureLoader === 'function') ? new this.THREE.TextureLoader() : null;
    this.textureCache = new Map();
    this.textureMap = null;
    this.fallbackTexture = null;

    this._tempPos = (this.THREE && typeof this.THREE.Vector3 === 'function') ? new this.THREE.Vector3() : null;
    this._tempQuat = (this.THREE && typeof this.THREE.Quaternion === 'function') ? new this.THREE.Quaternion() : null;
    this._tempScale = (this.THREE && typeof this.THREE.Vector3 === 'function') ? new this.THREE.Vector3() : null;

    this._loadTextureMap();
    this._loadModelMap();
    this._loadSoundMap();
  }

  async _loadTextureMap() {
    try {
      const res = await fetch('assets/vfx/texture_map.json');
      if (res.ok) {
        this.textureMap = await res.json();
      }
    } catch {
      this.textureMap = {};
    }
  }

  async _loadModelMap() {
    try {
      const res = await fetch('assets/vfx/model_map.json');
      if (res.ok) {
        this.modelMap = await res.json();
      }
    } catch {
      this.modelMap = {};
    }
  }

  async _loadSoundMap() {
    try {
      const res = await fetch('assets/vfx/sound_map.json');
      if (res.ok) {
        this.soundMap = await res.json();
      }
    } catch {
      this.soundMap = {};
    }
  }

  resolveModelPath(modelRef) {
    if (!modelRef || typeof modelRef !== 'string') return null;
    const clean = modelRef.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.startsWith('assets/')) return clean;
    if (this.modelMap) {
      if (this.modelMap[clean]) return this.modelMap[clean];
      const lower = clean.toLowerCase();
      if (this.modelMap[lower]) return this.modelMap[lower];
      const base = lower.split('/').pop();
      if (this.modelMap[base]) return this.modelMap[base];
      const noExt = base.replace(/\.[^.]+$/, '');
      if (this.modelMap[noExt]) return this.modelMap[noExt];
    }
    // Only the exported GLBs in model_map exist on disk; the game's source
    // .igb paths (982 of 1184 refs) were never decoded, so guessing a path
    // here would only produce a 404 per missing model.
    return null;
  }

  loadVfxModel(modelRef, onLoad) {
    const path = this.resolveModelPath(modelRef);
    if (!path || !this.gltfLoader) return;
    if (this.modelCache.has(path)) {
      const cached = this.modelCache.get(path);
      onLoad(cached.clone(true));
      return;
    }
    this.gltfLoader.load(
      path,
      (gltf) => {
        this.modelCache.set(path, gltf.scene);
        onLoad(gltf.scene.clone(true));
      },
      undefined,
      () => {
        // Fallback or missing model handled silently
      }
    );
  }

  playSound(soundBank, soundName) {
    if (!this.audioEnabled || typeof window === 'undefined') return;
    if (!soundBank || /^(?:textures|materials|models|luts)\/|lut_blank|\.(?:tga|png|dds|igb|igz)$/i.test(soundBank)) return;
    let url = null;
    if (this.soundMap && soundBank) {
      const bankKey = soundBank.toLowerCase().replace(/\\/g, '/').split('/').pop().replace(/\.(?:mp3|wav)$/i, '');
      const bankData = this.soundMap[bankKey] || this.soundMap[`${bankKey}_bank`];
      if (bankData && typeof bankData === 'object') {
        const sKey = (soundName || '').toLowerCase().trim().replace(/\.(?:mp3|wav)$/i, '');
        url = bankData[sKey] || bankData[sKey.replace(/_(0?1)$/, '')] || bankData.default;
      }
    }
    if (!url && soundBank) {
      const bankClean = soundBank.toLowerCase().replace(/\\/g, '/').split('/').pop().replace(/\.(?:mp3|wav)$/i, '');
      const sClean = soundName ? soundName.toLowerCase().replace(/\\/g, '/').split('/').pop().replace(/\.(?:mp3|wav)$/i, '') : bankClean;
      url = `assets/vfx/sounds/${bankClean}_bank/${sClean}.wav`;
    }
    if (!url) return;

    try {
      const audio = new Audio(url);
      audio.volume = this.soundVolume;
      const removeAudio = () => {
        const idx = this.activeAudio.indexOf(audio);
        if (idx !== -1) this.activeAudio.splice(idx, 1);
      };
      audio.onended = removeAudio;
      audio.onerror = removeAudio;
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          removeAudio();
        });
      }
      this.activeAudio.push(audio);
    } catch {
      // Audio autoplay policy or init error
    }
  }

  setAudioEnabled(enabled) {
    this.audioEnabled = Boolean(enabled);
    if (!this.audioEnabled) {
      for (const audio of this.activeAudio) {
        try { audio.pause(); } catch {}
      }
      this.activeAudio = [];
    }
  }

  triggerCameraShake(speed, scale, type = 0) {
    if (!this.camera || scale <= 0) return;
    this.shakeSpeed = speed > 0 ? speed : 15.0;
    this.shakeScale = scale;
    this.shakeType = type;
    this.shakeDuration = 0.35;
    this.shakeTotalDuration = 0.35;
  }

  restoreCamera() {
    if (this.camera && this.shakeOffset && this.shakeApplied) {
      this.camera.position.sub(this.shakeOffset);
      this.shakeApplied = false;
    }
  }

  resolveTexturePath(shaderTextures, thumb) {
    if (this.textureMap && Array.isArray(shaderTextures)) {
      for (const st of shaderTextures) {
        if (!st || typeof st !== 'string') continue;
        const normalized = st.replace(/\\/g, '/').toLowerCase();
        const base = normalized.split('/').pop();
        if (!base) continue;
        if (this.textureMap[base]) return this.textureMap[base];
        const noExt = base.replace(/\.[^.]+$/, '');
        if (this.textureMap[noExt]) return this.textureMap[noExt];
      }
    }
    if (thumb && typeof thumb === 'string') return thumb;
    return null;
  }

  loadTexture(path) {
    if (!this.THREE || !this.textureLoader) return null;
    if (!path) {
      if (!this.fallbackTexture) {
        this.fallbackTexture = createFallbackGlowTexture(this.THREE);
      }
      return this.fallbackTexture;
    }
    if (this.textureCache.has(path)) {
      return this.textureCache.get(path);
    }
    const tex = this.textureLoader.load(path);
    tex.wrapS = this.THREE.RepeatWrapping;
    tex.wrapT = this.THREE.RepeatWrapping;
    this.textureCache.set(path, tex);
    return tex;
  }

  // Timeline length actually played: the template cycle, extended to cover
  // primitives that outlive it (80.6% of the catalog) so nothing is cut off.
  get playDuration() {
    return Math.max(this.loopTime, this.duration);
  }

  setEffect(effect, { binding = null } = {}) {
    this.stop();
    this.activeEffect = effect;
    this.binding = binding || null;
    this.suspensionReason = binding?.suspended ? (binding.suspensionReason || 'modelo incompatível') : null;
    if (!effect || !effect.definition) {
      this.primitives = [];
      this.duration = 0.0;
      return;
    }

    const tmpl = effect.definition.templates?.[0];
    const prims = Array.isArray(effect.definition.primitives) ? effect.definition.primitives : [];
    this.primitives = prims;

    let loopTime = tmpl && typeof tmpl.loopTime === 'number' && tmpl.loopTime > 0 ? tmpl.loopTime : 0;
    if (loopTime <= 0) {
      loopTime = prims.reduce((max, p) => Math.max(max, (p.delay || 0) + (p.life || 1.0)), 1.0);
    }
    this.loopTime = Math.max(0.2, loopTime);
    this.duration = prims.reduce(
      (max, p) => Math.max(max, (p.delay || 0) + (p.life > 0 ? p.life : this.loopTime)),
      0,
    );
    this.isLooping = tmpl ? tmpl.persistLoop !== 0 : true;
    // Authentic bindings win over the name/texture heuristic. The heuristic is
    // only consulted for effects with no powerstyle entry at all.
    const target = resolveAttachmentTarget(effect.id, effect.textures);
    this.attachmentSlot = binding?.hasAction
      ? (binding.anchorMode === 'bone' ? 'Osso da ação' : binding.anchorMode === 'model' ? 'Modelo' : 'Origem')
      : target.slot;
    this.attachmentBoneName = binding?.hasAction ? binding.bone : (binding?.bone || target.boneName);
    this.attachmentBoneCandidates = binding?.hasAction
      ? (binding.boneCandidates || []).slice()
      : (target.candidates || []);
    this.isGroundTarget = binding ? binding.anchorMode === 'origin' : !!target.isGround;
    this.anchorMode = binding?.anchorMode || (this.isGroundTarget ? 'origin' : 'bone');
    this.triggerTime = Math.max(0, Number(binding?.triggerTime) || 0);
    this.persistent = Boolean(binding?.persistent);
    this.waitingForTrigger = false;
    this.waitingForClip = false;
    this.lastSyncLocal = null;
    this.rebindAttachment();

    // Instantiate primitive runners. Native recreations bypass the generic
    // runner: they build their own emitters from the same decoded values and
    // register as a runner so every timeline path (update/reset/dispose) works.
    if (effect && this.root && this.THREE) {
      const native = createNativeEffect(effect, this);
      if (native) {
        this.nativeEffect = native;
        this.runners.push(native);
      }
    }
    if (!this.nativeEffect && this.root && this.THREE) {
      for (const p of prims) {
        const runner = new VfxPrimitiveRunner(p, this, effect.thumb);
        this.runners.push(runner);
      }
    }

    if (this.nativeEffect) {
      // Native presets declare their own editorial duration; the timeline is
      // still the decoded primitive span, so nothing is cut off or invented.
      this.duration = Math.max(this.duration, this.nativeEffect.duration);
      this.isLooping = this.nativeEffect.loop;
    }

    this.elapsed = 0.0;
    this.isPlaying = Boolean(this.nativeEffect) || (prims.length > 0 && this.runners.length > 0);
  }

  measureWorldScale() {
    // The rig's root node carries the unit conversion, e.g. spiderman_root
    // 0.0283, hulk_root 0.0195. Sampling a skinned mesh (rather than the GLTF
    // scene) captures that scale without depending on the node's name.
    const model = this.getModel();
    const THREE = this.THREE;
    const reset = () => {
      this.worldScale = WORLD_UNIT_METERS;
      this.worldScaleSource = null;
      return this.worldScale;
    };
    if (!model || !THREE || typeof model.traverse !== 'function') return reset();
    if (typeof model.updateWorldMatrix === 'function') model.updateWorldMatrix(true, true);

    let skinned = null;
    let bone = null;
    model.traverse((node) => {
      if (!skinned && node.isSkinnedMesh) skinned = node;
      if (!bone && node.isBone) bone = node;
    });
    const sample = skinned || bone;
    if (!sample || typeof sample.getWorldScale !== 'function' || !this._tempScale) return reset();

    const scale = sample.getWorldScale(this._tempScale);
    const magnitude = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    if (!Number.isFinite(magnitude) || magnitude <= 0) return reset();

    this.worldScale = magnitude;
    this.worldScaleSource = sample.name || sample.type || null;
    return this.worldScale;
  }

  rebindAttachment() {
    this.measureWorldScale();
    this.attachmentBone = null;
    this.boneMissing = null;
    const model = this.getModel();
    if (!model) return;

    const mode = this.anchorMode || (this.isGroundTarget ? 'origin' : 'bone');
    if (mode === 'origin' || mode === 'model') return;

    const names = [];
    if (this.attachmentBoneName) names.push(this.attachmentBoneName);
    for (const name of this.attachmentBoneCandidates || []) {
      if (name && !names.includes(name)) names.push(name);
    }
    for (const name of names) {
      const bone = findBoneInModel(model, name);
      if (bone) {
        this.attachmentBone = bone;
        this.attachmentBoneName = name;
        return;
      }
    }

    // The bone is absent from this rig (e.g. HipAttach on the Spider-Man GLB).
    // Fall back to the nearest authentic spine bone and report the miss.
    this.boneMissing = names[0] || this.attachmentBoneName || null;
    for (const fallback of ['Bip01 Spine2', 'Bip01 Spine', 'Bip01 Pelvis', 'Bip01']) {
      const bone = findBoneInModel(model, fallback);
      if (bone) {
        this.attachmentBone = bone;
        this.attachmentBoneName = fallback;
        return;
      }
    }
  }

  _hideRunners() {
    for (const runner of this.runners) {
      if (runner.mesh) runner.mesh.visible = false;
      // A hidden trail must not bridge the gap to where the anchor resumes.
      if (runner.trail) {
        runner.trail.points.length = 0;
        runner.trail.clock = 0;
        if (typeof runner.mesh?.geometry?.setDrawRange === 'function') {
          runner.mesh.geometry.setDrawRange(0, 0);
        }
      }
    }
  }

  _finishOneShot() {
    this.elapsed = this.playDuration;
    this.isPlaying = false;
    this.waitingForTrigger = false;
    this.lastSyncTime = null;
    this.lastSyncLocal = null;
    this.restoreCamera();
    this.shakeDuration = 0;
    if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
    for (const audio of this.activeAudio) {
      try { audio.pause(); } catch {}
    }
    this.activeAudio = [];
    this._hideRunners();
  }

  onModelChange(newModel) {
    this.rebindAttachment();
  }

  update(delta) {
    if (!this.isPlaying || !this.root || !this.THREE) return;

    // Update root anchor transform
    const model = this.getModel();
    if (model && typeof model.updateWorldMatrix === 'function') {
      model.updateWorldMatrix(true, false);
    }
    if (this.attachmentBone) {
      this.attachmentBone.getWorldPosition(this._tempPos);
      this.attachmentBone.getWorldQuaternion(this._tempQuat);
      this.root.position.copy(this._tempPos);
      this.root.quaternion.copy(this._tempQuat);
    } else if (this.anchorMode === 'origin' || !model) {
      // Scenery/base effects with no authentic link stay at the world origin.
      this.root.position.set(0, this.isGroundTarget ? 0.02 : 0, 0);
      this.root.quaternion.identity();
    } else {
      // Model roots already sit at the character's feet (world unit = inch).
      model.getWorldPosition(this._tempPos);
      this.root.position.copy(this._tempPos);
      this.root.quaternion.identity();
    }

    // Step cycle: authentic clip + trigger time (_time from the powerstyle).
    // A binding is authoritative only for the authentic actor/owner; effects
    // without one keep the legacy "sync to the current clip" behaviour, and
    // effects whose clip is absent from this rig free-run instead of hiding.
    let action = null;
    if (this.syncAnimation && typeof this.getCurrentAction === 'function') {
      action = this.getCurrentAction();
    }
    const clip = action && typeof action.getClip === 'function' ? action.getClip() : null;
    const hasBinding = Boolean(this.binding);
    const authenticClip = hasBinding && this.binding.compatible ? (this.binding.clip || null) : null;
    const clips = typeof this.getAnimClips === 'function' ? this.getAnimClips() : null;
    const clipsKnown = clips !== null && clips !== undefined;
    const clipAvailable = !authenticClip || !clipsKnown || Object.hasOwn(clips, authenticClip);
    const expectedClip = clipAvailable ? authenticClip : null;
    const clipMatches = !expectedClip || Boolean(clip && clip.name === expectedClip);
    const animPlaying = typeof this.getAnimPlaying === 'function' ? this.getAnimPlaying() : true;

    this.waitingForClip = Boolean(this.syncAnimation && expectedClip && !clipMatches);
    if (this.waitingForClip) {
      this._hideRunners();
      return;
    }

    // Authentic effects sync to their own clip and trigger; legacy effects
    // (no powerstyle binding) sync to whatever action is currently playing.
    const syncedToClip = Boolean(expectedClip && clipMatches);
    const legacySync = this.syncAnimation && !hasBinding;
    const isAnimActive = Boolean(action && clip && animPlaying && (syncedToClip || legacySync));
    const triggerTime = expectedClip ? this.triggerTime : 0;

    if (isAnimActive) {
      const actTime = action.time >= 0 ? action.time : 0.0;
      const local = actTime - triggerTime;
      if (local < 0) {
        // The animation has not reached the authentic trigger yet.
        this.waitingForTrigger = true;
        this.elapsed = 0.0;
        this.lastSyncLocal = local;
        this.lastSyncTime = actTime;
        this._hideRunners();
        return;
      }
      if (this.waitingForTrigger) {
        this.waitingForTrigger = false;
        for (const runner of this.runners) runner.reset();
      }
      // An action restart can be detected either from the trigger-relative
      // clock or from the absolute mixer clock; keep both because a caller may
      // seek the action between frames.
      const loopedBack = (this.lastSyncLocal !== null && local < this.lastSyncLocal)
        || (this.lastSyncTime !== null && actTime < this.lastSyncTime);
      if (this.isLooping) {
        const nextElapsed = local % this.playDuration;
        if (loopedBack || nextElapsed < this.elapsed) {
          for (const runner of this.runners) {
            runner.resetCycle();
          }
        }
        this.lastSyncLocal = local;
        this.lastSyncTime = actTime;
        this.elapsed = nextElapsed;
      } else {
        if (local >= this.playDuration || loopedBack) {
          this._finishOneShot();
          return;
        }
        this.lastSyncLocal = local;
        this.lastSyncTime = actTime;
        this.elapsed = local;
      }
    } else {
      this.lastSyncTime = null;
      this.lastSyncLocal = null;
      this.elapsed += delta * this.speed;
      if (this.elapsed >= this.playDuration) {
        if (this.isLooping) {
          this.elapsed = this.elapsed % this.playDuration;
          for (const runner of this.runners) {
            runner.resetCycle();
          }
        } else {
          this._finishOneShot();
          return;
        }
      }
    }

    // Apply camera shake if active
    if (this.camera && this.shakeOffset) {
      if (this.shakeApplied) {
        this.camera.position.sub(this.shakeOffset);
        this.shakeApplied = false;
      }
      if (this.shakeDuration > 0) {
        this.shakeDuration = Math.max(0, this.shakeDuration - delta);
        if (this.shakeDuration > 0) {
          const decay = this.shakeDuration / this.shakeTotalDuration;
          const time = (this.shakeTotalDuration - this.shakeDuration) * this.shakeSpeed;
          const amp = this.shakeScale * decay * 0.04;
          this.shakeOffset.set(
            Math.sin(time * 1.3) * amp,
            Math.cos(time * 1.7) * amp,
            Math.sin(time * 2.1) * (amp * 0.5)
          );
          this.camera.position.add(this.shakeOffset);
          this.shakeApplied = true;
        } else {
          this.shakeOffset.set(0, 0, 0);
        }
      }
    }

    // Update all runners
    for (const runner of this.runners) {
      runner.update(this.elapsed, delta * this.speed);
    }
  }

  play() {
    if (this.runners.length > 0) {
      this.isPlaying = true;
      if (this.elapsed >= this.playDuration) {
        this.elapsed = 0.0;
        for (const runner of this.runners) runner.reset();
      }
    }
  }

  pause() {
    this.isPlaying = false;
    this.restoreCamera();
    this.shakeDuration = 0;
    if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
    for (const audio of this.activeAudio) {
      try { audio.pause(); } catch {}
    }
    this.activeAudio = [];
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
    return this.isPlaying;
  }

  replay() {
    this.restoreCamera();
    this.shakeDuration = 0;
    if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
    for (const audio of this.activeAudio) {
      try { audio.pause(); } catch {}
    }
    this.activeAudio = [];
    this.elapsed = 0.0;
    this.lastSyncTime = null;
    this.lastSyncLocal = null;
    this.waitingForTrigger = false;
    this.isPlaying = true;
    for (const runner of this.runners) {
      runner.reset();
    }
  }

  stop() {
    this.isPlaying = false;
    this.elapsed = 0.0;
    this.nativeEffect = null;
    this.lastSyncTime = null;
    this.lastSyncLocal = null;
    this.waitingForTrigger = false;
    this.restoreCamera();
    if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
    this.shakeDuration = 0;
    for (const audio of this.activeAudio) {
      try { audio.pause(); } catch {}
    }
    this.activeAudio = [];
    for (const runner of this.runners) {
      runner.dispose();
    }
    this.runners = [];
    if (this.root) {
      while (this.root.children.length > 0) {
        this.root.remove(this.root.children[0]);
      }
    }
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(3.0, Number(speed) || 1.0));
  }

  setLoop(loop) {
    this.isLooping = Boolean(loop);
    // A one-shot has already hidden its meshes by the time the user turns the
    // loop on, so restart it instead of leaving the toggle showing a dark
    // scene until the user also presses replay.
    if (this.isLooping && !this.isPlaying && this.elapsed >= this.playDuration) {
      this.replay();
    }
  }
}

// ========================================================
// CATALOG CONTROLLER (Sidebar & Modal UI)
// ========================================================

export class VfxCatalogController {
  constructor({
    models = [],
    loadModel = () => {},
    openModal = () => {},
    closeModal = () => {},
    refreshIcons = () => {},
    scene = null,
    camera = null,
    renderer = null,
    controls = null,
    gltfLoader = null,
    getMixer = () => null,
    getCurrentAction = () => null,
    getAnimPlaying = () => false,
    setAnimPlaying = () => {},
    getAnimClips = () => ({}),
    applyAnimation = () => {},
    getModel = () => null,
    THREE = null,
  } = {}) {
    Object.assign(this, { models, loadModel, openModal, closeModal, refreshIcons });
    this.effects = [];
    this.selectedEffect = null;
    this.viewMode = 'cards';
    this.hasLoaded = false;
    this.loading = null;
    this.surfaces = {};
    this.loadedModel = null;
    this.loadingModel = false;
    this.getAnimClips = getAnimClips;
    this.setAnimPlaying = setAnimPlaying;
    this.applyAnimation = applyAnimation;
    this.getCurrentAction = getCurrentAction;
    this.getAnimPlaying = getAnimPlaying;

    // Authentic effect -> action/clip/trigger/bone map (powerstyles/*.muc)
    this.actionMap = null;
    this.actionMapLoading = null;
    this.modelToCharacter = new Map();
    this.binding = null;
    this.pendingBinding = null;
    this.animClips = {};
    this.animationsReady = false;
    this.lastLoadedModelKey = null;
    this.activeClip = null;
    this.selectionToken = 0;

    this.runtime = new VfxRuntime({
      scene,
      camera,
      renderer,
      controls,
      gltfLoader,
      getMixer,
      getCurrentAction,
      getAnimPlaying,
      // `null` means "animations still loading"; the runtime then waits for
      // the authentic clip instead of prematurely free-running the effect.
      getAnimClips: () => (this.animationsReady ? (this.getAnimClips?.() || this.animClips || {}) : null),
      applyAnimation,
      getModel,
      THREE,
    });
  }

  init() {
    const get = (id) => document.getElementById(id);
    this.modal = get('vfx-modal');
    this.surfaces = {
      sidebar: { search: get('vfx-search'), clear: get('btn-clear-vfx-search'), category: get('vfx-category-select'), character: get('vfx-character-select'), list: get('vfx-sidebar-list'), pages: get('vfx-sidebar-pages'), count: get('vfx-results'), detail: get('vfx-sidebar-detail'), page: 0 },
      modal: { search: get('vfx-modal-search'), clear: get('btn-clear-vfx-modal-search'), category: get('vfx-modal-category-select'), character: get('vfx-modal-character-select'), list: get('vfx-grid'), pages: get('vfx-modal-pages'), count: get('vfx-modal-stats'), detail: get('vfx-detail'), page: 0 },
    };
    for (const [name, surface] of Object.entries(this.surfaces)) {
      surface.model = get(name === 'sidebar' ? 'vfx-model-select' : 'vfx-modal-model-select');
      surface.navigation = get(`vfx-${name}-navigation`);
      surface.history = [];
      surface.showDetail = false;
      surface.scroller = name === 'sidebar' ? surface.list.parentElement : surface.list;
      surface.state = this.captureState(name);
      for (const control of [surface.search, surface.category, surface.character, surface.model]) {
        control.addEventListener(control === surface.search ? 'input' : 'change', () => {
          // One history entry per search edit, not per keystroke.
          if (control !== surface.search || !surface.editingSearch) surface.history.push(surface.state);
          surface.editingSearch = control === surface.search;
          surface.page = 0;
          surface.showDetail = false;
          this.render(name);
          this.renderDetails();
        });
      }
      surface.search.addEventListener('blur', () => { surface.editingSearch = false; });
      surface.clear.addEventListener('click', () => {
        this.remember(name);
        surface.search.value = '';
        surface.page = 0;
        surface.showDetail = false;
        this.render(name);
        this.renderDetails();
        surface.search.focus();
      });
    }
    for (const mode of ['cards', 'list']) {
      get(`vfx-view-${mode}`).addEventListener('click', () => {
        this.viewMode = mode;
        for (const candidate of ['cards', 'list']) {
          const button = get(`vfx-view-${candidate}`);
          button.classList.toggle('active', candidate === mode);
          button.setAttribute('aria-pressed', String(candidate === mode));
        }
        this.render('sidebar');
      });
    }
    get('vfx-reload-btn').addEventListener('click', () => this.loadCatalog());
    get('vfx-open-gallery').addEventListener('click', () => this.openGalleryModal());
    get('vfx-close').addEventListener('click', () => this.closeModal(this.modal));
    this.loadActionMap();
    this.loadCatalog();
  }

  loadActionMap() {
    if (this.actionMap) return Promise.resolve(this.actionMap);
    if (this.actionMapLoading) return this.actionMapLoading;
    this.actionMapLoading = fetch(`assets/vfx/action_map.json?v=${Date.now()}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || data.format !== 'mua2_vfx_action_map_v1') return null;
        this.actionMap = data;
        this.buildCharacterIndex();
        return data;
      })
      .catch((error) => {
        console.warn('[VFX] Mapa autêntico de ações indisponível:', error);
        return null;
      })
      .finally(() => { this.actionMapLoading = null; });
    return this.actionMapLoading;
  }

  buildCharacterIndex() {
    this.modelToCharacter = new Map();
    if (!this.actionMap) return;
    const characters = Object.entries(this.actionMap.characters || {});
    // Representatives win over secondary modelIds so a model that belongs to
    // two characters still resolves to the one it represents.
    for (const [character, info] of characters) {
      if (info?.representativeModel) this.modelToCharacter.set(info.representativeModel, character);
    }
    for (const [character, info] of characters) {
      for (const id of (info?.modelIds || [])) {
        if (id && !this.modelToCharacter.has(id)) this.modelToCharacter.set(id, character);
      }
    }
  }

  characterForModel(model) {
    if (!model) return null;
    const id = model.id || model.userData?.id;
    return (id && this.modelToCharacter.get(id)) || model.userData?.character || null;
  }

  planFor(effect) {
    return planEffectBinding(effect, {
      actionMap: this.actionMap,
      loadedModel: this.loadedModel,
      models: this.models,
      isProp: (model) => this.isProp(model),
      modelCharacter: (model) => this.characterForModel(model),
    });
  }

  decoratePlan(plan) {
    if (!plan) return plan;
    if (!plan.clip) {
      plan.clipAvailable = true;
      return plan;
    }
    const clips = this.getAnimClips?.() || this.animClips || {};
    plan.clipAvailable = this.animationsReady ? Boolean(clips[plan.clip]) : null;
    return plan;
  }

  captureState(name) {
    const surface = this.surfaces[name];
    return {
      search: surface.search.value, category: surface.category.value, character: surface.character.value,
      model: surface.model.value, page: surface.page, showDetail: surface.showDetail,
      selectedId: this.selectedEffect?.id, scroll: surface.scroller.scrollTop,
    };
  }

  remember(name) {
    const surface = this.surfaces[name];
    surface.history.push(this.captureState(name));
    surface.editingSearch = false;
  }

  goBack(name) {
    const surface = this.surfaces[name];
    const state = surface.history.pop();
    if (!state) return;
    for (const field of ['search', 'category', 'character', 'model']) surface[field].value = state[field];
    surface.page = state.page;
    surface.showDetail = state.showDetail;
    surface.editingSearch = false;
    // Returning to the catalog keeps the current effect and its loaded model.
    const effect = this.effects.find((candidate) => candidate.id === state.selectedId);
    if (state.showDetail && effect && effect.id !== this.selectedEffect?.id) {
      this.selectEffect(effect);
    }
    this.render('sidebar');
    this.render('modal');
    this.renderDetails();
    surface.scroller.scrollTop = state.scroll;
    this.focusSurface(name);
  }

  focusSurface(name) {
    const surface = this.surfaces[name];
    const target = surface.showDetail ? surface.detail.querySelector('.vfx-selection-title')
      : [...surface.list.querySelectorAll('button[data-id]')].find((button) => button.dataset.id === this.selectedEffect?.id) || surface.search;
    target?.focus();
  }

  isProp(model) {
    return model?.category === 'props' || /(?:baton|bola|staff|chain|waldos|webmace|tongue|gambit_cards)/i.test(model?.source || '');
  }

  linkedModels(effect) {
    return this.models.filter((model) => effect.modelIds.includes(model.id));
  }

  matchesModel(effect, filter) {
    if (filter === 'all') return true;
    if (filter === 'loaded') return Boolean(this.loadedModel && effect.modelIds.includes(this.loadedModel.id));
    if (filter === 'with-model') return this.linkedModels(effect).length > 0;
    if (filter === 'with-prop') return this.linkedModels(effect).some((model) => this.isProp(model));
    return effect.modelIds.includes(filter);
  }

  populateModelFilters() {
    const linkedIds = new Set(this.effects.flatMap((effect) => effect.modelIds));
    const createOption = (label, val) => (typeof Option !== 'undefined' ? new Option(label, val) : { text: label, value: val, textContent: label });
    for (const surface of Object.values(this.surfaces)) {
      if (!surface?.model) continue;
      const previous = surface.model.value;
      const options = [
        createOption('Todos os vínculos', 'all'),
        createOption('Com modelo 3D', 'with-model'),
        createOption('Com props / armas', 'with-prop'),
        createOption(this.loadedModel ? `Carregado: ${this.loadedModel.name} (${this.loadedModel.id})` : 'Modelo carregado (nenhum)', 'loaded'),
      ];
      options[3].disabled = !this.loadedModel;
      for (const model of this.models.filter((entry) => linkedIds.has(entry.id)).sort((a, b) => a.name.localeCompare(b.name))) {
        options.push(createOption(`${this.isProp(model) ? 'Prop' : 'Modelo'}: ${model.name} · ${model.id}`, model.id));
      }
      surface.model.replaceChildren?.(...options);
      surface.model.value = options.some((option) => option.value === previous) ? previous : 'all';
    }
  }

  renderNavigation(name) {
    const surface = this.surfaces[name];
    if (!surface?.navigation) return;
    surface.navigation.replaceChildren();

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'vfx-nav-back-btn';
    back.innerHTML = '<i data-lucide="arrow-left"></i><span>Voltar</span>';
    back.disabled = !surface.history.length;
    back.setAttribute('aria-label', 'Voltar à visualização anterior do catálogo VFX');
    back.addEventListener('click', () => this.goBack(name));
    surface.navigation.append(back);

    const crumbs = document.createElement('ol');
    crumbs.className = 'vfx-breadcrumbs';
    const addCrumb = (label, action) => {
      const item = document.createElement('li');
      item.className = 'vfx-breadcrumb-item';
      const control = document.createElement(action ? 'button' : 'span');
      control.textContent = label;
      if (action) {
        control.type = 'button';
        control.className = 'vfx-breadcrumb-btn';
        control.addEventListener('click', action);
      } else {
        control.className = 'vfx-breadcrumb-current';
        control.setAttribute('aria-current', 'page');
      }
      item.append(control);
      crumbs.append(item);
    };

    const navigate = (field) => {
      this.remember(name);
      if (!field) {
        surface.search.value = '';
        for (const key of ['category', 'character', 'model']) surface[key].value = 'all';
        surface.page = 0;
      } else {
        const fields = ['category', 'character', 'model'];
        for (const key of fields.slice(fields.indexOf(field) + 1)) surface[key].value = 'all';
        surface.search.value = '';
        surface.page = 0;
      }
      surface.showDetail = false;
      this.render(name);
      this.renderDetails();
      this.focusSurface(name);
    };

    addCrumb('Catálogo VFX', () => navigate(null));
    for (const field of ['category', 'character', 'model']) {
      if (surface[field].value !== 'all') {
        const label = surface[field].selectedOptions?.[0]?.textContent || surface[field].value;
        addCrumb(label, () => navigate(field));
      }
    }
    if (surface.showDetail && this.selectedEffect) {
      addCrumb(this.selectedEffect.name.replace(/_/g, ' '));
    } else {
      addCrumb('Resultados');
    }
    surface.navigation.append(crumbs);
  }

  loadCatalog() {
    if (this.loading) return this.loading;
    for (const surface of Object.values(this.surfaces)) {
      surface.list.textContent = 'Carregando catálogo de VFX…';
      surface.count.textContent = 'Carregando…';
      surface.pages.replaceChildren();
      surface.pages.hidden = true;
      surface.list.setAttribute('aria-busy', 'true');
    }
    this.loading = this._loadCatalog().finally(() => {
      this.loading = null;
      for (const surface of Object.values(this.surfaces)) surface.list.removeAttribute('aria-busy');
    });
    return this.loading;
  }

  async _loadCatalog() {
    for (const source of ['effects.json', 'effects_curated.json']) {
      try {
        const response = await fetch(`assets/vfx/${source}?v=${Date.now()}`);
        if (!response.ok) continue;
        const data = await response.json();
        if (!data || !Array.isArray(data.effects)) continue;
        const effects = data.effects.map(normalizeEffect).filter(Boolean);
        if (data.effects.length && !effects.length) continue;
        this.effects = effects;
        this.loadedSource = source;
        this.hasLoaded = true;
        this.selectedEffect = effects.find((effect) => effect.id === this.selectedEffect?.id) || null;
        for (const surface of Object.values(this.surfaces)) {
          for (const field of ['category', 'character']) {
            const select = surface[field];
            const previous = select.value;
            select.replaceChildren(new Option(field === 'category' ? 'Todas as categorias' : 'Todos os personagens', 'all'));
            const counts = new Map();
            for (const effect of effects) {
              if (effect[field]) counts.set(effect[field], (counts.get(effect[field]) || 0) + 1);
            }
            for (const [value, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
              select.add(new Option(`${value} (${count})`, value));
            }
            select.value = counts.has(previous) ? previous : 'all';
          }
        }
        this.populateModelFilters();
        for (const id of ['vfx-catalog-count', 'nav-vfx-count']) {
          document.getElementById(id).textContent = effects.length.toLocaleString('pt-BR');
        }
        this.render('sidebar');
        this.render('modal');
        this.renderDetails();
        if (this.selectedEffect) {
          const token = ++this.selectionToken;
          this.resolveSelection(this.selectedEffect, { token, autoLoad: false });
        }
        return;
      } catch (error) {
        console.warn(`[VFX] Catálogo ${source} indisponível:`, error);
      }
    }
    this.hasLoaded = false;
    for (const surface of Object.values(this.surfaces)) {
      surface.list.textContent = 'Não foi possível carregar o catálogo. Use Recarregar para tentar novamente.';
      surface.count.textContent = 'Erro ao carregar';
    }
  }

  render(name) {
    const surface = this.surfaces[name];
    const query = surface.search.value.trim().toLowerCase();
    const filtered = this.effects.filter((effect) =>
      matches(effect, query, surface.category.value, surface.character.value)
      && this.matchesModel(effect, surface.model.value),
    );
    const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
    surface.page = Math.min(surface.page, lastPage);
    const start = surface.page * PAGE_SIZE;
    const batch = filtered.slice(start, start + PAGE_SIZE);
    surface.clear.style.display = surface.search.value ? 'block' : 'none';
    surface.list.className = name === 'modal' ? 'vfx-grid' : `vfx-sidebar-list view-${this.viewMode}`;
    surface.count.textContent = `${batch.length ? start + 1 : 0}–${start + batch.length} de ${filtered.length.toLocaleString('pt-BR')} efeitos`;
    surface.list.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const effect of batch) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = name === 'modal' ? 'vfx-card' : 'vfx-item-btn';
      button.dataset.id = effect.id;
      button.classList.toggle('active', this.selectedEffect?.id === effect.id);
      button.setAttribute('aria-pressed', String(this.selectedEffect?.id === effect.id));
      const title = escapeHtml(effect.name.replace(/_/g, ' '));
      const preview = effect.thumb
        ? `<img src="${escapeHtml(effect.thumb)}" alt="Textura estática de ${title}" class="vfx-card-thumb" loading="lazy"><span class="vfx-tex-badge">Textura</span>`
        : '<span class="vfx-thumb-placeholder" aria-hidden="true">—</span>';

      const linked = this.linkedModels(effect);
      const isLoaded = Boolean(this.loadedModel && effect.modelIds.includes(this.loadedModel.id));
      let modelTag = '';
      if (isLoaded) {
        modelTag = '<span class="vfx-meta-tag vfx-loaded-tag" title="Vinculado ao modelo ativo"><i data-lucide="check"></i> Ativo</span>';
      } else if (linked.some((m) => this.isProp(m))) {
        modelTag = '<span class="vfx-meta-tag vfx-prop-tag" title="Vinculado a prop/arma"><i data-lucide="crosshair"></i> Prop</span>';
      } else if (linked.length > 0) {
        modelTag = '<span class="vfx-meta-tag vfx-model-tag" title="Vinculado a modelo 3D"><i data-lucide="box"></i> 3D</span>';
      }

      button.innerHTML = name === 'sidebar' && this.viewMode === 'list'
        ? `<span class="vfx-list-name">${title}</span>${modelTag}${badge(effect)}`
        : `<div class="vfx-card-thumb-wrap">${preview}</div><div class="vfx-card-info vfx-card-body"><span class="vfx-card-name">${title}</span><span class="vfx-card-sub">${escapeHtml(effect.path)}</span><span class="vfx-card-meta">${badge(effect)}${modelTag}<span class="vfx-meta-tag">${effect.textures.length} texturas</span></span></div>`;
      button.addEventListener('click', () => this.selectEffect(effect, name));
      fragment.append(button);
    }
    surface.list.append(fragment);
    if (!batch.length) {
      surface.list.innerHTML = '<div class="vfx-empty-filter" style="text-align:center; padding:24px 8px; color:var(--muted);">Nenhum efeito corresponde aos filtros selecionados.</div>';
    }
    surface.pages.replaceChildren();
    surface.pages.hidden = lastPage === 0;
    for (const [label, delta] of [['Anterior', -1], ['Próximos 100', 1]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vfx-load-more-btn';
      button.textContent = label;
      button.disabled = delta < 0 ? surface.page === 0 : surface.page === lastPage;
      button.addEventListener('click', () => {
        this.remember(name);
        surface.page += delta;
        this.render(name);
        const scroller = name === 'sidebar' ? surface.list.parentElement : surface.list;
        scroller.scrollTop = 0;
        surface.list.querySelector('button')?.focus();
      });
      surface.pages.append(button);
    }
    this.renderNavigation(name);
    surface.state = this.captureState(name);
    this.refreshIcons();
  }

  selectEffect(effect, name = null) {
    if (name) this.remember(name);
    this.selectedEffect = effect;
    if (name) this.surfaces[name].showDetail = true;
    this.applySelectionHighlight(effect);
    const token = ++this.selectionToken;
    this.resolveSelection(effect, { token, autoLoad: true }).then(() => {
      if (name) {
        this.renderNavigation(name);
        this.focusSurface(name);
      }
    });
  }

  applySelectionHighlight(effect) {
    for (const surface of Object.values(this.surfaces)) {
      for (const button of surface.list.querySelectorAll('button[data-id]')) {
        const active = button.dataset.id === effect?.id;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
  }

  async resolveSelection(effect, { token = this.selectionToken, autoLoad = false } = {}) {
    if (!effect) {
      this.binding = null;
      this.pendingBinding = null;
      this.runtime.setEffect(null);
      this.renderDetails();
      return;
    }

    await this.loadActionMap();
    if (token !== this.selectionToken) return;

    let plan = this.decoratePlan(this.planFor(effect));
    if (autoLoad && plan.requiresModelLoad && plan.targetModel) {
      this.loadingModel = true;
      try {
        await this.loadModel(plan.targetModel);
      } catch (error) {
        console.error('[VFX] Falha ao carregar o personagem vinculado ao efeito:', error);
      } finally {
        this.loadingModel = false;
      }
      if (token !== this.selectionToken) return;
      if (!this.loadedModel) this.loadedModel = plan.targetModel;
      plan = this.decoratePlan(this.planFor(effect));
    }

    this.binding = plan;
    this.pendingBinding = { effect, plan };
    // A plan that still needs its owning model is not rendered on the wrong
    // character, even if the automatic load failed.
    const playable = Boolean(effect.definition?.primitives?.length)
      && !plan.suspended
      && !plan.requiresModelLoad;
    this.runtime.setEffect(playable ? effect : null, { binding: plan });
    if (plan.suspended) this.runtime.suspensionReason = this.suspensionText(plan);
    if (playable && plan.compatible && plan.clip) this.applyBindingAnimation(plan);
    this.renderDetails();
  }

  suspensionText(plan) {
    const owner = plan.effectCharacter || plan.actor || 'outro personagem';
    return `Efeito pertence a ${owner} e não há modelo representativo disponível para carregá-lo.`;
  }

  applyBindingAnimation(plan) {
    if (!plan?.compatible || !plan.clip) return false;
    const clips = this.getAnimClips?.() || this.animClips || {};
    if (!clips[plan.clip]) return false;
    if (typeof this.getAnimPlaying === 'function' && !this.getAnimPlaying()) {
      this.setAnimPlaying?.(true);
    }
    const applied = this.applyAnimation(plan.clip);
    if (!applied) return false;
    const action = this.getCurrentAction?.();
    if (action) {
      // Seek just before the authentic trigger so the effect is reviewable
      // immediately while the clip still supplies the correct wind-up.
      const lead = plan.triggerTime > 0 ? Math.min(0.25, plan.triggerTime) : 0;
      const target = Math.max(0, plan.triggerTime - lead);
      try {
        action.time = Math.min(target, Math.max(0, action.getClip().duration - 0.01));
        action.paused = false;
      } catch {
        // Mock/partial actions in self-check have no writable time.
      }
    }
    if (this.runtime) {
      this.runtime.lastSyncLocal = null;
      this.runtime.lastSyncTime = null;
      this.runtime.waitingForTrigger = plan.triggerTime > 0;
    }
    this.activeClip = plan.clip;
    return true;
  }

  onAnimationsChange(clips) {
    this.animClips = clips || {};
    this.animationsReady = true;
    const pending = this.pendingBinding;
    if (!pending || pending.effect?.id !== this.selectedEffect?.id) {
      this.renderDetails();
      return;
    }
    const plan = this.decoratePlan(pending.plan);
    if (!plan.suspended && !plan.requiresModelLoad && plan.compatible && plan.clip && plan.clipAvailable) {
      this.applyBindingAnimation(plan);
    }
    this.renderDetails();
  }

  renderBindingMarkup(effect) {
    const plan = this.binding;
    if (!plan || plan.effectId !== effect.id) return '';
    if (!effect.definition?.primitives?.length) return '';
    const rows = [];
    if (plan.clip) {
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Animação</span><strong class="vfx-action-value">${escapeHtml(plan.clip)}</strong>${plan.animEnum ? `<span class="vfx-action-enum">${escapeHtml(plan.animEnum)}</span>` : ''}</div>`);
    }
    if (plan.time !== null) {
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Gatilho</span><strong class="vfx-action-value">${plan.time < 0 ? 'contínuo (persistente)' : `${plan.time.toFixed(3)}s`}</strong></div>`);
    }
    if (plan.actor) {
      const actorLoaded = plan.loadedCharacter && plan.loadedCharacter === plan.actor
        ? '<span class="vfx-linked-status-badge">✓ Ator carregado</span>' : '';
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Ator</span><strong class="vfx-action-value">${escapeHtml(plan.actor)}</strong>${actorLoaded}</div>`);
    }
    if (plan.targetCharacter && plan.targetCharacter !== plan.actor) {
      const ownerLoaded = plan.compatible && plan.loadedCharacter === plan.targetCharacter
        ? '<span class="vfx-linked-status-badge">✓ Carregado</span>' : '';
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Personagem</span><strong class="vfx-action-value">${escapeHtml(plan.targetCharacter)}</strong>${ownerLoaded}</div>`);
    }
    if (plan.anchorMode === 'bone') {
      const bone = this.runtime?.attachmentBoneName || plan.bone || '';
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Osso</span><strong class="vfx-action-value">${escapeHtml(bone)}</strong>${plan.bolt ? `<span class="vfx-action-enum">${escapeHtml(plan.bolt)}</span>` : ''}</div>`);
    } else if (plan.anchorMode === 'origin') {
      const originLabel = plan.recipient === 'projectile'
        ? 'Projétil (origem)'
        : plan.recipient === 'target'
          ? 'Alvo (origem)'
          : plan.recipient === 'world'
            ? 'Cenário (origem)'
            : 'Origem do cenário';
      rows.push(`<div class="vfx-action-row"><span class="vfx-action-label">Ancoragem</span><strong class="vfx-action-value">${originLabel}</strong></div>`);
    } else if (plan.anchorMode === 'model') {
      rows.push('<div class="vfx-action-row"><span class="vfx-action-label">Ancoragem</span><strong class="vfx-action-value">Raiz do modelo</strong></div>');
    }

    const notes = [];
    if (this.runtime?.boneMissing) {
      notes.push(`O osso ${this.runtime.boneMissing} não existe neste rig; usando ${this.runtime.attachmentBoneName}.`);
    }
    if (plan.suspended) notes.push(this.suspensionText(plan));
    else if (plan.requiresModelLoad && plan.targetCharacter) {
      notes.push(`Efeito vinculado a ${plan.targetCharacter}; carregue o modelo correspondente para reproduzi-lo.`);
    } else if (plan.hasAction && plan.actor && plan.targetCharacter && plan.actor !== plan.targetCharacter) {
      notes.push(`Executado por ${plan.actor}, um dos atores autênticos deste efeito.`);
    } else if (!plan.hasAction && plan.anchorMode === 'origin') {
      notes.push('Efeito sem vínculo autêntico com o modelo carregado; exibido na origem.');
    } else if (!plan.compatible && plan.hasAction && plan.anchorMode === 'origin' && !plan.scenery && plan.recipient === 'caster') {
      notes.push('O modelo carregado não executa esta ação; efeito exibido na origem.');
    }
    if (!plan.suspended && plan.hasAction) {
      if (!plan.clip) notes.push('A ação autêntica não possui clipe de animação disponível.');
      else if (plan.clipAvailable === false) {
        notes.push(`O clipe ${plan.clip} não existe neste modelo; o efeito é reproduzido em linha do tempo própria.`);
      }
    }
    if (!rows.length && !notes.length) return '';

    return `
      <div class="vfx-char-action-box vfx-action-box">
        <h4 class="vfx-char-action-title"><i data-lucide="clapperboard"></i><span>Ação Autêntica</span></h4>
        ${rows.join('')}
        ${notes.map((note) => `<p class="vfx-char-note">${escapeHtml(note)}</p>`).join('')}
      </div>
    `;
  }

  closeDetail(name) {
    this.remember(name);
    const surface = this.surfaces[name];
    surface.showDetail = false;
    this.render(name);
    this.renderDetails();
    this.focusSurface(name);
  }

  renderDetails() {
    const effect = this.selectedEffect;
    for (const [name, surface] of Object.entries(this.surfaces)) {
      surface.detail.hidden = name === 'sidebar' && (!effect || !surface.showDetail);
      if (!effect) {
        surface.detail.innerHTML = '<div class="vfx-empty">Selecione um efeito para ver os detalhes.</div>';
        continue;
      }
      const title = escapeHtml(effect.name.replace(/_/g, ' '));
      const prims = effect.definition?.primitives || [];
      const hasPrimitives = prims.length > 0;
      const tmpl = effect.definition?.templates?.[0];
      const dur = this.runtime.playDuration || tmpl?.loopTime || 1.0;

      let statusMarkup = '';
      if (hasPrimitives) {
        statusMarkup = `
          <div class="vfx-player-box">
            <div class="vfx-decoded-banner">
              <i data-lucide="sparkles"></i>
              <span><strong>Emissor WebGL Ativo</strong> · ${prims.length} primitivas · ${dur.toFixed(1)}s</span>
            </div>
            <div class="vfx-player-toolbar">
              <button type="button" class="vfx-player-btn vfx-btn-play ${this.runtime.isPlaying ? 'active' : ''}" title="Pausar / Reproduzir" aria-label="${this.runtime.isPlaying ? 'Pausar reprodução' : 'Iniciar reprodução'}">
                <i data-lucide="${this.runtime.isPlaying ? 'pause' : 'play'}"></i>
                <span>${this.runtime.isPlaying ? 'Pausar' : 'Reproduzir'}</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-replay" title="Reiniciar do início" aria-label="Reiniciar reprodução">
                <i data-lucide="rotate-ccw"></i>
                <span>Reiniciar</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-loop ${this.runtime.isLooping ? 'active' : ''}" title="Alternar repetição contínua" aria-pressed="${String(this.runtime.isLooping)}">
                <i data-lucide="repeat"></i>
                <span>Loop</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-sync ${this.runtime.syncAnimation ? 'active' : ''}" title="Sincronizar com animação do modelo" aria-pressed="${String(this.runtime.syncAnimation)}">
                <i data-lucide="clapperboard"></i>
                <span>Sync Anim</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-audio ${this.runtime.audioEnabled ? 'active' : ''}" title="Alternar áudio FMOD" aria-pressed="${String(this.runtime.audioEnabled)}">
                <i data-lucide="${this.runtime.audioEnabled ? 'volume-2' : 'volume-x'}"></i>
                <span>Áudio</span>
              </button>
              <select class="vfx-player-speed" title="Velocidade de reprodução" aria-label="Velocidade de reprodução">
                <option value="1" ${this.runtime.speed === 1.0 ? 'selected' : ''}>1.0x</option>
                <option value="0.5" ${this.runtime.speed === 0.5 ? 'selected' : ''}>0.5x</option>
                <option value="0.25" ${this.runtime.speed === 0.25 ? 'selected' : ''}>0.25x</option>
              </select>
            </div>
            <div class="vfx-attachment-info">
              <i data-lucide="crosshair"></i>
              <span>Ancoragem: <strong>${escapeHtml(this.runtime.attachmentSlot)}</strong> ${this.runtime.attachmentBoneName ? `(${escapeHtml(this.runtime.attachmentBoneName)})` : ''}</span>
            </div>
          </div>
        `;
      } else {
        statusMarkup = `<p class="vfx-unavail-banner"><i data-lucide="alert-circle"></i> ${PLAYBACK_NOTICE}</p>`;
      }

      surface.detail.innerHTML = `
        <div class="vfx-detail-header-row">
          <button type="button" class="vfx-back-btn" title="Voltar para a lista de efeitos" aria-label="Voltar para a lista">
            <i data-lucide="arrow-left"></i><span>Voltar para lista</span>
          </button>
        </div>
        <h3 class="vfx-selection-title" tabindex="-1">${title}</h3>
        <div class="effect-path">${escapeHtml(effect.path)}</div>
        <div class="vfx-selection-meta-row">
          ${badge(effect)}
          <span class="vfx-meta-tag">${escapeHtml(effect.category)}</span>
          ${hasPrimitives ? `<span class="vfx-meta-tag">${prims.length} prims</span>` : ''}
        </div>
        ${statusMarkup}
        ${this.renderBindingMarkup(effect)}
      `;

      // Back button listener in detail view
      const backBtn = surface.detail.querySelector('.vfx-back-btn');
      backBtn?.addEventListener('click', () => {
        if (surface.history.length) this.goBack(name);
        else this.closeDetail(name);
      });

      // Wire playback controls
      if (hasPrimitives) {
        const playBtn = surface.detail.querySelector('.vfx-btn-play');
        const replayBtn = surface.detail.querySelector('.vfx-btn-replay');
        const loopBtn = surface.detail.querySelector('.vfx-btn-loop');
        const syncBtn = surface.detail.querySelector('.vfx-btn-sync');
        const audioBtn = surface.detail.querySelector('.vfx-btn-audio');
        const speedSel = surface.detail.querySelector('.vfx-player-speed');

        playBtn?.addEventListener('click', () => {
          const isPlaying = this.runtime.togglePlay();
          playBtn.classList.toggle('active', isPlaying);
          playBtn.innerHTML = `<i data-lucide="${isPlaying ? 'pause' : 'play'}"></i><span>${isPlaying ? 'Pausar' : 'Reproduzir'}</span>`;
          this.refreshIcons();
        });

        replayBtn?.addEventListener('click', () => {
          this.runtime.replay();
          playBtn?.classList.add('active');
          if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i><span>Pausar</span>';
          this.refreshIcons();
        });

        loopBtn?.addEventListener('click', () => {
          this.runtime.setLoop(!this.runtime.isLooping);
          loopBtn.classList.toggle('active', this.runtime.isLooping);
          loopBtn.setAttribute('aria-pressed', String(this.runtime.isLooping));
          if (this.runtime.isPlaying) {
            playBtn?.classList.add('active');
            if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i><span>Pausar</span>';
            this.refreshIcons();
          }
        });

        syncBtn?.addEventListener('click', () => {
          this.runtime.syncAnimation = !this.runtime.syncAnimation;
          syncBtn.classList.toggle('active', this.runtime.syncAnimation);
          syncBtn.setAttribute('aria-pressed', String(this.runtime.syncAnimation));
        });

        audioBtn?.addEventListener('click', () => {
          this.runtime.audioEnabled = !this.runtime.audioEnabled;
          audioBtn.classList.toggle('active', this.runtime.audioEnabled);
          audioBtn.setAttribute('aria-pressed', String(this.runtime.audioEnabled));
          audioBtn.innerHTML = `<i data-lucide="${this.runtime.audioEnabled ? 'volume-2' : 'volume-x'}"></i><span>Áudio</span>`;
          this.refreshIcons();
        });

        speedSel?.addEventListener('change', (e) => {
          this.runtime.setSpeed(e.target.value);
        });
      }

      // Models and Props Association section
      const linked = this.linkedModels(effect);
      const assocBox = document.createElement('div');
      assocBox.className = 'vfx-char-action-box';

      const assocTitle = document.createElement('h4');
      assocTitle.className = 'vfx-char-action-title';
      assocTitle.innerHTML = `<i data-lucide="layers"></i><span>Vínculos de Modelo & Props (${linked.length})</span>`;
      assocBox.append(assocTitle);

      if (effect.character) {
        const charNote = document.createElement('p');
        charNote.className = 'vfx-char-note';
        charNote.textContent = `Personagem: ${effect.character}`;
        assocBox.append(charNote);
      }

      if (linked.length > 0) {
        const modelList = document.createElement('div');
        modelList.className = 'vfx-linked-models-list';

        for (const model of linked) {
          const isProp = this.isProp(model);
          const isCurrent = this.loadedModel?.id === model.id;
          const row = document.createElement('div');
          row.className = `vfx-linked-model-row ${isCurrent ? 'is-loaded' : ''}`;

          const info = document.createElement('div');
          info.className = 'vfx-linked-model-info';
          info.innerHTML = `
            <span class="vfx-linked-model-name">${escapeHtml(model.name)}</span>
            <span class="vfx-linked-model-sub">${isProp ? 'Prop / Arma' : 'Personagem'} · ${escapeHtml(model.id)}</span>
            ${isCurrent ? '<span class="vfx-linked-status-badge">✓ Carregado no visualizador</span>' : ''}
          `;
          row.append(info);

          const actions = document.createElement('div');
          actions.className = 'vfx-linked-model-actions';

          const loadBtn = document.createElement('button');
          loadBtn.type = 'button';
          loadBtn.className = `vfx-char-btn ${isCurrent ? 'loaded' : ''}`;
          loadBtn.innerHTML = isCurrent
            ? '<i data-lucide="check"></i><span>Modelo ativo</span>'
            : `<i data-lucide="download"></i><span>Carregar ${escapeHtml(model.name)}</span>`;
          loadBtn.disabled = isCurrent || this.loadingModel;
          loadBtn.addEventListener('click', async () => {
            if (this.loadingModel || isCurrent) return;
            this.loadingModel = true;
            loadBtn.disabled = true;
            loadBtn.textContent = `Carregando ${model.name}…`;
            try {
              await this.loadModel(model);
              this.loadedModel = model;
              const token = ++this.selectionToken;
              await this.resolveSelection(effect, { token, autoLoad: false });
              this.populateModelFilters();
              this.render('sidebar');
              this.render('modal');
            } catch (err) {
              console.error('[VFX] Falha ao carregar modelo:', err);
              loadBtn.classList.add('error');
              loadBtn.textContent = 'Falha ao carregar. Tentar novamente';
              loadBtn.disabled = false;
            } finally {
              this.loadingModel = false;
            }
          });
          actions.append(loadBtn);

          const filterBtn = document.createElement('button');
          filterBtn.type = 'button';
          filterBtn.className = 'vfx-filter-link-btn';
          filterBtn.title = 'Filtrar catálogo pelos efeitos deste modelo';
          filterBtn.setAttribute('aria-label', `Filtrar efeitos por ${model.name}`);
          filterBtn.innerHTML = '<i data-lucide="filter"></i><span>Filtrar</span>';
          filterBtn.addEventListener('click', () => {
            this.remember(name);
            surface.model.value = model.id;
            surface.page = 0;
            this.render(name);
            this.renderDetails();
          });
          actions.append(filterBtn);

          row.append(actions);
          modelList.append(row);
        }
        assocBox.append(modelList);
      } else {
        const emptyNote = document.createElement('p');
        emptyNote.className = 'vfx-char-unavail-note';
        emptyNote.innerHTML = '<i data-lucide="info"></i><span>Nenhum modelo 3D correspondente vinculado a este efeito.</span>';
        assocBox.append(emptyNote);
      }
      surface.detail.append(assocBox);

      // Authentic static texture preview
      if (effect.thumb) {
        const preview = document.createElement('figure');
        preview.className = 'vfx-preview';
        preview.innerHTML = `<img src="${escapeHtml(effect.thumb)}" alt="Textura estática de ${title}"><figcaption>Textura autêntica de VFX (${effect.textures.length} no arquivo)</figcaption>`;
        surface.detail.append(preview);
      }

      // Textures list
      if (effect.textures.length > 0) {
        const texHeader = document.createElement('h4');
        texHeader.className = 'vfx-section-header';
        texHeader.textContent = `Texturas do Efeito (${effect.textures.length})`;
        const textures = document.createElement('ul');
        textures.className = 'vfx-tex-list';
        for (const texture of effect.textures) {
          const item = document.createElement('li');
          item.textContent = texture;
          textures.append(item);
        }
        surface.detail.append(texHeader, textures);
      }

      // Raw decompiled definition inspector
      for (const [label, value] of [['Definição Descompilada', effect.definition], ['Não suportado', effect.unsupported]]) {
        if (!value || (Array.isArray(value) && !value.length)) continue;
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = label;
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(value, null, 2);
        details.append(summary, pre);
        surface.detail.append(details);
      }

      // Close button in sidebar
      if (name === 'sidebar') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'vfx-load-more-btn';
        close.textContent = 'Voltar para lista';
        close.addEventListener('click', () => {
          if (surface.history.length) this.goBack(name);
          else this.closeDetail(name);
        });
        surface.detail.append(close);
      }
    }
    this.refreshIcons();
  }

  async openGalleryModal() {
    this.openModal(this.modal, this.surfaces.modal.search);
    if (this.loading) await this.loading;
    else if (!this.hasLoaded) await this.loadCatalog();
    if (!this.hasLoaded) return;
    this.render('modal');
    this.renderDetails();
  }

  activate() {
    if (!this.hasLoaded) this.loadCatalog();
    this.surfaces.sidebar.search.focus();
  }

  update(delta) {
    this.runtime.update(delta);
  }

  restoreCamera() {
    this.runtime.restoreCamera();
  }

  onModelChange(model) {
    const modelKey = model?.uuid || null;
    if (modelKey !== this.lastLoadedModelKey) {
      // A new GLTF is loading: its animation set is not available yet, so the
      // runtime must wait for the authentic clip instead of free-running. A
      // rig without a mixer has no clips at all, which is also a known state.
      this.lastLoadedModelKey = modelKey;
      this.animationsReady = model ? !this.getMixer?.() : false;
      this.animClips = {};
    }
    this.runtime.onModelChange(model);
    const entry = model?.userData?.catalogEntry || model?.userData?.entry
      || this.models.find((m) => m.id === model?.userData?.id || m.id === model?.name);
    this.loadedModel = entry || null;
    this.populateModelFilters();
    for (const surface of Object.values(this.surfaces)) {
      if (surface?.model?.value === 'loaded') {
        surface.page = 0;
        this.render('sidebar');
        this.render('modal');
      }
    }
    // Auto-loads triggered by resolveSelection must not re-enter; the awaiting
    // call recomputes the plan with the freshly loaded model.
    if (this.selectedEffect && !this.loadingModel) {
      const token = ++this.selectionToken;
      this.resolveSelection(this.selectedEffect, { token, autoLoad: false });
    } else {
      this.renderDetails();
    }
  }
}

export function initVfxCatalog(options) {
  const controller = new VfxCatalogController(options);
  controller.init();
  return controller;
}

// Run: node --input-type=module -e "import('./src/vfx.js').then(m => m.selfCheckVfxCatalog())"
export function selfCheckVfxCatalog() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };

  // 1. Normalization & safety
  const fallback = normalizeEffect({ path: 'char/spiderman/web.igz', modelId: 'spiderman', textures: ['web.tga'], definition: {} });
  check(fallback.modelIds.length === 0, 'Must not infer modelIds from character, path or modelId');
  check(fallback.status === 'metadata-only', 'Definition alone must not imply decoded status');
  const explicit = normalizeEffect({ id: 'web', character: 'spiderman', category: 'char', modelIds: ['spiderman', null], status: 'decoded', unsupported: [] });
  check(explicit.modelIds.length === 1 && explicit.status === 'decoded', 'Explicit contract fields must survive normalization');
  check(!normalizeEffect(null) && !normalizeEffect({}), 'Malformed entries must be ignored');
  check(!textureUrl('javascript:alert(1)') && !textureUrl('assets/vfx/../secret.png') && !textureUrl('//example.com/a.png'), 'Unsafe previews must be rejected');
  check(textureUrl('assets/vfx/thumbs/web.png') !== null, 'Local previews must work');
  check(matches(fallback, 'web.tga', 'char', 'spiderman') && !matches(fallback, '', 'other', 'all'), 'Search and filters must combine');
  const effects = Array.from({ length: 5333 }, (_, id) => id);
  check(effects.slice(0, PAGE_SIZE).length === 100 && effects.slice(5300, 5400).length === 33, 'Pages must stay bounded');
  check(escapeHtml('<img onerror="x">').includes('&lt;'), 'Metadata must be escaped');

  // 2. Color parsing and interpolation
  const colWhite = parseHexColor('0x00ffffff');
  check(colWhite.r === 1 && colWhite.g === 1 && colWhite.b === 1 && colWhite.a === 1, 'White 0x00ffffff must parse to 1,1,1,1');
  const colRed = parseHexColor('0x00ff0000');
  check(colRed.r === 1 && colRed.g === 0 && colRed.b === 0, 'Red must parse correctly');
  const colAlpha = parseHexColor('0x7f00ff00');
  check(Math.abs(colAlpha.a - 0.5) < 0.05, 'Alpha channel 0x7f must parse to ~0.5');

  const rampMid = evaluateColorRamp({ start1: '0x00ff0000', mid1: '0x0000ff00', end1: '0x000000ff' }, 0.5);
  check(rampMid.r < 0.1 && rampMid.g > 0.9 && rampMid.a > 0.9, 'Color ramp midpoint must evaluate to mid color');
  const rampEnd = evaluateColorRamp({ start1: '0x00ffffff', mid1: '0x00ffffff', end1: '0x00ffffff' }, 1.0);
  check(rampEnd.a > 0.99, 'Colour ramp must not fade the authored alpha at the end of life');
  check(resolveBoltCandidates('EBOLT_RHANDATTACH')[0] === 'Bip01 R HandAttach', 'EBOLT_RHANDATTACH must prefer the attach bone');
  check(resolveBoltCandidates('EBOLT_ORIGIN').length === 0, 'EBOLT_ORIGIN must resolve to no bone');

  // 3. Bone attachment resolution
  const leftHandTarget = resolveAttachmentTarget('char/bphero/bphero_melee_lhand', ['clawl']);
  check(leftHandTarget.boneName === 'Bip01 L Hand', 'Left hand effect must resolve to Bip01 L Hand');
  const rightHandTarget = resolveAttachmentTarget('char/spiderman/spiderman_webzip_impact');
  check(rightHandTarget.boneName === 'Bip01 R Hand', 'Webzip effect must resolve to Bip01 R Hand');
  const chestTarget = resolveAttachmentTarget('char/ironman/ironman_uniblast_shoot');
  check(chestTarget.boneName === 'Bip01 Spine2', 'Uniblast effect must resolve to Bip01 Spine2');
  const groundTarget = resolveAttachmentTarget('char/hulk/hulk_ground_smash');
  check(groundTarget.isGround === true && groundTarget.boneName === null, 'Ground smash effect must resolve to ground');

  // 4. Runtime instantiation
  const runtime = new VfxRuntime();
  check(runtime.speed === 1.0 && runtime.isPlaying === false, 'Runtime must initialize stopped at speed 1.0');
  runtime.setEffect({
    id: 'test_fx',
    definition: {
      templates: [{ loopTime: 2.0, persistLoop: 1 }],
      primitives: [{ type: 3, typeName: 'FXPRIM_TYPE_SPRITE', delay: 0.0, life: 1.5, radius: 0.5 }],
    },
  });
  check(runtime.loopTime === 2.0 && runtime.isLooping === true, 'Runtime loopTime must be 2.0 and loop true');
  check(runtime.playDuration === 2.0, 'playDuration must equal loopTime when primitives are shorter');

  // 4a. The template cycle must never truncate a primitive that outlives it
  // (the common case: a rigid body triggered 1 s into a 1 s ram attack that
  // stays for 16 s). 80.6% of the catalog is in this shape.
  const longRuntime = new VfxRuntime();
  longRuntime.setEffect({
    id: 'test_long_fx',
    definition: {
      templates: [{ loopTime: 1.0, persistLoop: 0 }],
      primitives: [
        { type: 3, typeName: 'FXPRIM_TYPE_SPRITE', delay: 0.0, life: 0.5 },
        { type: 12, typeName: 'FXPRIM_TYPE_MODEL', delay: 1.008, life: 16 },
      ],
    },
  });
  check(longRuntime.loopTime === 1.0, 'Template loopTime must be preserved');
  check(Math.abs(longRuntime.duration - 17.008) < 1e-9, 'duration must use the longest primitive delay + life');
  check(Math.abs(longRuntime.playDuration - 17.008) < 1e-9, 'playDuration must extend past loopTime');
  longRuntime.setEffect(null);
  check(longRuntime.duration === 0 && longRuntime.playDuration === longRuntime.loopTime, 'Clearing the effect must clear duration');

  // 4b. World-scale normalization: rqSize is authored in rig-local units, so
  // it must be multiplied by the GLB's measured scale instead of being used
  // as metres directly.
  check(runtime.worldScale === WORLD_UNIT_METERS, 'Runtime must default to the inch->metre scale without a model');
  const scaleModel = {
    traverse(cb) {
      cb({ isSkinnedMesh: true, name: 'rig_mesh', getWorldScale(v) { return v.set(0.0283, 0.0283, 0.0283); } });
    },
  };
  const scaleThree = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } } };
  const scaleRuntime = new VfxRuntime({ THREE: scaleThree, getModel: () => scaleModel });
  check(Math.abs(scaleRuntime.measureWorldScale() - 0.0283) < 1e-9, 'Runtime must measure the rig world scale');
  const scaleProbe = Object.create(VfxPrimitiveRunner.prototype);
  scaleProbe.runtime = scaleRuntime;
  scaleProbe.primitive = { rqSize: [0, 0, 40, -10000, 10000] };
  check(Math.abs(scaleProbe._curveSize(0.5) - 40 * 0.0283) < 1e-9, 'rqSize must be scaled by the measured rig scale');
  scaleProbe.primitive = {};
  check(Math.abs(scaleProbe._fallbackSize() - DEFAULT_PRIMITIVE_SIZE_IN * 0.0283) < 1e-9, 'Fallback size must be scaled by the measured rig scale');

  // A MODEL's rqSize is a dimensionless multiplier of the exported GLB size,
  // not a rig-local measurement, so it must not be multiplied by worldScale.
  const modelProbe = Object.create(VfxPrimitiveRunner.prototype);
  modelProbe.runtime = scaleRuntime;
  modelProbe.primitive = {
    typeName: 'FXPRIM_TYPE_MODEL',
    rqSize: [0, 0, 1, -1000, 1000],
    rqAlpha: [0, 0, 1, -10000, 10000],
    colors: {},
  };
  modelProbe.delay = 0;
  modelProbe.life = 1;
  modelProbe.mesh = {
    scale: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    traverse() {},
  };
  modelProbe.update(0.5, 0.016);
  check(Math.abs(modelProbe.mesh.scale.x - 1) < 1e-9, 'MODEL rqSize must stay a dimensionless multiplier');
  check(Math.abs(new VfxRuntime({ THREE: scaleThree }).measureWorldScale() - WORLD_UNIT_METERS) < 1e-12, 'Missing model must restore the default scale');
  let loopResets = 0;
  const loopRuntime = new VfxRuntime({ THREE: scaleThree });
  loopRuntime.runners = [{ reset() { loopResets += 1; } }];
  loopRuntime.loopTime = 1;
  loopRuntime.elapsed = 1;
  loopRuntime.isPlaying = false;
  loopRuntime.setLoop(true);
  check(loopRuntime.isPlaying === true && loopRuntime.elapsed === 0 && loopResets === 1, 'Enabling loop on a finished one-shot must restart it');
  loopRuntime.setLoop(false);
  check(loopRuntime.isLooping === false, 'Loop must be disableable');

  // 4c. Loop wraps must not wipe a trail's ribbon: its 1 s life outlives the
  // 0.3 s loopTime, so resetting the points each cycle keeps it invisible.
  const trailCycle = { trail: { points: [1, 2, 3] }, calls: 0, reset() { this.calls += 1; } };
  VfxPrimitiveRunner.prototype.resetCycle.call(trailCycle);
  check(trailCycle.calls === 0 && trailCycle.trail.points.length === 3, 'resetCycle() must preserve trail points');
  const plainCycle = { trail: null, calls: 0, reset() { this.calls += 1; } };
  VfxPrimitiveRunner.prototype.resetCycle.call(plainCycle);
  check(plainCycle.calls === 1, 'resetCycle() must reset non-trail primitives');

  // Quadratic curve evaluation checks
  check(evaluateQuadratic([0, 0, 0, 0, 1], 0.5, 99) === 99, 'Zero-coefficient curve must return fallback');
  check(evaluateQuadratic([2, 1, 0, 0, 10], 0.5, 0) === 1.0, '(2*0.25 + 1*0.5 + 0) = 1.0');
  check(evaluateQuadratic([0, 0, 20, 0, 5], 0.5, 0) === 5, 'Quadratic value must clamp to max');
  check(evaluateQuadratic([0, 0, -10, 0, 5], 0.5, 0) === 0, 'Quadratic value must clamp to min');
  check(evaluateQuadratic([0, 0, 5, 10, 2], 0.5, -1) === -1, 'Inverted min/max must return fallback');

  // Blend mode resolution
  const mockThree = { AdditiveBlending: 201, MultiplyBlending: 204, SubtractiveBlending: 205, NormalBlending: 200 };
  check(resolveBlendMode(3, mockThree) === mockThree.AdditiveBlending, 'Mode 3 must resolve to AdditiveBlending');
  check(resolveBlendMode(0, mockThree, 'ScreenDistortion') === mockThree.AdditiveBlending, 'ScreenDistortion must resolve to AdditiveBlending');
  check(resolveBlendMode(4, mockThree) === mockThree.MultiplyBlending, 'Mode 4 must resolve to MultiplyBlending');

  // Engine extensions: Camera shake
  const mockCam = { position: { x: 0, y: 1, z: 5, add(v) { this.x += v.x; this.y += v.y; this.z += v.z; }, sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; } } };
  const mockThreeRuntime = {
    Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } },
    Group: class { constructor() { this.children = []; this.position = { set() {}, copy() {} }; this.quaternion = { identity() {}, copy() {} }; } add(c) { this.children.push(c); } remove(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); } },
  };
  const shakeRuntime = new VfxRuntime({ scene: new mockThreeRuntime.Group(), camera: mockCam, THREE: mockThreeRuntime });
  shakeRuntime.triggerCameraShake(10.0, 5.0, 1);
  check(shakeRuntime.shakeDuration === 0.35 && shakeRuntime.shakeScale === 5.0, 'Camera shake must be triggered');
  shakeRuntime.isPlaying = true;
  shakeRuntime.update(0.1);
  check(shakeRuntime.shakeApplied === true, 'Camera shake offset must be marked applied');
  check(shakeRuntime.shakeOffset.x !== 0 || shakeRuntime.shakeOffset.y !== 0, 'Camera shake must apply offset to camera position');
  shakeRuntime.restoreCamera();
  check(shakeRuntime.shakeApplied === false, 'restoreCamera must clear shakeApplied');
  check(mockCam.position.x === 0 && mockCam.position.y === 1 && mockCam.position.z === 5, 'restoreCamera must restore baseline camera position');
  shakeRuntime.stop();
  check(mockCam.position.x === 0 && mockCam.position.y === 1 && mockCam.position.z === 5, 'Camera position must be cleanly restored on stop');

  // Non-mesh primitives (SOUND and CAMERA_SHAKE) trigger verification
  let playedBank = null;
  let playedSound = null;
  shakeRuntime.playSound = (b, s) => { playedBank = b; playedSound = s; };
  const soundPrim = { type: 21, typeName: 'FXPRIM_TYPE_SOUND', delay: 0.0, life: 1.0, soundBank: 'test_bank', soundName: 'test_snd' };
  const soundRunner = new VfxPrimitiveRunner(soundPrim, shakeRuntime, null);
  check(soundRunner.mesh === null, 'Sound primitive must have null mesh');
  soundRunner.update(0.1, 0.016);
  check(playedBank === 'test_bank' && playedSound === 'test_snd', 'Sound primitive must trigger playSound on update');
  check(soundRunner.soundPlayed === true, 'Sound primitive must set soundPlayed to true');

  const shakePrim = { type: 17, typeName: 'FXPRIM_TYPE_CAMERA_SHAKE', delay: 0.0, life: 1.0, shakeSpeed: 12.0, shakeScale: 3.5, shakeType: 2 };
  const shakePrimRunner = new VfxPrimitiveRunner(shakePrim, shakeRuntime, null);
  check(shakePrimRunner.mesh === null, 'Camera shake primitive must have null mesh');
  shakePrimRunner.update(0.05, 0.016);
  check(shakePrimRunner.shakeTriggered === true, 'Camera shake primitive must trigger shake on update');
  check(shakeRuntime.shakeScale === 3.5 && shakeRuntime.shakeSpeed === 12.0, 'Camera shake parameters must propagate to runtime');

  // Multi-material cloned model handling
  const mockMultiMatObj = {
    isMesh: true,
    material: [
      { color: { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } }, opacity: 1.0, clone() { return { ...this, color: { ...this.color } }; } },
      { color: { r: 0, g: 0, b: 0, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } }, opacity: 1.0, clone() { return { ...this, color: { ...this.color } }; } },
    ],
  };
  const modelPrim = { type: 11, typeName: 'FXPRIM_TYPE_MODEL', delay: 0.0, life: 1.0, colors: { start1: '0xffffffff', end1: '0x00000000' } };
  const modelRunner = new VfxPrimitiveRunner(modelPrim, shakeRuntime, null);
  modelRunner.mesh = {
    visible: true,
    scale: { set() {} },
    traverse(cb) { cb(mockMultiMatObj); },
  };
  modelRunner.update(0.2, 0.016);
  check(
    Math.abs(mockMultiMatObj.material[0].opacity - 1.0) < 0.01 &&
    Math.abs(mockMultiMatObj.material[1].opacity - 1.0) < 0.01,
    'Multi-material meshes must use the authored alpha without a synthetic envelope'
  );
  modelRunner.update(1.0, 0.016);
  check(modelRunner.mesh.visible === false, 'Primitive must hide mesh when localTime reaches or exceeds life');

  // Engine extensions: Animation sync
  let actionTime = 0.75;
  const syncRuntime = new VfxRuntime({
    scene: new mockThreeRuntime.Group(),
    getCurrentAction: () => ({ time: actionTime, getClip: () => ({ duration: 2.0 }) }),
    getAnimPlaying: () => true,
    THREE: mockThreeRuntime,
  });
  syncRuntime.loopTime = 1.5;
  syncRuntime.isPlaying = true;
  syncRuntime.update(0.016);
  check(Math.abs(syncRuntime.elapsed - 0.75) < 0.001, 'Animation sync must synchronize elapsed time to action time');
  syncRuntime.syncAnimation = false;
  syncRuntime.update(0.1);
  check(Math.abs(syncRuntime.elapsed - 0.85) < 0.001, 'Disabling animation sync must step elapsed by delta');

  // Animation sync loop wrap check
  syncRuntime.syncAnimation = true;
  actionTime = 1.6;
  syncRuntime.update(0.016);
  check(Math.abs(syncRuntime.elapsed - 0.1) < 0.001, 'Animation sync must wrap elapsed time via loopTime modulo');
  actionTime = 0.05; // Action looped back
  syncRuntime.update(0.016);
  check(Math.abs(syncRuntime.elapsed - 0.05) < 0.001, 'Animation sync must detect action loop wrap');

  // One-shot animation sync completion
  syncRuntime.isLooping = false;
  syncRuntime.isPlaying = true;
  syncRuntime.elapsed = 0.0;
  syncRuntime.lastSyncTime = null;
  const syncRunnerMesh = { visible: true };
  syncRuntime.runners = [{ mesh: syncRunnerMesh, update() {}, reset() {} }];
  actionTime = 0.5;
  syncRuntime.update(0.016);
  check(syncRuntime.isPlaying === true && Math.abs(syncRuntime.elapsed - 0.5) < 0.001, 'One-shot sync must advance without loop modulo');
  actionTime = 1.5;
  syncRuntime.update(0.016);
  check(syncRuntime.isPlaying === false && syncRuntime.elapsed === 1.5, 'One-shot sync must terminate when actTime >= loopTime');
  check(syncRunnerMesh.visible === false, 'One-shot sync completion must hide runner meshes');

  // One-shot animation sync loop back detection
  syncRuntime.isPlaying = true;
  syncRuntime.elapsed = 0.8;
  syncRuntime.lastSyncTime = 0.8;
  syncRunnerMesh.visible = true;
  actionTime = 0.1;
  syncRuntime.update(0.016);
  check(syncRuntime.isPlaying === false && syncRuntime.elapsed === 1.5, 'One-shot sync must terminate when action loops back');
  check(syncRunnerMesh.visible === false, 'One-shot sync loop back must hide runner meshes');

  // Authentic action binding: wait for the owning clip, then sync from _time
  let authenticClipName = 'idle';
  let authenticActionTime = 0.2;
  const authenticClips = { power_1: {} };
  const authenticRuntime = new VfxRuntime({
    scene: new mockThreeRuntime.Group(),
    getCurrentAction: () => ({ time: authenticActionTime, getClip: () => ({ name: authenticClipName, duration: 2.0 }) }),
    getAnimPlaying: () => true,
    getAnimClips: () => authenticClips,
    THREE: mockThreeRuntime,
  });
  authenticRuntime.loopTime = 1.5;
  authenticRuntime.isPlaying = true;
  const authenticMesh = { visible: true };
  authenticRuntime.runners = [{ mesh: authenticMesh, update() { authenticMesh.visible = true; }, reset() {} }];
  authenticRuntime.binding = { compatible: true, clip: 'power_1' };
  authenticRuntime.triggerTime = 0.5;
  authenticRuntime.update(0.016);
  check(authenticRuntime.waitingForClip === true && authenticMesh.visible === false, 'Authentic binding must hide until its own clip is playing');
  authenticClipName = 'power_1';
  authenticActionTime = 0.2;
  authenticRuntime.update(0.016);
  check(authenticRuntime.waitingForClip === false && authenticRuntime.waitingForTrigger === true, 'Authentic binding must wait for the powerstyle trigger time');
  authenticActionTime = 0.9;
  authenticRuntime.update(0.016);
  check(authenticRuntime.waitingForTrigger === false && Math.abs(authenticRuntime.elapsed - 0.4) < 0.001, 'Authentic binding must sync elapsed to action time minus trigger');
  check(authenticMesh.visible === true, 'Authentic binding must show runners after the trigger');
  authenticRuntime.binding = { compatible: true, clip: 'missing_clip' };
  authenticRuntime.elapsed = 0.0;
  authenticActionTime = 1.0;
  authenticRuntime.update(0.1);
  check(authenticRuntime.waitingForClip === false && Math.abs(authenticRuntime.elapsed - 0.1) < 0.001, 'Missing authentic clip must free-run instead of hiding the effect');
  authenticRuntime.binding = { compatible: false, clip: 'power_1' };
  authenticRuntime.elapsed = 0.0;
  authenticRuntime.update(0.1);
  check(Math.abs(authenticRuntime.elapsed - 0.1) < 0.001, 'Incompatible binding must never sync to the loaded model animation');

  // Non-sync one-shot lifecycle and cleanup
  const oneShotCam = { position: { x: 0, y: 1, z: 5, add(v) { this.x += v.x; this.y += v.y; this.z += v.z; }, sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; } } };
  const oneShotRuntime = new VfxRuntime({ scene: new mockThreeRuntime.Group(), camera: oneShotCam, THREE: mockThreeRuntime });
  oneShotRuntime.isLooping = false;
  oneShotRuntime.loopTime = 1.0;
  oneShotRuntime.isPlaying = true;
  oneShotRuntime.triggerCameraShake(10.0, 4.0, 0);
  let audioPaused = false;
  oneShotRuntime.activeAudio.push({ pause() { audioPaused = true; } });
  const oneShotMesh = { visible: true };
  oneShotRuntime.runners = [{ mesh: oneShotMesh, update() {}, reset() {} }];
  oneShotRuntime.update(0.1);
  check(oneShotRuntime.isPlaying === true && oneShotMesh.visible === true, 'One-shot midway must remain playing and visible');
  check(oneShotRuntime.shakeApplied === true, 'One-shot midway must apply shake');
  oneShotRuntime.update(0.95);
  check(oneShotRuntime.isPlaying === false && oneShotRuntime.elapsed === 1.0, 'One-shot must stop at loopTime');
  check(oneShotCam.position.x === 0 && oneShotCam.position.y === 1 && oneShotCam.position.z === 5, 'One-shot completion must restore camera');
  check(oneShotRuntime.shakeDuration === 0 && oneShotRuntime.shakeApplied === false, 'One-shot completion must clear shake');
  check(audioPaused === true && oneShotRuntime.activeAudio.length === 0, 'One-shot completion must pause and empty active audio');
  check(oneShotMesh.visible === false, 'One-shot completion must hide runner meshes');

  // pause() and replay() camera and audio reset
  oneShotRuntime.elapsed = 0.0;
  oneShotRuntime.triggerCameraShake(10.0, 3.0, 0);
  oneShotRuntime.isPlaying = true;
  oneShotRuntime.update(0.1);
  check(oneShotRuntime.shakeApplied === true, 'Shake applied before pause');
  let pauseAudioStopped = false;
  oneShotRuntime.activeAudio = [{ pause() { pauseAudioStopped = true; } }];
  oneShotRuntime.pause();
  check(oneShotRuntime.isPlaying === false, 'pause must set isPlaying to false');
  check(oneShotRuntime.shakeApplied === false && oneShotCam.position.x === 0, 'pause must restore camera');
  check(pauseAudioStopped === true && oneShotRuntime.activeAudio.length === 0, 'pause must stop and empty audio');

  oneShotRuntime.triggerCameraShake(10.0, 3.0, 0);
  oneShotRuntime.isPlaying = true;
  oneShotRuntime.update(0.1);
  check(oneShotRuntime.shakeApplied === true, 'Shake applied before replay');
  let replayAudioStopped = false;
  oneShotRuntime.activeAudio = [{ pause() { replayAudioStopped = true; } }];
  oneShotRuntime.replay();
  check(oneShotRuntime.isPlaying === true && oneShotRuntime.elapsed === 0.0, 'replay must reset elapsed and set isPlaying');
  check(oneShotRuntime.shakeApplied === false && oneShotCam.position.x === 0, 'replay must restore camera');
  check(replayAudioStopped === true && oneShotRuntime.activeAudio.length === 0, 'replay must stop and empty audio');

  // UV offset ownership & scrolling
  const sharedTex = { offset: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } } };
  sharedTex.clone = () => ({ offset: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } }, needsUpdate: false });
  const uvMockThree = {
    ...mockThreeRuntime,
    RepeatWrapping: 1000,
    SpriteMaterial: class { constructor(opts) { Object.assign(this, opts); this.color = { setRGB() {} }; } },
    Sprite: class { constructor(mat) { this.material = mat; this.visible = false; this.scale = { set() {} }; } },
  };
  const uvRuntime = new VfxRuntime({ scene: new uvMockThree.Group(), THREE: uvMockThree });
  uvRuntime.loadTexture = () => sharedTex;
  const scrollingPrim = { type: 3, typeName: 'FXPRIM_TYPE_SPRITE', delay: 0.0, life: 1.0, scrollVelocity: [0.5, 0.25, 0] };
  const uvRunner = new VfxPrimitiveRunner(scrollingPrim, uvRuntime, null);
  check(uvRunner.ownedTexture !== null && uvRunner.ownedTexture !== sharedTex, 'Scrolling primitive must own a cloned texture');
  uvRunner.update(0.2, 0.1);
  check(Math.abs(uvRunner.ownedTexture.offset.x - 0.05) < 0.001, 'Owned texture must scroll UV offset');
  check(sharedTex.offset.x === 0 && sharedTex.offset.y === 0, 'Shared texture must NOT scroll or be modified');
  uvRunner.reset();
  check(uvRunner.ownedTexture.offset.x === 0 && uvRunner.ownedTexture.offset.y === 0, 'Reset must restore owned texture UV offset to 0,0');
  check(sharedTex.offset.x === 0 && sharedTex.offset.y === 0, 'Reset must never touch unowned shared texture');

  // Cached GLB sharing
  let gltfLoadCount = 0;
  const mockScene = { clone(recursive) { return { isClone: true, recursive }; } };
  const glbRuntime = new VfxRuntime({
    scene: new mockThreeRuntime.Group(),
    THREE: mockThreeRuntime,
    gltfLoader: {
      load(path, onLoad) {
        gltfLoadCount++;
        onLoad({ scene: mockScene });
      },
    },
  });
  let scene1 = null;
  let scene2 = null;
  glbRuntime.modelMap = { 'test_model.glb': 'assets/vfx/models/test_model.glb' };
  glbRuntime.loadVfxModel('test_model.glb', (s) => { scene1 = s; });
  check(gltfLoadCount === 1 && scene1?.isClone === true, 'First load must query gltfLoader');
  glbRuntime.loadVfxModel('test_model.glb', (s) => { scene2 = s; });
  check(gltfLoadCount === 1 && scene2?.isClone === true && scene1 !== scene2, 'Second load must use cached model and return new clone');

  // Engine extensions: Model resolution
  runtime.modelMap = { 'models/effects/shield.igb': 'assets/vfx/models/effects/shield.glb' };
  check(runtime.resolveModelPath('models/effects/shield.igb') === 'assets/vfx/models/effects/shield.glb', 'resolveModelPath must resolve mapped model');
  check(runtime.resolveModelPath('effects/bubble.igb') === null, 'resolveModelPath must not invent a path for an unexported model');

  // Authentic effect -> action binding (powerstyles/*.muc contract)
  const actionMap = {
    format: 'mua2_vfx_action_map_v1',
    characters: {
      spiderman: { representativeModel: 'spiderman', modelIds: ['spiderman', 'spiderman_alt'], clipCount: 103 },
      abomb: { representativeModel: 'a_bomb_anti_1', modelIds: ['a_bomb_anti_1'], clipCount: 21 },
      juggernaut: { representativeModel: 'juggernaut_alt_2', modelIds: ['juggernaut_alt_2'], clipCount: 98 },
      minion: { representativeModel: null, modelIds: [], clipCount: 0 },
    },
    actors: {
      'char/spiderman/spiderman_blocking': ['spiderman'],
      'char/juggernaut/juggernaut_trail': ['abomb', 'juggernaut'],
      'char/minion/minion_shot': ['minion'],
      'base/misc/trail_default': ['spiderman', 'captainamerica'],
    },
    effects: {
      'char/spiderman/spiderman_blocking': [{ actor: 'spiderman', clip: 'blocking', animEnum: 'EA_BLOCKING', time: 0.0, kind: 'fx_core', bolt: 'Bip01 Spine2', bone: 'Bip01 Spine2', boneCandidates: ['Bip01 Spine2'], anchor: 'bone', boltResolved: true }],
      'char/juggernaut/juggernaut_trail': [{ actor: 'juggernaut', clip: 'power_1', animEnum: 'EA_POWER1', time: 0.5283664, kind: 'fx_core', bolt: 'Bip01 L Hand', bone: 'Bip01 L Hand', boneCandidates: ['Bip01 L Hand'], anchor: 'bone', boltResolved: true }],
      'char/minion/minion_shot': [{ actor: 'minion', clip: null, animEnum: 'EA_ATTACK', time: 0, kind: 'effect', bolt: 'Bip01 R Hand', bone: 'Bip01 R Hand', boneCandidates: ['Bip01 R Hand'], anchor: 'bone', boltResolved: true }],
      'base/misc/trail_default': [{ actor: 'spiderman', clip: 'run', animEnum: 'EA_RUN', time: 0.0, kind: 'fx_core', bolt: 'Bip01 Pelvis', bone: 'Bip01 Pelvis', boneCandidates: ['Bip01 Pelvis'], anchor: 'bone', boltResolved: true }],
      'map/newyork/fire': [{ actor: null, clip: null, time: null, kind: 'effect', bolt: null, bone: null, boneCandidates: [], anchor: 'origin', boltResolved: true }],
    },
  };
  const bindingModels = [
    { id: 'spiderman', name: 'Spider-Man', category: 'characters', source: 'actors/spiderman' },
    { id: 'spiderman_alt', name: 'Spider-Man Alt', category: 'characters', source: 'actors/spiderman' },
    { id: 'a_bomb_anti_1', name: 'A-Bomb', category: 'characters', source: 'actors/abomb' },
    { id: 'juggernaut_alt_2', name: 'Juggernaut', category: 'characters', source: 'actors/juggernaut' },
  ];
  const planFor = (id, loadedId) => {
    const segments = id.split('/');
    const modelIds = id.startsWith('char/spiderman') ? ['spiderman']
      : id.startsWith('char/juggernaut') ? ['juggernaut_alt_2'] : [];
    return planEffectBinding(
      { id, category: segments[0], character: segments[0] === 'char' ? segments[1] : null, modelIds },
      {
        actionMap,
        loadedModel: bindingModels.find((model) => model.id === loadedId) || null,
        models: bindingModels,
        isProp: () => false,
      },
    );
  };

  const blockingPlan = planFor('char/spiderman/spiderman_blocking', 'spiderman');
  check(blockingPlan.compatible && blockingPlan.anchorMode === 'bone' && blockingPlan.bone === 'Bip01 Spine2', 'Spider-Man blocking must bind to the authentic spine bone');
  check(blockingPlan.clip === 'blocking' && blockingPlan.animEnum === 'EA_BLOCKING', 'Blocking binding must expose clip and enum');

  const crossPlan = planFor('char/juggernaut/juggernaut_trail', 'a_bomb_anti_1');
  check(crossPlan.compatible && crossPlan.actor === 'abomb', 'A-Bomb must keep the Juggernaut trail when it is an authentic actor');
  check(Math.abs(crossPlan.triggerTime - 0.5283664) < 1e-6, 'Trigger time must come from the powerstyle entry');

  const wrongModelPlan = planFor('char/juggernaut/juggernaut_trail', 'spiderman');
  check(wrongModelPlan.requiresModelLoad && wrongModelPlan.targetModelId === 'juggernaut_alt_2', 'Incompatible model must request the authentic owner model');
  check(!wrongModelPlan.compatible, 'Incompatible model must not anchor the effect');

  const minionPlan = planFor('char/minion/minion_shot', 'spiderman');
  check(minionPlan.suspended && !minionPlan.compatible, 'Effect without representative model must be suspended instead of anchored arbitrarily');

  const basePlan = planFor('base/misc/trail_default', 'spiderman');
  check(basePlan.compatible && basePlan.anchorMode === 'bone', 'Shared base effect must use the loaded actor when it references it');
  const baseWrongPlan = planFor('base/misc/trail_default', 'juggernaut_alt_2');
  check(!baseWrongPlan.compatible && baseWrongPlan.anchorMode === 'origin', 'Shared base effect must stay at the origin for a non-referencing actor');

  const sceneryPlan = planFor('map/newyork/fire', 'spiderman');
  check(sceneryPlan.scenery && sceneryPlan.anchorMode === 'origin', 'Scenery effects must anchor at the origin, never on the character');

  const nonCasterPlan = planEffectBinding(
    { id: 'char/spiderman/spiderman_web_impact', category: 'char', character: 'spiderman', modelIds: ['spiderman'] },
    {
      actionMap: {
        characters: actionMap.characters,
        effects: {
          'char/spiderman/spiderman_web_impact': [{
            actor: 'spiderman',
            clip: 'attack1',
            recipient: 'target',
            anchor: 'bone',
            bone: 'Bip01 Head',
          }],
        },
        actors: { 'char/spiderman/spiderman_web_impact': ['spiderman'] },
      },
      loadedModel: bindingModels.find((model) => model.id === 'spiderman'),
      models: bindingModels,
      isProp: () => false,
    },
  );
  check(nonCasterPlan.compatible && nonCasterPlan.anchorMode === 'origin' && nonCasterPlan.bone === null, 'Target/projectile recipients must stay at origin rather than attaching to caster bone');

  // effects.json ownership fallback when the powerstyle map is unavailable
  const fallbackEffect = { id: 'char/spiderman/fallback_fx', category: 'char', character: 'spiderman', modelIds: ['spiderman'] };
  const noMapPlan = planEffectBinding(fallbackEffect, {
    actionMap: null,
    loadedModel: bindingModels[0],
    models: bindingModels,
    isProp: () => false,
  });
  check(noMapPlan.compatible && noMapPlan.ownerModelMatch && noMapPlan.anchorMode === 'model', 'effects.json modelIds must keep the owning model compatible without the action map');
  const noMapWrongPlan = planEffectBinding(fallbackEffect, {
    actionMap: null,
    loadedModel: bindingModels[3],
    models: bindingModels,
    isProp: () => false,
  });
  check(noMapWrongPlan.requiresModelLoad && noMapWrongPlan.targetModelId === 'spiderman', 'effects.json modelIds must still load the authentic owner for the wrong model');

  // Exact bone names must win over shared prefixes (Hand vs HandAttach)
  const rig = {
    traverse(cb) {
      for (const name of ['Bip01 Spine', 'Bip01 Spine2', 'Bip01 R Hand', 'Bip01 R HandAttach']) {
        cb({ isBone: true, name });
      }
    },
  };
  check(findBoneInModel(rig, 'Bip01 Spine')?.name === 'Bip01 Spine', 'Bone lookup must prefer the exact spine name over Spine2');
  check(findBoneInModel(rig, 'Bip01 R Hand')?.name === 'Bip01 R Hand', 'Bone lookup must prefer Hand over HandAttach');
  check(findBoneInModel(rig, 'R HandAttach')?.name === 'Bip01 R HandAttach', 'Bone lookup must accept a unique attach-bone match');
  check(findBoneInModel(rig, 'Bip01 Tail') === null, 'Bone lookup must return null when no bone matches');

  // 5. Controller model linking, props classification and filtering
  const testModels = [
    { id: 'spiderman', name: 'Homem-Aranha', category: 'characters', source: 'actors/spiderman' },
    { id: 'daredevil_anti_1', name: 'Demolidor Bola', category: 'characters', source: 'actors/daredevil_bola' },
    { id: 'fxt_playingcardfront', name: 'Gambit Cards', category: 'props', source: 'actors/gambit_cards' },
    { id: 'lukecage_2', name: 'Luke Cage Chain', category: 'characters', source: 'actors/lukecage_chain' },
    { id: 'ironman', name: 'Homem de Ferro', category: 'characters', source: 'actors/ironman' },
  ];
  const controller = new VfxCatalogController({ models: testModels });

  // Prop classification checks
  check(controller.isProp(testModels[0]) === false, 'Spider-Man must not be classified as prop');
  check(controller.isProp(testModels[1]) === true, 'Daredevil bola must be classified as prop via source');
  check(controller.isProp(testModels[2]) === true, 'Gambit cards must be classified as prop via category');
  check(controller.isProp(testModels[3]) === true, 'Luke Cage chain must be classified as prop via source');

  // Effect model linking
  const effectWithProp = { id: 'dd_fx', name: 'dd_bola', modelIds: ['daredevil_anti_1'] };
  const effectWithChar = { id: 'sm_fx', name: 'sm_web', modelIds: ['spiderman'] };
  const effectMulti = { id: 'combo_fx', name: 'combo', modelIds: ['spiderman', 'fxt_playingcardfront'] };
  const effectUnlinked = { id: 'generic_fx', name: 'spark', modelIds: [] };

  check(controller.linkedModels(effectWithProp).length === 1 && controller.linkedModels(effectWithProp)[0].id === 'daredevil_anti_1', 'Must link daredevil_anti_1');
  check(controller.linkedModels(effectMulti).length === 2, 'Multi-linked effect must return both models');
  check(controller.linkedModels(effectUnlinked).length === 0, 'Unlinked effect must return empty array');

  // matchesModel filters
  check(controller.matchesModel(effectWithProp, 'all') === true, 'all filter must match all');
  check(controller.matchesModel(effectUnlinked, 'all') === true, 'all filter must match unlinked');

  check(controller.matchesModel(effectWithProp, 'with-model') === true, 'with-model must match effect with linked model');
  check(controller.matchesModel(effectUnlinked, 'with-model') === false, 'with-model must reject unlinked effect');

  check(controller.matchesModel(effectWithProp, 'with-prop') === true, 'with-prop must match effect linked to prop');
  check(controller.matchesModel(effectWithChar, 'with-prop') === false, 'with-prop must reject effect linked only to character');
  check(controller.matchesModel(effectMulti, 'with-prop') === true, 'with-prop must match multi effect with prop');
  check(controller.matchesModel(effectUnlinked, 'with-prop') === false, 'with-prop must reject unlinked effect');

  // loaded model filter
  controller.loadedModel = testModels[0]; // spiderman
  check(controller.matchesModel(effectWithChar, 'loaded') === true, 'loaded filter must match active model effect');
  check(controller.matchesModel(effectWithProp, 'loaded') === false, 'loaded filter must reject different model effect');
  controller.loadedModel = null;
  check(controller.matchesModel(effectWithChar, 'loaded') === false, 'loaded filter must reject when no model loaded');

  // specific model filter
  check(controller.matchesModel(effectWithProp, 'daredevil_anti_1') === true, 'specific filter must match matching id');
  check(controller.matchesModel(effectWithProp, 'spiderman') === false, 'specific filter must reject mismatching id');

  // 6. Navigation and history state management
  controller.effects = [effectWithProp, effectWithChar, effectMulti, effectUnlinked];
  controller.selectedEffect = effectWithChar;
  controller.surfaces = {
    sidebar: {
      search: { value: 'web' },
      category: { value: 'char' },
      character: { value: 'spiderman' },
      model: { value: 'all' },
      page: 2,
      showDetail: true,
      scroller: { scrollTop: 150 },
      history: [],
      list: { querySelectorAll: () => [], replaceChildren: () => {} },
      pages: { replaceChildren: () => {}, hidden: false },
      count: { textContent: '' },
      detail: { querySelector: () => null, replaceChildren: () => {}, innerHTML: '', hidden: false },
    },
    modal: {
      search: { value: '' },
      category: { value: 'all' },
      character: { value: 'all' },
      model: { value: 'all' },
      page: 0,
      showDetail: false,
      scroller: { scrollTop: 0 },
      history: [],
      list: { querySelectorAll: () => [], replaceChildren: () => {} },
      pages: { replaceChildren: () => {}, hidden: false },
      count: { textContent: '' },
      detail: { querySelector: () => null, replaceChildren: () => {}, innerHTML: '', hidden: false },
    },
  };

  const captured = controller.captureState('sidebar');
  check(captured.search === 'web' && captured.page === 2 && captured.selectedId === 'sm_fx' && captured.scroll === 150, 'State capture must preserve all fields');

  controller.remember('sidebar');
  check(controller.surfaces.sidebar.history.length === 1, 'remember() must push state to history');

  // Change state
  controller.surfaces.sidebar.search.value = 'another';
  controller.surfaces.sidebar.page = 0;
  controller.surfaces.sidebar.showDetail = false;

  // Restore via goBack
  let navigationRendered = false;
  controller.render = () => {};
  controller.renderDetails = () => {};
  controller.renderNavigation = () => { navigationRendered = true; };
  controller.focusSurface = () => {};

  controller.goBack('sidebar');
  check(controller.surfaces.sidebar.search.value === 'web', 'goBack() must restore search value');
  check(controller.surfaces.sidebar.page === 2, 'goBack() must restore page');
  check(controller.surfaces.sidebar.showDetail === true, 'goBack() must restore showDetail');
  check(controller.surfaces.sidebar.scroller.scrollTop === 150, 'goBack() must restore scroll position');
  check(controller.selectedEffect.id === 'sm_fx', 'goBack() must preserve selected effect');

  // closeDetail must not stop runtime or nullify selected effect
  let runtimeStopped = false;
  controller.runtime.stop = () => { runtimeStopped = true; };
  controller.closeDetail('sidebar');
  check(controller.surfaces.sidebar.showDetail === false, 'closeDetail() must close detail view');
  check(controller.selectedEffect.id === 'sm_fx', 'closeDetail() must preserve selected effect');
  check(runtimeStopped === false, 'closeDetail() must not stop runtime');

  // onModelChange association
  const mockModel = { name: 'spiderman', userData: { catalogEntry: testModels[0] } };
  controller.onModelChange(mockModel);
  check(controller.loadedModel?.id === 'spiderman', 'onModelChange() must associate catalogEntry from userData');

  return 'VFX catalog self-check passed';
}
