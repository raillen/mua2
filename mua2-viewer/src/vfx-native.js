// Native Three.js recreations for hand-picked powers.
//
// The `.igz` files hold parameters only: emission rate, velocity fields and
// physics lived in the Alchemy C++ engine, which no decoder can recover from
// the asset. So each preset below keeps every value the decoder DID extract
// verbatim (`prim` is the index in assets/vfx/effects.json, enforced by
// tools/test_vfx_native.mjs) and isolates the parts the engine owned under
// `spawn`, which is authored here and never presented as extracted data.
//
// Render mapping (authored, documented once):
//   FXPRIM_TYPE_SPRITE / FLARE   -> 'glow'    billboard pool
//   FXPRIM_TYPE_CYLINDER         -> 'strand'  hanging ribbon (web) 
//                                -> 'shaft'   axial cone (energy)
//   FXPRIM_TYPE_PARTICLE_CLOUD   -> 'glow'    (puff texture, normal blend)
import { evaluateQuadratic, evaluateColorRamp, resolveBlendMode } from './vfx.js';

export const NATIVE_PRESETS = Object.freeze({
  'char/ironman/ironman_ability_fly_hand.igz': {
    label: 'Iron Man — Repulsor de mão',
    loop: true,
    duration: 3.0,
    parts: [
      {
        render: 'glow',
        prim: 0,
        texture: 'textures/blackhole.tga',
        colors: { start1: '0xff4080ff', mid1: '0xff4080ff', end1: '0xff4080ff' },
        rqSize: [-5.7865, 5.7865, 8.0, -10000.0, 10000.0],
        rqAlpha: [0.0, 0.0, 1.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 0.3,
        blendMode: 1,
        spawn: { count: 5, radius: 1.2, speed: 0.4, opacity: 0.35 },
      },
      {
        render: 'glow',
        prim: 1,
        texture: 'textures/misc_hitflash.tga',
        colors: { start1: '0xff4080ff', mid1: '0xff4080ff', end1: '0xff4080ff' },
        rqSize: [-20.0, 20.0, 20.0, -10000.0, 10000.0],
        rqAlpha: [0.0, 0.0, 1.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 0.3,
        blendMode: 1,
        spawn: { count: 1, radius: 0.1, speed: 0.0, opacity: 0.45 },
      },
      {
        render: 'glow',
        prim: 2,
        texture: 'textures/speed4.tga',
        colors: { start1: '0x00ff8080', mid1: '0x004080ff', end1: '0x000042ff' },
        rqSize: [0.0, 0.0, 3.0, -10000.0, 10000.0],
        rqAlpha: [-4.0, 4.0, 0.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 3.0,
        delay: 0.0,
        gravity: 0.3,
        blendMode: 3,
        spawn: { count: 8, radius: 2.0, speed: 0.8, opacity: 0.6 },
      },
      {
        render: 'glow',
        prim: 3,
        texture: 'textures/blackhole.tga',
        colors: { start1: '0xff4080ff', mid1: '0xff4080ff', end1: '0xff4080ff' },
        rqSize: [-5.7865, 5.7865, 8.0, -10000.0, 10000.0],
        rqAlpha: [0.0, 0.0, 1.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 2.0,
        delay: 0.0,
        gravity: 0.3,
        blendMode: 1,
        spawn: { count: 3, radius: 2.5, speed: 0.3, opacity: 0.3 },
      },
    ],
  },

  'char/spiderman/spiderman_blocking.igz': {
    label: 'Spider-Man — Escudo de teia',
    loop: false,
    duration: 3.0,
    parts: [
      {
        render: 'strand',
        prim: 0,
        texture: 'materials/effects/misc/fxt_sm3_webstickyb2.tga',
        colors: { start1: '0x00ffffff', mid1: '0x00ffffff', end1: '0x00ffffff' },
        rqSize: [-3.6486, 3.6486, 0.0, -1000.0, 1000.0],
        rqAlpha: [-1.1422, 0.5711, 0.5711, -1000000.0, 1000000.0],
        rqLength: [0.0, 0.0, 0.0, 0.0, 0.0],
        life: 3.0,
        delay: 0.0,
        gravity: 0.6,
        blendMode: 0,
        spawn: { count: 14, length: 70, width: 26, tilt: 1.5, opacity: 1.4 },
      },
      {
        render: 'strand',
        prim: 1,
        texture: 'materials/effects/misc/fxt_sm3_webstickyc.tga',
        colors: { start1: '0x00e3e3e3', mid1: '0x00e3e3e3', end1: '0x00e3e3e3' },
        rqSize: [0.0, 0.0, 0.0, -1000.0, 1000.0],
        rqAlpha: [-2.0976, 1.577, 0.5206, 0.0, 1.0],
        rqLength: [0.0, 0.0, 0.0, 0.0, 0.0],
        life: 1.0,
        delay: 0.0,
        gravity: 0.8,
        blendMode: 0,
        spawn: { count: 10, length: 55, width: 20, tilt: 1.45, opacity: 1.4 },
      },
      {
        render: 'strand',
        prim: 6,
        texture: 'materials/effects/misc/fxt_sm3_webstickyc.tga',
        colors: { start1: '0x00e3e3e3', mid1: '0x00e3e3e3', end1: '0x00e3e3e3' },
        rqSize: [0.0, 0.0, 0.0, -1000.0, 1000.0],
        rqAlpha: [-2.5585, 2.0379, 0.5206, 0.0, 1.0],
        rqLength: [0.0, 0.0, 0.0, 0.0, 0.0],
        life: 1.0,
        delay: 0.608,
        gravity: 0.8,
        blendMode: 0,
        spawn: { count: 8, length: 45, width: 18, tilt: 1.55, opacity: 1.4 },
      },
      {
        render: 'strand',
        prim: 7,
        texture: 'materials/effects/misc/fxt_sm3_webstickyb2.tga',
        colors: { start1: '0x00e3e3e3', mid1: '0x00e3e3e3', end1: '0x00e3e3e3' },
        rqSize: [0.0, 0.0, 0.0, -1000.0, 1000.0],
        rqAlpha: [-2.5832, 2.5963, -0.0132, 0.0, 1.0],
        rqLength: [0.0, 0.0, 0.0, 0.0, 0.0],
        life: 3.0,
        delay: 0.0,
        gravity: 0.8,
        blendMode: 0,
        spawn: { count: 16, length: 40, width: 14, tilt: 1.35, opacity: 1.4 },
      },
    ],
  },
});

export function isNativeEffect(effectId) {
  return typeof effectId === 'string' && Object.hasOwn(NATIVE_PRESETS, effectId);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Per-particle lifetime is a fraction of the authentic primitive life: the
// emitter keeps respawning for as long as the decoded `life` runs, which is
// what makes the field continuous instead of one frozen burst.
const PARTICLE_LIFE_RANGE = [0.45, 0.85];

class GlowPart {
  constructor(spec, runtime, parent) {
    const THREE = runtime.THREE;
    this.spec = spec;
    this.runtime = runtime;
    this.blending = resolveBlendMode(spec.blendMode, THREE, spec.shaderName || null);
    this.texPath = null;
    this.sprites = [];
    for (let i = 0; i < spec.spawn.count; i += 1) {
      const material = new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        blending: this.blending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      parent.add(sprite);
      this.sprites.push({
        sprite,
        material,
        born: -Infinity,
        life: spec.life,
        direction: new THREE.Vector3(),
        sizeScale: 1,
      });
    }
  }

  _ensureTexture() {
    if (this.texPath) return;
    const runtime = this.runtime;
    this.texPath = runtime.resolveTexturePath([this.spec.texture], null) || null;
    const texture = runtime.loadTexture(this.texPath);
    for (const p of this.sprites) p.material.map = texture;
  }

  _spawn(p, now) {
    const spec = this.spec;
    const [minLife, maxLife] = PARTICLE_LIFE_RANGE;
    p.born = now;
    p.life = Math.max(0.05, spec.life * (minLife + Math.random() * (maxLife - minLife)));
    // Uniform direction on a sphere, then pushed out to the authored radius.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    p.direction.set(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );
    p.sizeScale = 0.65 + Math.random() * 0.6;
  }

  update(t, delta) {
    this._ensureTexture();
    const spec = this.spec;
    const scale = this.runtime.worldScale || 0.0254;
    const partTime = t - spec.delay;
    const active = partTime >= 0 && partTime < spec.life;
    const progress = active ? clamp01(partTime / spec.life) : 1;

    const rawSize = evaluateQuadratic(spec.rqSize, progress, null);
    const size = (rawSize !== null && Math.abs(rawSize) > 1e-4 ? Math.abs(rawSize) : 12) * scale;
    const alpha = clamp01(evaluateQuadratic(spec.rqAlpha, progress, 1));
    const color = evaluateColorRamp(spec.colors, progress);
    // Additive parts stack: several sprites of the same texture saturate to
    // white, so a preset may scale the authentic alpha down (authored).
    const opacity = spec.spawn.opacity ?? 1;

    for (const p of this.sprites) {
      if (!active) {
        p.sprite.visible = false;
        continue;
      }
      if (!Number.isFinite(p.born) || partTime - p.born > p.life) this._spawn(p, partTime);
      const age = partTime - p.born;
      if (age < 0 || age > p.life) {
        p.sprite.visible = false;
        continue;
      }
      const local = age / p.life;
      // Fade in/out per particle keeps the field continuous; the decoded
      // rqAlpha above is the primitive-wide envelope.
      const fade = Math.min(1, age / 0.08) * Math.min(1, (1 - local) / 0.3);
      const reach = spec.spawn.radius * scale;
      const travel = spec.spawn.speed * scale * age;
      p.sprite.position.set(
        p.direction.x * (reach + travel),
        p.direction.y * (reach + travel) - spec.gravity * scale * age * age,
        p.direction.z * (reach + travel),
      );
      const current = size * p.sizeScale * (0.7 + 0.3 * local);
      p.sprite.scale.set(current, current, 1);
      p.material.color.setRGB(color.r, color.g, color.b);
      p.material.opacity = Math.min(1, alpha * fade * opacity);
      p.sprite.visible = p.material.opacity > 0.002;
    }
    void delta;
  }

  reset() {
    for (const p of this.sprites) {
      p.born = -Infinity;
      p.sprite.visible = false;
    }
  }

  dispose() {
    for (const p of this.sprites) {
      p.sprite.parent?.remove(p.sprite);
      p.material.dispose();
    }
    this.sprites = [];
  }
}

class StrandPart {
  constructor(spec, runtime, parent) {
    const THREE = runtime.THREE;
    this.spec = spec;
    this.runtime = runtime;
    this.blending = resolveBlendMode(spec.blendMode, THREE, spec.shaderName || null);
    this.texPath = null;
    this.strands = [];
    // Geometry hangs from its own origin, so scaling Y extends the strand
    // downward from the anchor instead of growing around it.
    this.geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geometry.translate(0, -0.5, 0);
    for (let i = 0; i < spec.spawn.count; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: this.blending,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.rotation.order = 'YXZ';
      mesh.rotation.y = (i / spec.spawn.count) * Math.PI * 2 + Math.random() * 0.4;
      mesh.rotation.x = spec.spawn.tilt * (0.85 + Math.random() * 0.3);
      mesh.visible = false;
      parent.add(mesh);
      this.strands.push({ mesh, material, offset: Math.random() * 0.12 });
    }
  }

  _ensureTexture() {
    if (this.texPath) return;
    const runtime = this.runtime;
    this.texPath = runtime.resolveTexturePath([this.spec.texture], null) || null;
    const texture = runtime.loadTexture(this.texPath);
    for (const s of this.strands) s.material.map = texture;
  }

  update(t, delta) {
    this._ensureTexture();
    const spec = this.spec;
    const scale = this.runtime.worldScale || 0.0254;
    const partTime = t - spec.delay;
    const active = partTime >= 0 && partTime < spec.life;
    const progress = active ? clamp01(partTime / spec.life) : 1;

    const rawSize = evaluateQuadratic(spec.rqSize, progress, null);
    const alpha = active ? clamp01(evaluateQuadratic(spec.rqAlpha, progress, 1)) : 0;
    const color = evaluateColorRamp(spec.colors, progress);
    const width = (rawSize !== null && Math.abs(rawSize) > 1e-4 ? Math.abs(rawSize) : spec.spawn.width) * scale;
    const length = spec.spawn.length * scale;

    for (let i = 0; i < this.strands.length; i += 1) {
      const s = this.strands[i];
      if (!active) {
        s.mesh.visible = false;
        continue;
      }
      const local = clamp01((partTime - s.offset) / Math.max(0.05, spec.life - s.offset));
      const grow = Math.min(1, local * 3.2);
      s.mesh.scale.set(width, Math.max(0.001, length * grow), 1);
      // Strands radiate nearly horizontally (tilt ~= pi/2); the authentic
      // gravity term only sags them slightly instead of folding the shield.
      s.mesh.position.y = -spec.gravity * scale * local * local * length * 0.08;
      s.material.color.setRGB(color.r, color.g, color.b);
      s.material.opacity = Math.min(1, alpha * (1 - local * 0.35) * (spec.spawn.opacity ?? 1));
      s.mesh.visible = s.material.opacity > 0.002;
    }
    void delta;
  }

  reset() {
    for (const s of this.strands) s.mesh.visible = false;
  }

  dispose() {
    for (const s of this.strands) {
      s.mesh.parent?.remove(s.mesh);
      s.material.dispose();
    }
    this.strands = [];
    this.geometry.dispose();
  }
}

const PART_CLASSES = { glow: GlowPart, strand: StrandPart };

class NativeEffect {
  constructor(preset, runtime, group) {
    this.preset = preset;
    this.loop = Boolean(preset.loop);
    this.duration = preset.duration;
    this.mesh = group;
    this.parts = preset.parts.map((spec) => {
      const PartClass = PART_CLASSES[spec.render];
      return new PartClass(spec, runtime, group);
    }).filter(Boolean);
  }

  update(cycleTime, delta) {
    // _hideRunners() (clip wait / one-shot end) hides the whole group, so a
    // resumed playback restores it here.
    if (this.mesh) this.mesh.visible = true;
    for (const part of this.parts) part.update(cycleTime, delta);
  }

  reset() {
    for (const part of this.parts) part.reset();
  }

  // A native effect owns its own emission window, so a loop wrap only restarts
  // it (no ribbon state to preserve, unlike the decoded trail primitives).
  resetCycle() {
    this.reset();
  }

  dispose() {
    for (const part of this.parts) part.dispose();
    this.parts = [];
    if (this.mesh?.parent) this.mesh.parent.remove(this.mesh);
    this.mesh = null;
  }
}

export function createNativeEffect(effect, runtime) {
  const preset = effect && Object.hasOwn(NATIVE_PRESETS, effect.id) ? NATIVE_PRESETS[effect.id] : null;
  if (!preset || !runtime || !runtime.THREE || !runtime.root) return null;
  const group = new runtime.THREE.Group();
  group.name = `NativeEffect:${effect.id}`;
  runtime.root.add(group);
  return new NativeEffect(preset, runtime, group);
}
