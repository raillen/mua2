const PAGE_SIZE = 100;
const PLAYBACK_NOTICE = 'Reprodução indisponível: emissor ainda não decodificado';
const STATUS_LABELS = { decoded: 'Decodificado', partial: 'Parcial', 'metadata-only': 'Metadados', error: 'Erro' };

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
  return `<span class="vfx-badge status-${effect.status}">${STATUS_LABELS[effect.status]}</span>`;
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
  // Soft sinusoidal envelope across lifetime to prevent sudden pop-in / pop-out
  const envelope = Math.sin(clamped * Math.PI);
  return { r, g, b, a: Math.min(1.0, Math.max(0.0, a * envelope)) };
}

export function resolveBlendMode(mode, THREE) {
  if (!THREE) return 0;
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
  let found = null;
  const targetLower = boneName.toLowerCase().replace(/[^a-z0-9]/g, '');
  model.traverse((obj) => {
    if (found || !obj.isBone) return;
    const nameLower = (obj.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nameLower === targetLower || nameLower.includes(targetLower)) {
      found = obj;
    }
  });
  return found;
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

    if (!this.THREE) return;

    const texPath = runtime.resolveTexturePath(primitive.shaderTextures, effectThumb);
    this.texture = runtime.loadTexture(texPath);
    this.blendMode = resolveBlendMode(primitive.blendMode, this.THREE);

    this._createMesh();
  }

  _createMesh() {
    const THREE = this.THREE;
    const p = this.primitive;
    const r = p.radius > 0 ? p.radius : 0.4;
    const r2 = p.radius2 > 0 ? p.radius2 : r;
    const h = p.height > 0 ? p.height : (r + r2);

    switch (p.typeName) {
      case 'FXPRIM_TYPE_SPRITE':
      case 'FXPRIM_TYPE_FLARE':
      case 'FXPRIM_TYPE_SCREEN_SPRITE': {
        const mat = new THREE.SpriteMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
        });
        this.mesh = new THREE.Sprite(mat);
        this.mesh.scale.set(r * 2, r * 2, 1);
        break;
      }

      case 'FXPRIM_TYPE_ORIENTED_SPRITE': {
        const geom = new THREE.PlaneGeometry(r * 2, h);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        const geom = new THREE.CylinderGeometry(r, r2, h, 16, 1, true);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
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
          const dist = Math.random() * r;
          const px = Math.cos(phi) * Math.cos(theta) * dist;
          const py = Math.sin(phi) * dist;
          const pz = Math.cos(phi) * Math.sin(theta) * dist;

          const speed = (0.5 + Math.random()) * Math.max(0.5, r * 2.0);
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
          size: Math.max(0.08, r * 0.4),
          map: this.texture,
          vertexColors: true,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          sizeAttenuation: true,
        });
        this.mesh = new THREE.Points(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_LINE':
      case 'FXPRIM_TYPE_LIGHTNING':
      case 'FXPRIM_TYPE_BEZIER': {
        const segCount = 10;
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(segCount * 3);
        const len = h > 0 ? h : Math.max(1.5, r * 3);

        for (let i = 0; i < segCount; i++) {
          positions[i * 3] = 0;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = (i / (segCount - 1)) * len;
        }
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          blending: this.blendMode,
          linewidth: 2,
        });
        this.mesh = new THREE.Line(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_LIGHT': {
        const color = parseHexColor(p.colors?.start1);
        const light = new THREE.PointLight(
          new THREE.Color(color.r, color.g, color.b),
          1.5,
          Math.max(2.5, r * 5)
        );
        this.mesh = light;
        break;
      }

      case 'FXPRIM_TYPE_HAVOKMODEL':
      case 'FXPRIM_TYPE_MODEL':
      case 'FXPRIM_TYPE_ENTITY':
      case 'FXPRIM_TYPE_SCREENFLASH':
      default: {
        const geom = new THREE.RingGeometry(Math.max(0.05, r * 0.2), r, 24);
        const mat = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          blending: this.blendMode,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geom, mat);
        this.mesh.rotation.x = -Math.PI / 2;
        break;
      }
    }

    if (this.mesh) {
      this.mesh.visible = false;
      this.runtime.root.add(this.mesh);
    }
  }

  update(cycleTime, delta) {
    if (!this.mesh) return;

    const localTime = cycleTime - this.delay;
    if (localTime < 0 || localTime > this.life) {
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    const progress = Math.max(0, Math.min(1, localTime / this.life));
    const color = evaluateColorRamp(this.primitive.colors, progress);
    const scroll = this.primitive.scrollVelocity || [0, 0, 0];

    // Texture UV scrolling
    if (this.mesh.material && this.mesh.material.map && (scroll[0] !== 0 || scroll[1] !== 0)) {
      this.mesh.material.map.offset.x = (this.mesh.material.map.offset.x + scroll[0] * delta) % 1.0;
      this.mesh.material.map.offset.y = (this.mesh.material.map.offset.y + scroll[1] * delta) % 1.0;
    }

    const p = this.primitive;
    const r = p.radius > 0 ? p.radius : 0.4;
    const r2 = p.radius2 > 0 ? p.radius2 : r * 1.5;

    switch (p.typeName) {
      case 'FXPRIM_TYPE_SPRITE':
      case 'FXPRIM_TYPE_FLARE':
      case 'FXPRIM_TYPE_SCREEN_SPRITE': {
        const curR = lerp(r, r2, progress);
        this.mesh.scale.set(curR * 2, curR * 2, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = color.a;
        break;
      }

      case 'FXPRIM_TYPE_ORIENTED_SPRITE': {
        const curR = lerp(r, r2, progress);
        const h = p.height > 0 ? p.height : curR * 2;
        this.mesh.scale.set(curR * 2, h, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = color.a;
        if (scroll[2]) this.mesh.rotation.z += scroll[2] * delta;
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        const scale = 1.0 + progress * 0.2;
        this.mesh.scale.set(scale, 1.0, scale);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = color.a;
        break;
      }

      case 'FXPRIM_TYPE_PARTICLE_CLOUD':
      case 'FXPRIM_TYPE_SPARK':
      case 'FXPRIM_TYPE_WEATHERFX': {
        if (!this.particles) break;
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
        this.mesh.material.opacity = color.a;
        break;
      }

      case 'FXPRIM_TYPE_LINE':
      case 'FXPRIM_TYPE_LIGHTNING':
      case 'FXPRIM_TYPE_BEZIER': {
        const posAttr = this.mesh.geometry.attributes.position;
        const positions = posAttr.array;
        const segCount = positions.length / 3;
        const isLightning = p.typeName === 'FXPRIM_TYPE_LIGHTNING';

        for (let i = 1; i < segCount - 1; i++) {
          if (isLightning) {
            positions[i * 3] = (Math.random() - 0.5) * 0.2 * r;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 0.2 * r;
          }
        }
        posAttr.needsUpdate = true;
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = color.a;
        break;
      }

      case 'FXPRIM_TYPE_LIGHT': {
        this.mesh.color.setRGB(color.r, color.g, color.b);
        this.mesh.intensity = color.a * 2.0;
        break;
      }

      case 'FXPRIM_TYPE_HAVOKMODEL':
      case 'FXPRIM_TYPE_MODEL':
      case 'FXPRIM_TYPE_ENTITY':
      case 'FXPRIM_TYPE_SCREENFLASH':
      default: {
        const curScale = 1.0 + progress * 2.5;
        this.mesh.scale.set(curScale, curScale, curScale);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = color.a * (1.0 - progress);
        break;
      }
    }
  }

  reset() {
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

  dispose() {
    if (this.mesh) {
      if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach((m) => m.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
      this.mesh = null;
    }
    this.particles = null;
  }
}

// ========================================================
// VFX WEBGL RUNTIME ENGINE
// ========================================================

export class VfxRuntime {
  constructor({ scene = null, camera = null, renderer = null, getModel = () => null, THREE = null } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
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
    this.isPlaying = false;
    this.isLooping = true;
    this.speed = 1.0;
    this.elapsed = 0.0;
    this.loopTime = 1.0;

    this.attachmentSlot = 'Origem';
    this.attachmentBoneName = null;
    this.isGroundTarget = false;
    this.attachmentBone = null;

    this.textureLoader = this.THREE ? new this.THREE.TextureLoader() : null;
    this.textureCache = new Map();
    this.textureMap = null;
    this.fallbackTexture = null;

    this._tempPos = this.THREE ? new this.THREE.Vector3() : null;
    this._tempQuat = this.THREE ? new this.THREE.Quaternion() : null;

    this._loadTextureMap();
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

  setEffect(effect) {
    this.stop();
    this.activeEffect = effect;
    if (!effect || !effect.definition) return;

    const tmpl = effect.definition.templates?.[0];
    const prims = Array.isArray(effect.definition.primitives) ? effect.definition.primitives : [];
    this.primitives = prims;

    let loopTime = tmpl && typeof tmpl.loopTime === 'number' && tmpl.loopTime > 0 ? tmpl.loopTime : 0;
    if (loopTime <= 0) {
      loopTime = prims.reduce((max, p) => Math.max(max, (p.delay || 0) + (p.life || 1.0)), 1.0);
    }
    this.loopTime = Math.max(0.2, loopTime);
    this.isLooping = tmpl ? tmpl.persistLoop !== 0 : true;

    // Resolve attachment target
    const target = resolveAttachmentTarget(effect.id, effect.textures);
    this.attachmentSlot = target.slot;
    this.attachmentBoneName = target.boneName;
    this.isGroundTarget = !!target.isGround;
    this.rebindAttachment();

    // Instantiate primitive runners
    if (this.root && this.THREE) {
      for (const p of prims) {
        const runner = new VfxPrimitiveRunner(p, this, effect.thumb);
        this.runners.push(runner);
      }
    }

    this.elapsed = 0.0;
    this.isPlaying = prims.length > 0;
  }

  rebindAttachment() {
    this.attachmentBone = null;
    const model = this.getModel();
    if (!model) return;

    if (this.attachmentBoneName) {
      this.attachmentBone = findBoneInModel(model, this.attachmentBoneName);
    }
    if (!this.attachmentBone && !this.isGroundTarget) {
      this.attachmentBone = findBoneInModel(model, 'Bip01 Spine') || findBoneInModel(model, 'Bip01 Pelvis');
    }
  }

  onModelChange(newModel) {
    this.rebindAttachment();
  }

  update(delta) {
    if (!this.isPlaying || !this.root || !this.THREE) return;

    // Update root anchor transform
    const model = this.getModel();
    if (this.attachmentBone) {
      this.attachmentBone.getWorldPosition(this._tempPos);
      this.attachmentBone.getWorldQuaternion(this._tempQuat);
      this.root.position.copy(this._tempPos);
      this.root.quaternion.copy(this._tempQuat);
    } else if (model) {
      model.getWorldPosition(this._tempPos);
      if (this.isGroundTarget) {
        this.root.position.set(this._tempPos.x, 0.02, this._tempPos.z);
      } else {
        this.root.position.set(this._tempPos.x, this._tempPos.y + 1.0, this._tempPos.z);
      }
      this.root.quaternion.identity();
    } else {
      this.root.position.set(0, this.isGroundTarget ? 0.02 : 1.0, 0);
      this.root.quaternion.identity();
    }

    // Step cycle
    this.elapsed += delta * this.speed;
    if (this.elapsed >= this.loopTime) {
      if (this.isLooping) {
        this.elapsed = this.elapsed % this.loopTime;
        for (const runner of this.runners) {
          runner.reset();
        }
      } else {
        this.elapsed = this.loopTime;
        this.isPlaying = false;
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
      if (this.elapsed >= this.loopTime) {
        this.elapsed = 0.0;
        for (const runner of this.runners) runner.reset();
      }
    }
  }

  pause() {
    this.isPlaying = false;
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
    return this.isPlaying;
  }

  replay() {
    this.elapsed = 0.0;
    this.isPlaying = true;
    for (const runner of this.runners) {
      runner.reset();
    }
  }

  stop() {
    this.isPlaying = false;
    this.elapsed = 0.0;
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

    this.runtime = new VfxRuntime({ scene, camera, renderer, getModel, THREE });
  }

  init() {
    const get = (id) => document.getElementById(id);
    this.modal = get('vfx-modal');
    this.surfaces = {
      sidebar: { search: get('vfx-search'), clear: get('btn-clear-vfx-search'), category: get('vfx-category-select'), character: get('vfx-character-select'), list: get('vfx-sidebar-list'), pages: get('vfx-sidebar-pages'), count: get('vfx-results'), detail: get('vfx-sidebar-detail'), page: 0 },
      modal: { search: get('vfx-modal-search'), clear: get('btn-clear-vfx-modal-search'), category: get('vfx-modal-category-select'), character: get('vfx-modal-character-select'), list: get('vfx-grid'), pages: get('vfx-modal-pages'), count: get('vfx-modal-stats'), detail: get('vfx-detail'), page: 0 },
    };
    for (const [name, surface] of Object.entries(this.surfaces)) {
      for (const control of [surface.search, surface.category, surface.character]) {
        control.addEventListener(control === surface.search ? 'input' : 'change', () => {
          surface.page = 0;
          this.render(name);
        });
      }
      surface.clear.addEventListener('click', () => {
        surface.search.value = '';
        surface.page = 0;
        this.render(name);
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
    this.loadCatalog();
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
          surface.page = 0;
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
        for (const id of ['vfx-catalog-count', 'nav-vfx-count']) {
          document.getElementById(id).textContent = effects.length.toLocaleString('pt-BR');
        }
        this.render('sidebar');
        this.render('modal');
        this.renderDetails();
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
    const filtered = this.effects.filter((effect) => matches(effect, query, surface.category.value, surface.character.value));
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
      button.innerHTML = name === 'sidebar' && this.viewMode === 'list'
        ? `<span class="vfx-list-name">${title}</span>${badge(effect)}`
        : `<div class="vfx-card-thumb-wrap">${preview}</div><div class="vfx-card-info vfx-card-body"><span class="vfx-card-name">${title}</span><span class="vfx-card-sub">${escapeHtml(effect.path)}</span><span class="vfx-card-meta">${badge(effect)}<span class="vfx-meta-tag">${effect.textures.length} texturas</span></span></div>`;
      button.addEventListener('click', () => this.selectEffect(effect));
      fragment.append(button);
    }
    surface.list.append(fragment);
    if (!batch.length) surface.list.textContent = 'Nenhum efeito corresponde aos filtros.';
    surface.pages.replaceChildren();
    surface.pages.hidden = lastPage === 0;
    for (const [label, delta] of [['Anterior', -1], ['Próximos 100', 1]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vfx-load-more-btn';
      button.textContent = label;
      button.disabled = delta < 0 ? surface.page === 0 : surface.page === lastPage;
      button.addEventListener('click', () => {
        surface.page += delta;
        this.render(name);
        const scroller = name === 'sidebar' ? surface.list.parentElement : surface.list;
        scroller.scrollTop = 0;
        surface.list.querySelector('button')?.focus();
      });
      surface.pages.append(button);
    }
    this.refreshIcons();
  }

  selectEffect(effect) {
    this.selectedEffect = effect;
    for (const surface of Object.values(this.surfaces)) {
      for (const button of surface.list.querySelectorAll('button[data-id]')) {
        const active = button.dataset.id === effect.id;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
    this.runtime.setEffect(effect);
    this.renderDetails();
  }

  renderDetails() {
    const effect = this.selectedEffect;
    for (const [name, surface] of Object.entries(this.surfaces)) {
      surface.detail.hidden = name === 'sidebar' && !effect;
      if (!effect) {
        surface.detail.textContent = 'Selecione um efeito para ver os detalhes.';
        continue;
      }
      const title = escapeHtml(effect.name.replace(/_/g, ' '));
      const prims = effect.definition?.primitives || [];
      const hasPrimitives = prims.length > 0;
      const tmpl = effect.definition?.templates?.[0];
      const dur = this.runtime.loopTime || tmpl?.loopTime || 1.0;

      let statusMarkup = '';
      if (hasPrimitives) {
        statusMarkup = `
          <div class="vfx-player-box">
            <div class="vfx-decoded-banner">
              <i data-lucide="sparkles"></i>
              <span><strong>Emissor WebGL Ativo</strong> · ${prims.length} primitivas · ${dur.toFixed(1)}s</span>
            </div>
            <div class="vfx-player-toolbar">
              <button type="button" class="vfx-player-btn vfx-btn-play ${this.runtime.isPlaying ? 'active' : ''}" title="Pausar / Reproduzir">
                <i data-lucide="${this.runtime.isPlaying ? 'pause' : 'play'}"></i>
                <span>${this.runtime.isPlaying ? 'Pausar' : 'Reproduzir'}</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-replay" title="Reiniciar do início">
                <i data-lucide="rotate-ccw"></i>
                <span>Reiniciar</span>
              </button>
              <button type="button" class="vfx-player-btn vfx-btn-loop ${this.runtime.isLooping ? 'active' : ''}" title="Alternar repetição contínua">
                <i data-lucide="repeat"></i>
                <span>Loop</span>
              </button>
              <select class="vfx-player-speed" title="Velocidade de reprodução">
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
        <h3 class="vfx-selection-title">${title}</h3>
        <div class="effect-path">${escapeHtml(effect.path)}</div>
        <div class="vfx-selection-meta-row">
          ${badge(effect)}
          <span class="vfx-meta-tag">${escapeHtml(effect.category)}</span>
          ${hasPrimitives ? `<span class="vfx-meta-tag">${prims.length} prims</span>` : ''}
        </div>
        ${statusMarkup}
      `;

      // Wire playback controls
      if (hasPrimitives) {
        const playBtn = surface.detail.querySelector('.vfx-btn-play');
        const replayBtn = surface.detail.querySelector('.vfx-btn-replay');
        const loopBtn = surface.detail.querySelector('.vfx-btn-loop');
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
        });

        speedSel?.addEventListener('change', (e) => {
          this.runtime.setSpeed(e.target.value);
        });
      }

      // Character association & binding button
      const model = this.models.find((model) => effect.modelIds.includes(model.id));
      if (effect.character) {
        const association = document.createElement('p');
        association.className = 'vfx-char-note';
        association.textContent = `Personagem: ${effect.character}${model ? '' : ' · sem modelo correspondente'}`;
        surface.detail.append(association);
      }
      if (model) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vfx-char-btn';
        button.innerHTML = `<i data-lucide="user-check"></i><span>Carregar ${escapeHtml(model.name)} e vincular VFX</span>`;
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = `Carregando ${model.name}…`;
          try {
            await this.loadModel(model);
            this.runtime.onModelChange(this.runtime.getModel());
            if (this.selectedEffect === effect) this.selectEffect(effect);
            if (name === 'modal') this.closeModal(this.modal);
          } catch (error) {
            console.error('[VFX] Falha ao carregar personagem:', error);
            button.textContent = 'Falha ao carregar. Tentar novamente';
          } finally {
            button.disabled = false;
          }
        });
        surface.detail.append(button);
      }

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
        close.textContent = 'Fechar detalhes';
        close.addEventListener('click', () => {
          this.runtime.stop();
          this.selectedEffect = null;
          this.renderDetails();
          this.render('sidebar');
          this.render('modal');
          surface.list.querySelector('button')?.focus();
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

  onModelChange(model) {
    this.runtime.onModelChange(model);
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

  return 'VFX catalog self-check passed';
}
