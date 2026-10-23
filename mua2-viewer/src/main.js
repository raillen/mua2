import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const viewport = document.getElementById('viewport');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('model-list');
const searchEl = document.getElementById('model-search');
const nameEl = document.getElementById('model-name');
const metaEl = document.getElementById('model-meta');

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0d10);
scene.fog = new THREE.Fog(0x0c0d10, 9, 22);

// ---------- environment / lights ----------
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const key = new THREE.DirectionalLight(0xffffff, 3.2);
key.position.set(3.5, 6.5, 4.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 20;
key.shadow.camera.left = -4;
key.shadow.camera.right = 4;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -2;
key.shadow.bias = -0.0008;
key.shadow.normalBias = 0.02;
scene.add(key);

const rim = new THREE.DirectionalLight(0xff6b5a, 1.15);
rim.position.set(-4, 3.5, -5);
scene.add(rim);

const fill = new THREE.DirectionalLight(0xffffff, 0.75);
fill.position.set(-4, 2, 4);
scene.add(fill);

scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x1b1e25, 0.8));

// ---------- stage ----------
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64),
  new THREE.MeshStandardMaterial({
    color: 0x14161b, roughness: 0.92, metalness: 0.05,
    transparent: true, opacity: 0.9
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.002;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(12, 24, 0x2b303c, 0x1b1e26);
grid.position.y = 0;
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);

// subtle accent ring
const ring = new THREE.Mesh(
  new THREE.RingGeometry(1.55, 1.57, 96),
  new THREE.MeshBasicMaterial({ color: 0xe62429, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.001;
scene.add(ring);

// ---------- camera / controls ----------
const camera = new THREE.PerspectiveCamera(38, viewport.clientWidth / viewport.clientHeight, 0.05, 100);
camera.position.set(2.4, 2.0, 3.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 1.2;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.95;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.85;

// ---------- model ----------
const loader = new GLTFLoader();
const models = [];
let current = null;
let currentEntry = null;
let spin = true;
let wireframe = false;
let texturesOn = true;
let showRig = false;
let skeletonHelper = null;

window.THREE = THREE;
window.__viewer = { renderer, scene, camera, controls };
const modelRoot = new THREE.Group();
scene.add(modelRoot);

function setLoading(on, text = 'Carregando modelo…') {
  loadingText.textContent = text;
  loading.classList.toggle('hidden', !on);
}

function clearModel() {
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.geometry.dispose();
    skeletonHelper = null;
  }
  while (modelRoot.children.length) {
    const obj = modelRoot.children.pop();
    obj.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
            if (m[k]) m[k].dispose();
          }
          m.dispose();
        });
      }
    });
  }
}

function modelBox(root) {
  // SkinnedMesh bounds live in bind space, so ask the mesh for its own box.
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.computeBoundingBox();
      box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
    } else if (o.isMesh) {
      o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  return box;
}

function prepare(model, entry) {
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.envMapIntensity = 0.75;
        if (m.normalMap) m.normalScale.set(0.45, 0.45);
        m.side = THREE.DoubleSide;
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        m.needsUpdate = true;
      });
    }
  });

  // center horizontally, feet on the floor
  const box = modelBox(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  ring.scale.setScalar(Math.max(0.9, size.x * 0.6));

  modelRoot.add(model);

  // rig overlay
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.geometry.dispose();
    skeletonHelper = null;
  }
  const skinned = [];
  model.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (skinned.length) {
    // SkeletonHelper needs the root object containing the bone hierarchy
    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.material.color.set(0x57d38c);
    skeletonHelper.material.depthTest = false;
    skeletonHelper.material.transparent = true;
    skeletonHelper.material.opacity = 0.85;
    skeletonHelper.visible = showRig;
    scene.add(skeletonHelper);
  }

  const target = new THREE.Vector3(0, size.y * 0.48, 0);
  controls.target.copy(target);
  const dist = Math.max(size.y * 1.15, size.x * 1.5, 2.2);
  camera.position.set(dist * 0.62, size.y * 0.58, dist * 0.95);
  camera.updateProjectionMatrix();
  controls.update();

  nameEl.textContent = entry.costume ? `${entry.name} — ${entry.costume}` : entry.name;
  const tris = countTris(model);
  const nb = skinned.length ? skinned[0].skeleton.bones.length : 0;
  metaEl.textContent = `${entry.source}  ·  ${tris.toLocaleString('pt-BR')} tris  ·  ${entry.textures} texturas`
    + (nb ? `  ·  ${nb} ossos` : '') + '  ·  IGZ v6';

  statusEl.textContent = 'pronto';
}

function countTris(root) {
  let t = 0;
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      if (o.geometry.index != null) t += o.geometry.index.count / 3;
      else t += o.geometry.attributes.position.count / 3;
    }
  });
  return Math.round(t);
}

function loadEntry(entry, index) {
  if (!entry) return;
  currentEntry = entry;
  setLoading(true, `Carregando ${entry.name}…`);
  statusEl.textContent = 'carregando…';
  listEl.querySelectorAll('.model-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === entry.id));

  loader.load(entry.file, (gltf) => {
    clearModel();
    current = gltf.scene;
    prepare(current, entry);
    wireframe = false;
    document.getElementById('btn-wire').classList.remove('active');
    setLoading(false);
  }, (ev) => {
    if (ev.total) {
      const pct = Math.round((ev.loaded / ev.total) * 100);
      loadingText.textContent = `Carregando ${entry.name}… ${pct}%`;
    }
  }, (err) => {
    console.error(err);
    loadingText.textContent = `Falha ao carregar ${entry.name}`;
  });
}

function buildList(filter = '') {
  listEl.innerHTML = '';
  const q = filter.trim().toLowerCase();
  models.forEach((m, i) => {
    const hay = `${m.name} ${m.costume || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return;
    const b = document.createElement('button');
    b.className = 'model-btn';
    b.dataset.id = m.id;
    b.dataset.index = i;
    b.innerHTML = `<span class="dot" style="--dot:${m.accent}"></span>
                   <span class="name">${m.name}</span>
                   ${m.costume ? `<span class="costume">${m.costume}</span>` : ''}
                   <span class="idx">${String(i + 1).padStart(2, '0')}</span>`;
    b.addEventListener('click', () => loadEntry(m, i));
    listEl.appendChild(b);
  });
  if (!listEl.children.length) {
    listEl.innerHTML = '<div class="vfx-empty">Nenhum personagem encontrado.</div>';
  }
}

// ---------- UI ----------
document.getElementById('btn-rotate').addEventListener('click', (e) => {
  spin = !spin;
  controls.autoRotate = spin;
  e.currentTarget.classList.toggle('active', spin);
});
document.getElementById('btn-wire').addEventListener('click', (e) => {
  wireframe = !wireframe;
  modelRoot.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { m.wireframe = wireframe; });
    }
  });
  e.currentTarget.classList.toggle('active', wireframe);
});
document.getElementById('btn-tex').addEventListener('click', (e) => {
  texturesOn = !texturesOn;
  modelRoot.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m.userData) m.userData = {};
        if (!('origMap' in m.userData)) {
          m.userData.origMap = m.map;
          m.userData.origNormal = m.normalMap;
          m.userData.origRough = m.metalnessMap;
        }
        m.map = texturesOn ? m.userData.origMap : null;
        m.normalMap = texturesOn ? m.userData.origNormal : null;
        m.metalnessMap = texturesOn ? m.userData.origRough : null;
        m.needsUpdate = true;
      });
    }
  });
  e.currentTarget.classList.toggle('active', texturesOn);
});
document.getElementById('btn-grid').addEventListener('click', (e) => {
  grid.visible = !grid.visible;
  ring.visible = grid.visible;
  document.getElementById('btn-grid').classList.toggle('active', grid.visible);
});
document.getElementById('btn-rig').addEventListener('click', (e) => {
  showRig = !showRig;
  if (skeletonHelper) skeletonHelper.visible = showRig;
  e.currentTarget.classList.toggle('active', showRig);
});
document.getElementById('btn-reset').addEventListener('click', () => {
  if (!current) return;
  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3(); box.getSize(size);
  const dist = Math.max(size.y * 1.15, size.x * 1.5, 2.2);
  camera.position.set(dist * 0.62, size.y * 0.58, dist * 0.95);
  controls.target.set(0, size.y * 0.48, 0);
  controls.update();
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && models[n - 1]) {
    loadEntry(models[n - 1], n - 1);
  } else if (e.key.toLowerCase() === 'r') {
    document.getElementById('btn-reset').click();
  } else if (e.key.toLowerCase() === 'w') {
    document.getElementById('btn-wire').click();
  } else if (e.key.toLowerCase() === 'b') {
    document.getElementById('btn-rig').click();
  } else if (e.key.toLowerCase() === 't') {
    document.getElementById('btn-tex').click();
  } else if (e.code === 'Space') {
    e.preventDefault();
    document.getElementById('btn-rotate').click();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

// ---------- boot ----------
async function boot() {
  const res = await fetch('assets/models/models.json');
  const data = await res.json();
  models.push(...data.models);
  buildList();
  searchEl.addEventListener('input', () => buildList(searchEl.value));
  loadEntry(models[0], 0);
}

boot().catch((err) => {
  console.error(err);
  loadingText.textContent = 'Não foi possível carregar a lista de modelos.';
});

// ---------- loop ----------
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------- VFX gallery ----------
const vfxModal = document.getElementById('vfx-modal');
const vfxGrid = document.getElementById('vfx-grid');
const vfxDetail = document.getElementById('vfx-detail');
let vfxLoaded = false;

async function openVfx() {
  vfxModal.classList.add('open');
  if (vfxLoaded) return;
  vfxLoaded = true;
  vfxGrid.innerHTML = '<div class="vfx-empty">Carregando efeitos…</div>';
  try {
    const res = await fetch('assets/vfx/effects_curated.json');
    const data = await res.json();
    vfxGrid.innerHTML = '';
    data.effects.forEach((e) => {
      const card = document.createElement('button');
      card.className = 'vfx-card';
      card.innerHTML = `<img src="${e.thumb}" alt="${e.name}">
        <div class="vfx-name">${e.name.replace(/_/g, ' ')}</div>
        <div class="vfx-path">${e.path}</div>`;
      card.addEventListener('click', () => showVfx(e, card));
      vfxGrid.appendChild(card);
    });
  } catch (err) {
    vfxGrid.innerHTML = '<div class="vfx-empty">Falha ao carregar a galeria.</div>';
  }
}

function showVfx(e, card) {
  vfxGrid.querySelectorAll('.vfx-card').forEach((c) => c.classList.toggle('active', c === card));
  vfxDetail.innerHTML = `
    <h3>${e.name.replace(/_/g, ' ')}</h3>
    <div class="effect-path">${e.path}</div>
    <div class="vfx-preview"><img src="${e.thumb}" alt="${e.name}"></div>
    <ul class="vfx-tex-list">
      ${e.textures.map((t) => `<li>${t}</li>`).join('')}
    </ul>
    <p class="vfx-note">Textura original do efeito extraída de <code>effects_igx.bin</code>.
    A animação é um preview visual; o grafo de partículas original do jogo não é reproduzido aqui.</p>`;
}

document.getElementById('btn-vfx').addEventListener('click', openVfx);
document.getElementById('vfx-close').addEventListener('click', () => vfxModal.classList.remove('open'));
vfxModal.addEventListener('click', (e) => {
  if (e.target === vfxModal) vfxModal.classList.remove('open');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') vfxModal.classList.remove('open');
});
