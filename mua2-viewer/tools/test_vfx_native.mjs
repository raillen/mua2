// Checks the native recreations against the decoded catalog: every authentic
// field in a preset must equal the primitive it claims to come from, and every
// texture must resolve to an extracted PNG on disk.
//
// Run: node mua2-viewer/tools/test_vfx_native.mjs
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_PRESETS } from '../src/vfx-native.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const catalog = JSON.parse(gunzipSync(readFileSync(join(root, 'assets/vfx/effects.json.gz'))).toString('utf8')).effects;
const textureMap = JSON.parse(readFileSync(join(root, 'assets/vfx/texture_map.json'), 'utf8'));

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

const byPath = new Map(catalog.map((effect) => [effect.path, effect]));
const fields = ['life', 'delay', 'gravity', 'blendMode'];

for (const [effectId, preset] of Object.entries(NATIVE_PRESETS)) {
  const effect = byPath.get(effectId);
  check(Boolean(effect), `${effectId}: not in assets/vfx/effects.json.gz`);
  check(preset.parts.length > 0, `${effectId}: preset has no parts`);

  for (const part of preset.parts) {
    const label = `${effectId}#prim${part.prim}`;
    const prim = effect.definition.primitives[part.prim];
    check(Boolean(prim), `${label}: primitive missing from the decoded definition`);

    for (const field of fields) {
      check(part[field] === prim[field], `${label}: ${field} ${part[field]} != decoded ${prim[field]}`);
    }
    for (const curve of ['rqSize', 'rqAlpha', 'rqLength']) {
      check(
        JSON.stringify(part[curve]) === JSON.stringify(prim[curve]),
        `${label}: ${curve} differs from the decoded curve`,
      );
    }
    for (const stop of ['start1', 'mid1', 'end1']) {
      check(part.colors[stop] === prim.colors[stop], `${label}: colour ${stop} differs from decoded`);
    }
    check(
      prim.shaderTextures.includes(part.texture),
      `${label}: ${part.texture} is not one of the decoded shader textures`,
    );
    check(Object.hasOwn(part, 'spawn'), `${label}: authored emission block missing`);

    const base = part.texture.split('/').pop();
    const assetPath = textureMap[base];
    check(Boolean(assetPath), `${label}: ${part.texture} has no extracted texture`);
    check(existsSync(join(root, assetPath)), `${label}: ${assetPath} missing on disk`);
  }
}

const ids = Object.keys(NATIVE_PRESETS);
check(ids.length >= 5, 'expected at least five native recreations');

// ---- Simulation smoke check ------------------------------------------------
// Builds a real effect against vendored three.js with a stub texture loader and
// steps the timeline. This proves the emitters actually animate: particles move,
// reach visible opacity, and stop when the authentic life window closes.
const THREE = await import('../vendor/three.module.js');
const { createNativeEffect } = await import('../src/vfx-native.js');

function simulate(effectId, seconds) {
  const root = new THREE.Group();
  const runtime = {
    THREE,
    root,
    worldScale: 0.0254,
    resolveTexturePath: () => null,
    loadTexture: () => new THREE.Texture(),
  };
  const effect = createNativeEffect({ id: effectId }, runtime);
  check(Boolean(effect), `${effectId}: createNativeEffect returned null`);
  // A trail only exists if the anchor moves, exactly like the in-game bone.
  const group = root.children.find((child) => child.name === `NativeEffect:${effectId}`);
  const samples = [];
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) {
    if (group) {
      group.position.set(Math.sin(t * 9) * 0.45, Math.cos(t * 7) * 0.2, 0);
      group.updateMatrixWorld(true);
    }
    effect.update(t, step);
    let visible = 0;
    let moved = 0;
    let maxOpacity = 0;
    root.traverse((node) => {
      if (!node.visible || node.type === 'Group') return;
      if (node.isSprite) {
        visible += 1;
        maxOpacity = Math.max(maxOpacity, node.material.opacity);
        const p = node.position;
        moved = Math.max(moved, Math.hypot(p.x, p.y, p.z));
      } else if (node.isMesh && node.material.opacity > 0.002) {
        visible += 1;
        maxOpacity = Math.max(maxOpacity, node.material.opacity);
        moved = Math.max(moved, node.scale.y);
      }
    });
    samples.push({ visible, moved, maxOpacity });
  }
  effect.dispose();
  return samples;
}

for (const [effectId, preset] of Object.entries(NATIVE_PRESETS)) {
  const samples = simulate(effectId, preset.duration + 0.25);
  check(samples.some((s) => s.visible > 0), `${effectId}: nothing ever became visible`);
  check(samples.some((s) => s.maxOpacity > 0.05), `${effectId}: never reached visible opacity`);
  check(samples.some((s) => s.moved > 0.001), `${effectId}: geometry never moved`);
  // After the decoded life window the field must be dark again. A looping
  // preset (a sustained beam) never goes dark by design.
  if (!preset.loop) {
    const tail = samples.slice(-6);
    check(tail.every((s) => s.visible === 0), `${effectId}: stayed visible past its decoded life`);
  }
}

console.log(`VFX native self-check passed (${ids.length} powers simulated, ${checks} assertions)`);
