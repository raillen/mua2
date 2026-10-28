/**
 * Model download packaging for the MUA2 viewer.
 *
 * Builds a ZIP in the browser containing the original glTF model (with game
 * animations embedded when available), every embedded texture extracted as a
 * standalone image, and the raw decoded Havok clip data.
 */

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const time = ((date.getHours() & 31) << 11)
    | ((date.getMinutes() & 63) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9)
    | (((date.getMonth() + 1) & 15) << 5)
    | (date.getDate() & 31);
  return { time, day };
}

/**
 * Minimal ZIP writer (store method). Enough for a handful of files without
 * pulling an external dependency into the static viewer.
 * @param {{name: string, data: Uint8Array|ArrayBuffer}[]} entries
 * @returns {Blob}
 */
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const { time, day } = dosTimestamp();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array
      ? entry.data
      : new Uint8Array(entry.data);
    const checksum = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);

    localParts.push(local, data);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

/**
 * Read a binary glTF container into its JSON document and BIN payload.
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function parseGlb(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('Arquivo GLB inválido.');
  }

  const total = view.getUint32(8, true);
  let offset = 12;
  let json = null;
  let bin = new Uint8Array(0);

  while (offset + 8 <= total) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkType === GLB_JSON_CHUNK) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + chunkLength)));
    } else if (chunkType === GLB_BIN_CHUNK) {
      bin = bytes.slice(start, start + chunkLength);
    }
    offset = start + chunkLength;
  }

  if (!json) throw new Error('GLB sem chunk JSON.');
  return { json, bin };
}

function encodeGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const binPadding = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPadding + 8 + bin.length + binPadding;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  let offset = 12;
  view.setUint32(offset, jsonBytes.length + jsonPadding, true);
  view.setUint32(offset + 4, GLB_JSON_CHUNK, true);
  offset += 8;
  out.set(jsonBytes, offset);
  offset += jsonBytes.length;
  out.fill(0x20, offset, offset + jsonPadding);
  offset += jsonPadding;

  view.setUint32(offset, bin.length + binPadding, true);
  view.setUint32(offset + 4, GLB_BIN_CHUNK, true);
  offset += 8;
  out.set(bin, offset);
  offset += bin.length;
  out.fill(0, offset, offset + binPadding);

  return out;
}

function safeName(value, fallback = 'asset') {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_\-.]+|[_\-.]+$/g, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function extensionForImage(mimeType, bytes) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/ktx2') return '.ktx2';
  if (bytes && bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return '.webp';
  }
  return '.bin';
}

/**
 * Pull every image embedded in the GLB out as a standalone file and describe
 * which material slot uses it.
 */
export function extractTextures(gltf, bin) {
  const images = Array.isArray(gltf.images) ? gltf.images : [];
  const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const bufferViews = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : [];

  const slotByImage = new Map();
  const register = (ref, slot, materialName) => {
    if (!ref || !Number.isInteger(ref.index)) return;
    const texture = textures[ref.index];
    const imageIndex = texture?.source;
    if (!Number.isInteger(imageIndex) || slotByImage.has(imageIndex)) return;
    slotByImage.set(imageIndex, { slot, material: materialName });
  };

  materials.forEach((material, materialIndex) => {
    const materialName = safeName(material?.name, `material_${materialIndex}`);
    const pbr = material?.pbrMetallicRoughness || {};
    register(pbr.baseColorTexture, 'diffuse', materialName);
    register(material?.normalTexture, 'normal', materialName);
    register(material?.occlusionTexture, 'occlusion', materialName);
    register(material?.emissiveTexture, 'emissive', materialName);
    register(pbr.metallicRoughnessTexture, 'metallic_roughness', materialName);
  });

  const files = [];
  const entries = [];
  const usedNames = new Set();

  images.forEach((image, index) => {
    const viewIndex = image?.bufferView;
    if (!Number.isInteger(viewIndex)) return;
    const view = bufferViews[viewIndex];
    if (!view) return;

    const start = view.byteOffset || 0;
    const bytes = bin.slice(start, start + view.byteLength);
    const mapping = slotByImage.get(index);
    const base = mapping ? `${mapping.material}_${mapping.slot}` : `texture_${index + 1}`;
    const extension = extensionForImage(image.mimeType, bytes);
    let fileName = `${safeName(base)}${extension}`;
    let suffix = 2;
    while (usedNames.has(fileName)) {
      fileName = `${safeName(base)}_${suffix}${extension}`;
      suffix += 1;
    }
    usedNames.add(fileName);

    files.push({ name: `textures/${fileName}`, data: bytes });
    entries.push({
      image: index,
      file: fileName,
      mimeType: image.mimeType || 'application/octet-stream',
      material: mapping?.material || null,
      slot: mapping?.slot || null,
      bytes: bytes.length,
    });
  });

  return { files, entries };
}

function floatAccessor(values, type, count, withBounds = false) {
  const array = Float32Array.from(values);
  const accessor = { componentType: 5126, count, type };
  if (withBounds) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < array.length; i += 1) {
      const value = array[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    accessor.min = [min];
    accessor.max = [max];
  }
  return { array, accessor };
}

/**
 * Embed the decoded animation clips into a copy of the model GLB.
 * @returns {Uint8Array|null} null when no track matches the model skeleton.
 */
export function buildAnimatedGlb(parsed, animationData) {
  const gltf = parsed.json;
  const clips = Array.isArray(animationData?.clips) ? animationData.clips : [];
  if (!clips.length || !Array.isArray(gltf.nodes) || !gltf.buffers?.[0]) return null;

  const nodeByName = new Map();
  gltf.nodes.forEach((node, index) => {
    if (node?.name && !nodeByName.has(node.name)) nodeByName.set(node.name, index);
  });

  const baseLength = Number.isFinite(gltf.buffers[0].byteLength)
    ? gltf.buffers[0].byteLength
    : parsed.bin.length;
  const parts = [parsed.bin.slice(0, baseLength)];
  let binLength = baseLength;

  const bufferViews = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : (gltf.bufferViews = []);
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : (gltf.accessors = []);
  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];

  const appendBytes = (bytes) => {
    const padding = (4 - (binLength % 4)) % 4;
    if (padding) {
      parts.push(new Uint8Array(padding));
      binLength += padding;
    }
    const offset = binLength;
    parts.push(bytes);
    binLength += bytes.length;
    return offset;
  };

  const addAccessor = (values, type, count, withBounds = false) => {
    const { array, accessor } = floatAccessor(values, type, count, withBounds);
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const byteOffset = appendBytes(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
    accessors.push({
      ...accessor,
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
    });
    return accessors.length - 1;
  };

  const usedClipNames = new Set();
  const builtAnimations = [];

  for (const clip of clips) {
    if (!clip || !Array.isArray(clip.tracks) || !clip.tracks.length) continue;

    const channels = [];
    const samplers = [];
    const timeAccessors = new Map();

    const timeAccessorFor = (times) => {
      if (!Array.isArray(times) || !times.length) return null;
      if (timeAccessors.has(times)) return timeAccessors.get(times);
      const accessor = addAccessor(times, 'SCALAR', times.length, true);
      timeAccessors.set(times, accessor);
      return accessor;
    };

    for (const track of clip.tracks) {
      const nodeIndex = nodeByName.get(track?.bone);
      if (nodeIndex === undefined) continue;

      const rotationTimes = track.rotTimes || clip.times;
      if (Array.isArray(track.quaternions)
        && Array.isArray(rotationTimes)
        && track.quaternions.length === rotationTimes.length * 4) {
        const input = timeAccessorFor(rotationTimes);
        if (input !== null) {
          const output = addAccessor(track.quaternions, 'VEC4', rotationTimes.length);
          samplers.push({ input, output, interpolation: 'LINEAR' });
          channels.push({
            sampler: samplers.length - 1,
            target: { node: nodeIndex, path: 'rotation' },
          });
        }
      }

      const positionTimes = track.posTimes || clip.times;
      if (Array.isArray(track.positions)
        && Array.isArray(positionTimes)
        && track.positions.length === positionTimes.length * 3) {
        const input = timeAccessorFor(positionTimes);
        if (input !== null) {
          const output = addAccessor(track.positions, 'VEC3', positionTimes.length);
          samplers.push({ input, output, interpolation: 'LINEAR' });
          channels.push({
            sampler: samplers.length - 1,
            target: { node: nodeIndex, path: 'translation' },
          });
        }
      }

      const scaleTimes = track.sclTimes || clip.times;
      if (Array.isArray(track.scales)
        && Array.isArray(scaleTimes)
        && track.scales.length === scaleTimes.length * 3) {
        const input = timeAccessorFor(scaleTimes);
        if (input !== null) {
          const output = addAccessor(track.scales, 'VEC3', scaleTimes.length);
          samplers.push({ input, output, interpolation: 'LINEAR' });
          channels.push({
            sampler: samplers.length - 1,
            target: { node: nodeIndex, path: 'scale' },
          });
        }
      }
    }

    if (!channels.length) continue;

    let name = String(clip.name || `clip_${builtAnimations.length + 1}`);
    if (usedClipNames.has(name)) {
      let suffix = 2;
      while (usedClipNames.has(`${name}_${suffix}`)) suffix += 1;
      name = `${name}_${suffix}`;
    }
    usedClipNames.add(name);
    builtAnimations.push({ name, channels, samplers });
  }

  if (!builtAnimations.length) return null;

  gltf.animations = [...animations, ...builtAnimations];
  gltf.buffers[0].byteLength = binLength;

  const bin = new Uint8Array(binLength);
  let offset = 0;
  for (const part of parts) {
    bin.set(part, offset);
    offset += part.length;
  }

  return encodeGlb(gltf, bin);
}

let animationManifest = null;
const animationFileCache = new Map();

async function getAnimationManifest() {
  if (!animationManifest) {
    animationManifest = fetch('assets/animations/index.json')
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));
  }
  return animationManifest;
}

async function fetchAnimationPackage(entry) {
  const manifest = await getAnimationManifest();
  const key = String(entry?.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const canonical = manifest?.[key];
  if (!canonical) return null;

  if (!animationFileCache.has(canonical)) {
    animationFileCache.set(canonical, (async () => {
      const response = await fetch(`assets/animations/${canonical}`);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return { file: canonical, bytes, data };
    })().catch(() => null));
  }

  return animationFileCache.get(canonical);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function textFile(value) {
  return new TextEncoder().encode(value);
}

/**
 * Build and trigger the download of one model package.
 * @param {object} entry catalog entry ({ id, name, file, ... })
 * @param {{onStatus?: (message: string) => void}} [options]
 * @returns {Promise<{filename: string, fileCount: number, bytes: number}>}
 */
export async function downloadModelPackage(entry, options = {}) {
  if (!entry?.file) throw new Error('Modelo sem arquivo glTF.');
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};

  const sourceName = entry.file.split('/').pop().split('?')[0];
  const root = safeName(sourceName.replace(/\.[^.]+$/, ''), 'model');
  const modelFile = `${root}.glb`;

  onStatus(`Baixando ${entry.name || root}…`);
  const modelResponse = await fetch(entry.file);
  if (!modelResponse.ok) throw new Error(`HTTP ${modelResponse.status} ao buscar o modelo.`);
  const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());

  onStatus('Extraindo texturas…');
  const parsed = parseGlb(modelBytes);
  const textures = extractTextures(parsed.json, parsed.bin);

  onStatus('Carregando animações…');
  const animation = await fetchAnimationPackage(entry);

  let finalModel = modelBytes;
  let embeddedAnimations = 0;
  let animationError = null;
  if (animation?.data?.clips?.length) {
    onStatus(`Embutindo ${animation.data.clips.length} animações…`);
    try {
      const animated = buildAnimatedGlb(parsed, animation.data);
      if (animated) {
        finalModel = animated;
        embeddedAnimations = animation.data.clips.length;
      }
    } catch (error) {
      animationError = error?.message || String(error);
      console.warn('Falha ao embutir animações no GLB:', error);
    }
  }

  const files = [{ name: `${root}/${modelFile}`, data: finalModel }];
  files.push(...textures.files.map((file) => ({ name: `${root}/${file.name}`, data: file.data })));

  if (animation) {
    files.push({
      name: `${root}/animations/${safeName(animation.file, 'animations.json')}`,
      data: animation.bytes,
    });
    files.push({
      name: `${root}/animations/provenance.json`,
      data: textFile(JSON.stringify({
        format: animation.data?.format || null,
        character: animation.data?.character || entry.id,
        clip_count: animation.data?.clip_count ?? animation.data?.clips?.length ?? 0,
        provenance: animation.data?.provenance || null,
      }, null, 2)),
    });
  }

  const metadata = {
    format: 'mua2-viewer-download-v1',
    downloadedAt: new Date().toISOString(),
    model: {
      id: entry.id,
      name: entry.name,
      costume: entry.costume || null,
      source: entry.source || null,
      originalFile: sourceName,
      tris: entry.tris ?? null,
      verts: entry.verts ?? null,
    },
    package: {
      model: modelFile,
      modelIncludesAnimations: embeddedAnimations > 0,
      animationClipCount: animation?.data?.clips?.length ?? 0,
      embeddedAnimationCount: embeddedAnimations,
      textures: textures.entries.length,
    },
    textures: textures.entries,
    animationSource: animation?.file || null,
    animationError,
  };
  files.push({
    name: `${root}/metadata.json`,
    data: textFile(JSON.stringify(metadata, null, 2)),
  });

  const animationNote = animation
    ? `- animations/${safeName(animation.file)} — ${metadata.package.animationClipCount} clipes Havok decodificados.\n`
    : '- Nenhum clipe de animação catalogado para este modelo.\n';
  const textureNote = textures.entries.length
    ? textures.entries.map((item) => `  - textures/${item.file}${item.slot ? ` (${item.material} · ${item.slot})` : ''}`).join('\n')
    : '  (nenhuma textura embutida no GLB)';
  const readme = [
    `MUA2 // ${entry.name || root}`,
    '',
    'Pacote gerado pelo Alchemy Asset Viewer.',
    '',
    'Conteúdo:',
    `- ${modelFile} — modelo glTF 2.0${embeddedAnimations ? ` com ${embeddedAnimations} animações embutidas` : ''} e texturas incorporadas.`,
    `- textures/ — texturas extraídas do GLB em arquivos separados (${textures.entries.length}).`,
    animationNote.trimEnd(),
    '- metadata.json — origem, contagem de vértices/triângulos e mapeamento das texturas.',
    '',
    'Texturas:',
    textureNote,
    '',
    'Uso:',
    '- Blender: File > Import > glTF 2.0 (.glb/.gltf).',
    '- three.js: GLTFLoader — os clipes ficam em gltf.animations.',
    '- Se o GLB não tiver animações embutidas, os clipes decodificados estão em animations/.',
    '',
    'Os assets são © Marvel / Activision / Vicarious Visions. Use apenas com',
    'uma cópia legítima do jogo, para uso pessoal/estudo. Não redistribua.',
    '',
  ].join('\n');
  files.push({ name: `${root}/README.txt`, data: textFile(readme) });

  onStatus('Montando ZIP…');
  const zip = buildZip(files);
  const filename = `${root}.zip`;
  downloadBlob(zip, filename);
  onStatus('download pronto');

  return {
    filename,
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.data.length, 0),
  };
}
