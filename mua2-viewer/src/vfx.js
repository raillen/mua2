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
    this.soundPlayed = false;
    this.shakeTriggered = false;
    this.ownedTexture = null;
    this.disposed = false;
    this.ownedGeometries = [];
    this.ownedMaterials = [];

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
        this.ownedMaterials.push(mat);
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
        this.ownedGeometries.push(geom);
        this.ownedMaterials.push(mat);
        this.mesh = new THREE.Mesh(geom, mat);
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        const geom = new THREE.CylinderGeometry(r, r2, h, 24, 1, true);
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
          Math.max(2.5, r * 5)
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
      this.runtime.root.add(this.mesh);
    }
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
    const curSize = evaluateQuadratic(p.rqSize, progress, null);
    const curLen = evaluateQuadratic(p.rqLength, progress, null);

    // Texture UV scrolling
    if (this.ownedTexture?.offset && (scroll[0] !== 0 || scroll[1] !== 0)) {
      this.ownedTexture.offset.x = (this.ownedTexture.offset.x + scroll[0] * delta) % 1.0;
      this.ownedTexture.offset.y = (this.ownedTexture.offset.y + scroll[1] * delta) % 1.0;
    }

    const r = p.radius > 0 ? p.radius : 0.4;
    const r2 = p.radius2 > 0 ? p.radius2 : r * 1.5;
    const h = p.height > 0 ? p.height : (r + r2);

    switch (p.typeName) {
      case 'FXPRIM_TYPE_SPRITE':
      case 'FXPRIM_TYPE_FLARE':
      case 'FXPRIM_TYPE_SCREEN_SPRITE': {
        const curR = (curSize !== null && curSize > 0) ? curSize : lerp(r, r2, progress);
        this.mesh.scale.set(curR * 2, curR * 2, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_ORIENTED_SPRITE': {
        const curR = (curSize !== null && curSize > 0) ? curSize : lerp(r, r2, progress);
        const curH = (curLen !== null && curLen > 0) ? curLen : (p.height > 0 ? p.height : curR * 2);
        this.mesh.scale.set(curR * 2, curH, 1);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        if (scroll[2]) this.mesh.rotation.z += scroll[2] * delta;
        break;
      }

      case 'FXPRIM_TYPE_CYLINDER': {
        const radiusScale = (curSize !== null && r > 0) ? (curSize / r) : (1.0 + progress * 0.2);
        const heightScale = (curLen !== null && h > 0) ? (curLen / h) : 1.0;
        this.mesh.scale.set(radiusScale, heightScale, radiusScale);
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
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

        for (let i = 1; i < segCount - 1; i++) {
          if (isLightning) {
            positions[i * 3] = (Math.random() - 0.5) * 0.2 * r;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 0.2 * r;
          }
        }
        posAttr.needsUpdate = true;
        this.mesh.material.color.setRGB(color.r, color.g, color.b);
        this.mesh.material.opacity = curAlpha;
        break;
      }

      case 'FXPRIM_TYPE_LIGHT': {
        this.mesh.color.setRGB(color.r, color.g, color.b);
        this.mesh.intensity = curAlpha * 2.0;
        break;
      }

      case 'FXPRIM_TYPE_HAVOKMODEL':
      case 'FXPRIM_TYPE_MODEL': {
        const curScale = (curSize !== null && curSize > 0) ? curSize : (1.0 + progress * 0.5);
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

      case 'FXPRIM_TYPE_ENTITY':
      case 'FXPRIM_TYPE_SCREENFLASH':
      default: {
        const curScale = (curSize !== null && curSize > 0) ? curSize : (1.0 + progress * 2.5);
        this.mesh.scale.set(curScale, curScale, curScale);
        if (this.mesh.material) {
          this.mesh.material.color.setRGB(color.r, color.g, color.b);
          this.mesh.material.opacity = curAlpha * (1.0 - progress);
        }
        break;
      }
    }
  }

  reset() {
    this.soundPlayed = false;
    this.shakeTriggered = false;
    if (this.ownedTexture?.offset) {
      this.ownedTexture.offset.set(0, 0);
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
    this.isPlaying = false;
    this.isLooping = true;
    this.speed = 1.0;
    this.elapsed = 0.0;
    this.loopTime = 1.0;

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
    this.isGroundTarget = false;
    this.attachmentBone = null;

    this.textureLoader = (this.THREE && typeof this.THREE.TextureLoader === 'function') ? new this.THREE.TextureLoader() : null;
    this.textureCache = new Map();
    this.textureMap = null;
    this.fallbackTexture = null;

    this._tempPos = (this.THREE && typeof this.THREE.Vector3 === 'function') ? new this.THREE.Vector3() : null;
    this._tempQuat = (this.THREE && typeof this.THREE.Quaternion === 'function') ? new this.THREE.Quaternion() : null;

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
    if (this.modelMap) {
      if (this.modelMap[clean]) return this.modelMap[clean];
      const lower = clean.toLowerCase();
      if (this.modelMap[lower]) return this.modelMap[lower];
      const base = lower.split('/').pop();
      if (this.modelMap[base]) return this.modelMap[base];
      const noExt = base.replace(/\.[^.]+$/, '');
      if (this.modelMap[noExt]) return this.modelMap[noExt];
    }
    if (clean.endsWith('.glb')) return clean;
    const asGlb = clean.replace(/\.(?:igb|igz)$/i, '.glb');
    return `assets/vfx/models/${asGlb}`;
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
    if (model && typeof model.updateWorldMatrix === 'function') {
      model.updateWorldMatrix(true, false);
    }
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

    // Step cycle: check animation synchronization
    let action = null;
    if (this.syncAnimation && typeof this.getCurrentAction === 'function') {
      action = this.getCurrentAction();
    }
    const isAnimActive = action && typeof this.getAnimPlaying === 'function' && this.getAnimPlaying() && action.getClip();

    if (isAnimActive) {
      const actTime = action.time >= 0 ? action.time : 0.0;
      if (this.isLooping) {
        const nextElapsed = actTime % this.loopTime;
        if (this.lastSyncTime !== null && (actTime < this.lastSyncTime || nextElapsed < this.elapsed)) {
          for (const runner of this.runners) {
            runner.reset();
          }
        }
        this.lastSyncTime = actTime;
        this.elapsed = nextElapsed;
      } else {
        if (actTime >= this.loopTime || (this.lastSyncTime !== null && actTime < this.lastSyncTime)) {
          this.elapsed = this.loopTime;
          this.isPlaying = false;
          this.lastSyncTime = null;
          this.restoreCamera();
          this.shakeDuration = 0;
          if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
          for (const audio of this.activeAudio) {
            try { audio.pause(); } catch {}
          }
          this.activeAudio = [];
          for (const runner of this.runners) {
            if (runner.mesh) runner.mesh.visible = false;
          }
          return;
        }
        this.lastSyncTime = actTime;
        this.elapsed = actTime;
      }
    } else {
      this.lastSyncTime = null;
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
          this.restoreCamera();
          this.shakeDuration = 0;
          if (this.shakeOffset) this.shakeOffset.set(0, 0, 0);
          for (const audio of this.activeAudio) {
            try { audio.pause(); } catch {}
          }
          this.activeAudio = [];
          for (const runner of this.runners) {
            if (runner.mesh) runner.mesh.visible = false;
          }
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
      if (this.elapsed >= this.loopTime) {
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
    this.isPlaying = true;
    for (const runner of this.runners) {
      runner.reset();
    }
  }

  stop() {
    this.isPlaying = false;
    this.elapsed = 0.0;
    this.lastSyncTime = null;
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

    this.runtime = new VfxRuntime({
      scene,
      camera,
      renderer,
      controls,
      gltfLoader,
      getMixer,
      getCurrentAction,
      getAnimPlaying,
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
    this.loadCatalog();
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
      this.selectedEffect = effect;
      this.runtime.setEffect(effect);
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
    for (const surface of Object.values(this.surfaces)) {
      for (const button of surface.list.querySelectorAll('button[data-id]')) {
        const active = button.dataset.id === effect?.id;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
    this.runtime.setEffect(effect);
    this.renderDetails();
    if (name) {
      this.renderNavigation(name);
      this.focusSurface(name);
    }
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
              this.runtime.onModelChange(this.runtime.getModel());
              this.populateModelFilters();
              this.renderDetails();
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
    this.runtime.onModelChange(model);
    const entry = model?.userData?.catalogEntry || model?.userData?.entry
      || this.models.find((m) => m.id === model?.userData?.id || m.id === model?.name);
    if (entry) {
      this.loadedModel = entry;
    } else if (!model) {
      this.loadedModel = null;
    }
    this.populateModelFilters();
    for (const surface of Object.values(this.surfaces)) {
      if (surface?.model?.value === 'loaded') {
        surface.page = 0;
        this.render('sidebar');
        this.render('modal');
      }
    }
    this.renderDetails();
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
  const expectedOpacity = Math.sin(0.2 * Math.PI);
  check(
    Math.abs(mockMultiMatObj.material[0].opacity - expectedOpacity) < 0.01 &&
    Math.abs(mockMultiMatObj.material[1].opacity - expectedOpacity) < 0.01,
    'Multi-material meshes must update opacity across array using sinusoidal envelope'
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
  glbRuntime.loadVfxModel('test_model.glb', (s) => { scene1 = s; });
  check(gltfLoadCount === 1 && scene1?.isClone === true, 'First load must query gltfLoader');
  glbRuntime.loadVfxModel('test_model.glb', (s) => { scene2 = s; });
  check(gltfLoadCount === 1 && scene2?.isClone === true && scene1 !== scene2, 'Second load must use cached model and return new clone');

  // Engine extensions: Model resolution
  runtime.modelMap = { 'models/effects/shield.igb': 'assets/vfx/models/effects/shield.glb' };
  check(runtime.resolveModelPath('models/effects/shield.igb') === 'assets/vfx/models/effects/shield.glb', 'resolveModelPath must resolve mapped model');
  check(runtime.resolveModelPath('effects/bubble.igb') === 'assets/vfx/models/effects/bubble.glb', 'resolveModelPath must format fallback .glb');

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
