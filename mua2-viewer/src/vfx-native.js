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
//   FXPRIM_TYPE_SPRITE / ORIENTED_SPRITE / FLARE -> 'glow'  billboard pool
//   FXPRIM_TYPE_CYLINDER                         -> 'strand' hanging ribbon
//   FXPRIM_TYPE_TRAIL                            -> 'trail'  motion ribbon
//   FXPRIM_TYPE_LIGHTNING                        -> 'bolt'   segmented bolt
//   FXPRIM_TYPE_PARTICLE_CLOUD                   -> 'glow'   (puff texture)
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

  'char/wolverine/wolverine_claw_trail.igz': {
    label: 'Wolverine — Rastro das garras',
    loop: false,
    duration: 1.2,
    parts: [
      {
        render: 'trail',
        prim: 0,
        texture: 'textures/bolt_sharp.tga',
        colors: { start1: '0x00b8b3a0', mid1: '0x00e7dcd8', end1: '0x00e7dcd8' },
        rqSize: [0.0, 0.0, 7.0, -10000.0, 10000.0],
        rqAlpha: [-0.2076, 0.1038, 0.1038, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.1, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 2.05,
        blendMode: 3,
        spawn: { samples: 64, history: 0.55, opacity: 2.5 },
      },
    ],
  },

  'char/bphero/bphero_f_bs_thor_beam.igz': {
    label: 'Thor — Raio do Mjolnir',
    loop: true,
    duration: 3.0,
    parts: [
      {
        render: 'bolt',
        prim: 0,
        texture: 'materials/effects/lightning/fxt_sm3_lightning_gate_02.tga',
        colors: { start1: '0x00fff3b8', mid1: '0x00fff3b8', end1: '0x00fff3b8' },
        rqSize: [0.0, 0.0, 6.0, -10000.0, 10000.0],
        rqAlpha: [-4.0, 4.0, 0.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 1.0, -10000.0, 10000.0],
        life: 20.0,
        delay: 0.0,
        gravity: 0.1,
        blendMode: 3,
        spawn: { branches: 3, length: 120, segments: 18, jitter: 1.6, widthScale: 0.16, opacity: 1.6, curveWindow: 3.0, length: 110 },
      },
      {
        render: 'bolt',
        prim: 1,
        texture: 'materials/effects/lightning/fxt_lightning_bolt_d.tga',
        colors: { start1: '0x00fff3b8', mid1: '0x00fff3b8', end1: '0x00fff3b8' },
        rqSize: [0.0, 0.0, 20.0, -10000.0, 10000.0],
        rqAlpha: [-4.0, 4.0, 0.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 1.0, -10000.0, 10000.0],
        life: 15.0,
        delay: 0.0,
        gravity: 0.2,
        blendMode: 3,
        spawn: { branches: 2, length: 140, segments: 22, jitter: 1.2, widthScale: 0.22, opacity: 1.4, curveWindow: 3.0 },
      },
    ],
  },

  'char/hulk/hulk_clap_impact.igz': {
    label: 'Hulk — Onda de choque (Clap)',
    loop: false,
    duration: 1.0,
    parts: [
      {
        render: 'glow',
        prim: 2,
        texture: 'materials/effects/misc/fxt_sm3_whiteripplewavea.tga',
        colors: { start1: '0x00a0ffa6', mid1: '0x00fefffe', end1: '0x00fefffe' },
        rqSize: [-133.7009, 258.7009, 101.1006, -10000.0, 10000.0],
        rqAlpha: [0.06, -0.16, 0.1, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 0.35,
        blendMode: 3,
        spawn: { count: 1, radius: 0.0, speed: 0.0, opacity: 1.0 },
      },
      {
        render: 'glow',
        prim: 3,
        texture: 'materials/effects/smoke/fxt_sm3_smoke4.tga',
        colors: { start1: '0x00a0ffa6', mid1: '0x00d9ffdb', end1: '0x00fefffe' },
        rqSize: [-124.9171, 249.9171, 25.0, -10000.0, 10000.0],
        rqAlpha: [-0.5937, 0.5937, 0.0, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 0.35,
        blendMode: 0,
        spawn: { count: 8, radius: 2.2, speed: 1.2, opacity: 0.6 },
      },
      {
        render: 'glow',
        prim: 4,
        texture: 'materials/effects/smoke/fxt_smoke09_d.tga',
        colors: { start1: '0x00c8ffcb', mid1: '0x00fefffe', end1: '0x00fefffe' },
        rqSize: [-133.7009, 258.7009, 25.0, -10000.0, 10000.0],
        rqAlpha: [0.1946, -0.3946, 0.2, -10000.0, 10000.0],
        rqLength: [0.0, 0.0, 0.0, -10000.0, 10000.0],
        life: 1.0,
        delay: 0.0,
        gravity: 1.0,
        blendMode: 3,
        spawn: { count: 6, radius: 2.8, speed: 1.6, opacity: 0.5 },
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

// A lightning primitive is a ribbon strip rebuilt from a jittered polyline.
// Width and brightness still come from the authentic rqSize/rqAlpha curves;
// the polyline shape is authored (the engine generated it at runtime).
class BoltPart {
  constructor(spec, runtime, parent) {
    const THREE = runtime.THREE;
    this.spec = spec;
    this.runtime = runtime;
    this.blending = resolveBlendMode(spec.blendMode, THREE, spec.shaderName || null);
    this.texPath = null;
    this.segments = Math.max(2, spec.spawn.segments || 16);
    this.refresh = spec.spawn.refresh || 0.06;
    this.lastBuild = -Infinity;
    this.bolts = [];
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._temp = new THREE.Vector3();
    this._center = new THREE.Vector3();
    const count = Math.max(1, Math.round(spec.spawn.branches || 2));
    const verts = (this.segments + 1) * 2;
    for (let i = 0; i < count; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
      // A mapped material without UVs samples texel (0,0), which is black on
      // these bolt textures, so the strip would be invisible.
      const uvs = new Float32Array(verts * 2);
      for (let s = 0; s <= this.segments; s += 1) {
        const v = s / this.segments;
        uvs[s * 4] = 0;
        uvs[s * 4 + 1] = v;
        uvs[s * 4 + 2] = 1;
        uvs[s * 4 + 3] = v;
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      const index = [];
      for (let s = 0; s < this.segments; s += 1) {
        const a = s * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      geometry.setIndex(index);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: this.blending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      parent.add(mesh);
      this.bolts.push({ mesh, material, geometry, spin: (i / count) * Math.PI * 2, phase: Math.random() * 10 });
    }
  }

  _ensureTexture() {
    if (this.texPath) return;
    this.texPath = this.runtime.resolveTexturePath([this.spec.texture], null) || null;
    const texture = this.runtime.loadTexture(this.texPath);
    for (const bolt of this.bolts) bolt.material.map = texture;
  }

  // Ribbon plane must face the camera, otherwise the bolt vanishes edge-on.
  _rightVector(camera) {
    const dir = this._dir.normalize();
    this._up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.95) this._up.set(1, 0, 0);
    this._right.crossVectors(dir, this._up).normalize();
    if (camera && camera.position) {
      this._temp.copy(camera.position).sub(this._center).normalize();
      const side = this._up.crossVectors(dir, this._temp);
      if (side.lengthSq() > 1e-6) this._right.copy(side.normalize());
    }
    return this._right;
  }

  _build(t, width, length) {
    const camera = this.runtime.camera;
    const jitter = (this.spec.spawn.jitter || 0.2) * width;
    for (const bolt of this.bolts) {
      const pos = bolt.geometry.attributes.position;
      const angle = bolt.spin + t * 0.35;
      this._dir.set(Math.sin(angle) * 0.4, Math.cos(angle) * 0.4, -1).normalize();
      const right = this._rightVector(camera);
      for (let s = 0; s <= this.segments; s += 1) {
        const f = s / this.segments;
        // Independent per-node offsets, re-rolled on every rebuild: that is
        // what makes a bolt read as lightning instead of a smooth ribbon.
        const decay = 1 - f * 0.55;
        this._center.copy(this._dir).multiplyScalar(f * length);
        this._center.addScaledVector(right, (Math.random() - 0.5) * 2 * jitter * decay);
        this._center.y += (Math.random() - 0.5) * 2 * jitter * decay;
        const half = width * 0.5 * (1 - f * 0.6);
        pos.setXYZ(s * 2, this._center.x - right.x * half, this._center.y - right.y * half, this._center.z - right.z * half);
        pos.setXYZ(s * 2 + 1, this._center.x + right.x * half, this._center.y + right.y * half, this._center.z + right.z * half);
      }
      pos.needsUpdate = true;
    }
  }

  update(t, delta) {
    this._ensureTexture();
    const spec = this.spec;
    const scale = this.runtime.worldScale || 0.0254;
    const partTime = t - spec.delay;
    const active = partTime >= 0 && partTime < spec.life;
    // A 20 s primitive life with a 3 s cycle would keep the alpha ramp at its
    // dark start, so the curve can be mapped over the editorial window instead.
    const window = spec.spawn.curveWindow || spec.life;
    const progress = active ? clamp01(partTime / window) : 1;

    if (!active) {
      for (const bolt of this.bolts) bolt.mesh.visible = false;
      return;
    }

    const rawSize = evaluateQuadratic(spec.rqSize, progress, null);
    const width = (rawSize !== null && Math.abs(rawSize) > 1e-4 ? Math.abs(rawSize) : 20)
      * scale * (spec.spawn.widthScale ?? 0.4);
    const alpha = clamp01(evaluateQuadratic(spec.rqAlpha, progress, 1));
    const color = evaluateColorRamp(spec.colors, progress);
    const opacity = Math.min(1, alpha * (spec.spawn.opacity ?? 1));

    if (partTime - this.lastBuild > this.refresh) {
      this.lastBuild = partTime;
      this._build(partTime, width, spec.spawn.length * scale);
    }
    for (const bolt of this.bolts) {
      bolt.material.color.setRGB(color.r, color.g, color.b);
      bolt.material.opacity = opacity * (spec.spawn.opacity ?? 1);
      bolt.mesh.visible = opacity > 0.002;
    }
    void delta;
  }

  reset() {
    this.lastBuild = -Infinity;
    for (const bolt of this.bolts) bolt.mesh.visible = false;
  }

  dispose() {
    for (const bolt of this.bolts) {
      bolt.mesh.parent?.remove(bolt.mesh);
      bolt.geometry.dispose();
      bolt.material.dispose();
    }
    this.bolts = [];
  }
}

// A trail follows the anchor's real motion: the restored engine sampled the
// bone every frame and extruded a ribbon through the history. Width and
// brightness come from the authentic curves; the history window is authored
// because the engine's sample rate is not in the file.
class TrailPart {
  constructor(spec, runtime, parent) {
    const THREE = runtime.THREE;
    this.spec = spec;
    this.runtime = runtime;
    this.anchor = parent;
    this.blending = resolveBlendMode(spec.blendMode, THREE, spec.shaderName || null);
    this.texPath = null;
    this.maxPoints = Math.max(2, spec.spawn.samples || 48);
    this.history = Math.max(0.05, spec.spawn.history || 0.5);
    this.samples = [];
    this._anchorPos = new THREE.Vector3();
    this._cameraPos = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._toCamera = new THREE.Vector3();
    this._side = new THREE.Vector3();

    const verts = this.maxPoints * 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const uvs = new Float32Array(verts * 2);
    const index = [];
    for (let i = 0; i < this.maxPoints; i += 1) {
      const v = i / (this.maxPoints - 1);
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = v;
      if (i < this.maxPoints - 1) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: this.blending,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // World-space history needs a parent that does not move with the bone.
    (runtime.root || parent).add(this.mesh);
  }

  _ensureTexture() {
    if (this.texPath) return;
    this.texPath = this.runtime.resolveTexturePath([this.spec.texture], null) || null;
    this.mesh.material.map = this.runtime.loadTexture(this.texPath);
  }

  update(t, delta) {
    this._ensureTexture();
    const spec = this.spec;
    const scale = this.runtime.worldScale || 0.0254;
    const partTime = t - spec.delay;
    const active = partTime >= 0 && partTime < spec.life;

    if (!active) {
      this.mesh.visible = false;
      this.samples.length = 0;
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }

    const progress = clamp01(partTime / spec.life);
    const rawSize = evaluateQuadratic(spec.rqSize, progress, null);
    const width = (rawSize !== null && Math.abs(rawSize) > 1e-4 ? Math.abs(rawSize) : 7) * scale;
    const alpha = clamp01(evaluateQuadratic(spec.rqAlpha, progress, 1));
    const color = evaluateColorRamp(spec.colors, progress);

    // Sample the anchor in root space so the history stays world-fixed while
    // the bone keeps moving.
    const parent = this.mesh.parent;
    if (this.anchor.getWorldPosition) this.anchor.getWorldPosition(this._anchorPos);
    else this._anchorPos.copy(this.anchor.position);
    if (parent && parent.worldToLocal) parent.worldToLocal(this._anchorPos);
    this.samples.push({ x: this._anchorPos.x, y: this._anchorPos.y, z: this._anchorPos.z, t: partTime });
    while (this.samples.length && partTime - this.samples[0].t > this.history) this.samples.shift();
    while (this.samples.length > this.maxPoints) this.samples.shift();

    const camera = this.runtime.camera;
    if (camera && camera.position) this._cameraPos.copy(camera.position);
    else this._cameraPos.set(0, 0, 1);
    if (parent && parent.worldToLocal) parent.worldToLocal(this._cameraPos);

    const pos = this.mesh.geometry.attributes.position;
    const count = this.samples.length;
    for (let i = 0; i < count; i += 1) {
      const a = this.samples[Math.max(0, i - 1)];
      const b = this.samples[Math.min(count - 1, i + 1)];
      this._tangent.set(b.x - a.x, b.y - a.y, b.z - a.z);
      this._toCamera.set(this._cameraPos.x - this.samples[i].x, this._cameraPos.y - this.samples[i].y, this._cameraPos.z - this.samples[i].z);
      this._side.crossVectors(this._tangent, this._toCamera);
      if (this._side.lengthSq() < 1e-8) this._side.set(1, 0, 0);
      this._side.normalize();
      // Oldest end of the ribbon tapers to nothing, like a fading motion smear.
      const age = 1 - clamp01((partTime - this.samples[i].t) / this.history);
      const half = width * 0.5 * age;
      const s = this.samples[i];
      pos.setXYZ(i * 2, s.x - this._side.x * half, s.y - this._side.y * half, s.z - this._side.z * half);
      pos.setXYZ(i * 2 + 1, s.x + this._side.x * half, s.y + this._side.y * half, s.z + this._side.z * half);
    }
    pos.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
    this.mesh.material.color.setRGB(color.r, color.g, color.b);
    this.mesh.material.opacity = alpha * (spec.spawn.opacity ?? 1);
    this.mesh.visible = count > 1 && this.mesh.material.opacity > 0.002;
    void delta;
  }

  reset() {
    this.samples.length = 0;
    this.mesh.visible = false;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
  }
}

const PART_CLASSES = { glow: GlowPart, strand: StrandPart, bolt: BoltPart, trail: TrailPart };
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
