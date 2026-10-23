import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  createIdleClip,
  createCombatClip,
  createWalkClip,
  createAttackClip,
  createHeroicClip
} from './animations.js';

// ========================================================
// PERSISTENT SETTINGS (Requirement 5)
// ========================================================
const SETTINGS_KEY = 'mua2_viewer_settings';
const DEFAULT_SETTINGS = {
  rotate: true,
  wire: false,
  tex: true,
  grid: true,
  rig: false,
  anim: 'idle',
  animPlaying: true,
  animSpeed: 1.0,
  sidebarWidth: 320,
  sidebarView: 'cards', // 'cards' | 'list'
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = loadSettings();

function saveSetting(key, val) {
  settings[key] = val;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

// ========================================================
// DOM REFERENCES
// ========================================================
const appEl = document.getElementById('app');
const viewport = document.getElementById('viewport');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const statusEl = document.getElementById('status');

// Sidebar DOM
const sidebarEl = document.getElementById('sidebar');
const sidebarResizer = document.getElementById('sidebar-resizer');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
const listEl = document.getElementById('model-list');
const searchEl = document.getElementById('model-search');
const btnClearSearch = document.getElementById('btn-clear-search');
const filterCountText = document.getElementById('filter-count-text');
const btnCollapseAll = document.getElementById('btn-collapse-all');
const btnViewCards = document.getElementById('btn-view-cards');
const btnViewList = document.getElementById('btn-view-list');
const btnOpenGallery = document.getElementById('btn-open-gallery');
const galleryLaunchCount = document.getElementById('gallery-launch-count');

// Stage Caption DOM (Requirement 6 - Top-Left)
const nameEl = document.getElementById('model-name');
const costumeTagEl = document.getElementById('model-costume-tag');
const metaEl = document.getElementById('model-meta');

// Animation controls
const animSelect = document.getElementById('anim-select');
const btnAnimPlay = document.getElementById('btn-anim-play');
const btnAnimSpeed = document.getElementById('btn-anim-speed');

// Bottom Toolbar DOM (Requirement 4)
const btnRotate = document.getElementById('btn-rotate');
const btnWire = document.getElementById('btn-wire');
const btnTex = document.getElementById('btn-tex');
const btnGrid = document.getElementById('btn-grid');
const btnReset = document.getElementById('btn-reset');
const btnRig = document.getElementById('btn-rig');
const btnVfx = document.getElementById('btn-vfx');

// Topbar Navigation (Requirement 7)
const navBtnChars = document.getElementById('nav-btn-chars');
const navBtnProps = document.getElementById('nav-btn-props');
const navBtnVfx = document.getElementById('nav-btn-vfx');
const navCharsCount = document.getElementById('nav-chars-count');
const navVfxCount = document.getElementById('nav-vfx-count');

// Gallery Modal DOM (Requirement 2)
const galleryModal = document.getElementById('gallery-modal');
const galleryClose = document.getElementById('gallery-close');
const galleryGrid = document.getElementById('gallery-grid');
const gallerySearch = document.getElementById('gallery-search');
const galleryCategorySelect = document.getElementById('gallery-category-select');
const galleryStatsText = document.getElementById('gallery-stats-text');

// Props Modal DOM
const propsModal = document.getElementById('props-modal');
const propsClose = document.getElementById('props-close');
const btnPropsViewWeapons = document.getElementById('btn-props-view-weapons');

// VFX Modal DOM
const vfxModal = document.getElementById('vfx-modal');
const vfxClose = document.getElementById('vfx-close');
const vfxGrid = document.getElementById('vfx-grid');
const vfxDetail = document.getElementById('vfx-detail');

// ========================================================
// THREE.JS RENDERER & SCENE SETUP
// ========================================================
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090a0d);
scene.fog = new THREE.Fog(0x090a0d, 10, 24);

// Environment & Lighting
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(3.5, 6.5, 4.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 20;
keyLight.shadow.camera.left = -4;
keyLight.shadow.camera.right = 4;
keyLight.shadow.camera.top = 5;
keyLight.shadow.camera.bottom = -2;
keyLight.shadow.bias = -0.0008;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xff6b5a, 1.15);
rimLight.position.set(-4, 3.5, -5);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
fillLight.position.set(-4, 2, 4);
scene.add(fillLight);

scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x1b1e25, 0.8));

// Stage Floor & Grid
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64),
  new THREE.MeshStandardMaterial({
    color: 0x13151b,
    roughness: 0.92,
    metalness: 0.05,
    transparent: true,
    opacity: 0.9,
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.002;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(12, 24, 0x2b303c, 0x181a22);
grid.position.y = 0;
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);

const ring = new THREE.Mesh(
  new THREE.RingGeometry(1.55, 1.57, 96),
  new THREE.MeshBasicMaterial({
    color: 0xe62429,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
  })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.001;
scene.add(ring);

// Camera & Controls
const camera = new THREE.PerspectiveCamera(38, viewport.clientWidth / viewport.clientHeight, 0.05, 100);
camera.position.set(2.4, 2.0, 3.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 1.0;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.95;
controls.autoRotate = settings.rotate;
controls.autoRotateSpeed = 0.85;

// ========================================================
// STATE & MODEL STORAGE
// ========================================================
const loader = new GLTFLoader();
const models = [];
let characterGroups = new Map(); // name -> { name, items: [], accent, thumb }
let current = null;
let currentEntry = null;

// Display flags (initialized from persistent settings)
let spin = settings.rotate;
let wireframe = settings.wire;
let texturesOn = settings.tex;
let showRig = settings.rig;
let skeletonHelper = null;

// Animation state
const clock = new THREE.Clock();
let mixer = null;
let currentAction = null;
let animClips = {};
let selectedAnim = settings.anim;
let animPlaying = settings.animPlaying;
let animSpeed = settings.animSpeed;

window.THREE = THREE;
window.__viewer = { renderer, scene, camera, controls };
const modelRoot = new THREE.Group();
scene.add(modelRoot);

// ========================================================
// SIDEBAR RESIZING IMPLEMENTATION (Requirement 1)
// ========================================================
function applySidebarWidth(w) {
  const clamped = Math.max(260, Math.min(580, w));
  appEl.style.setProperty('--sidebar-width', `${clamped}px`);
  saveSetting('sidebarWidth', clamped);
}

if (settings.sidebarWidth) {
  applySidebarWidth(settings.sidebarWidth);
}

let isResizing = false;
sidebarResizer.addEventListener('pointerdown', (e) => {
  isResizing = true;
  sidebarResizer.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!isResizing) return;
  applySidebarWidth(e.clientX);
  onWindowResize();
});

window.addEventListener('pointerup', () => {
  if (isResizing) {
    isResizing = false;
    sidebarResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

sidebarResizer.addEventListener('dblclick', () => {
  applySidebarWidth(320);
  onWindowResize();
});

// Keyboard accessibility for resizer
sidebarResizer.addEventListener('keydown', (e) => {
  const currentW = parseInt(getComputedStyle(appEl).getPropertyValue('--sidebar-width')) || 320;
  if (e.key === 'ArrowLeft') {
    applySidebarWidth(currentW - 20);
    onWindowResize();
  } else if (e.key === 'ArrowRight') {
    applySidebarWidth(currentW + 20);
    onWindowResize();
  }
});

// Mobile Sidebar Drawer Toggle (Requirement 8)
btnSidebarToggle.addEventListener('click', () => {
  sidebarEl.classList.toggle('mobile-open');
  sidebarOverlay.classList.toggle('active', sidebarEl.classList.contains('mobile-open'));
});
sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.remove('mobile-open');
  sidebarOverlay.classList.remove('active');
});

// ========================================================
// 3D MODEL PREPARATION & BOUNDING BOX
// ========================================================
function setLoading(on, text = 'Carregando modelo…') {
  loadingText.textContent = text;
  loading.classList.toggle('hidden', !on);
}

function clearModel() {
  if (mixer) {
    mixer.stopAllAction();
    if (current) mixer.uncacheRoot(current);
    mixer = null;
  }
  currentAction = null;
  animClips = {};

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
        m.wireframe = wireframe;
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        // Textures toggle state
        if (!m.userData) m.userData = {};
        m.userData.origMap = m.map;
        m.userData.origNormal = m.normalMap;
        m.userData.origRough = m.metalnessMap;
        if (!texturesOn) {
          m.map = null;
          m.normalMap = null;
          m.metalnessMap = null;
        }
        m.needsUpdate = true;
      });
    }
  });

  // Center horizontally, feet on floor
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

  // Rig overlay
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.geometry.dispose();
    skeletonHelper = null;
  }
  const skinned = [];
  model.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (skinned.length) {
    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.material.color.set(0x57d38c);
    skeletonHelper.material.depthTest = false;
    skeletonHelper.material.transparent = true;
    skeletonHelper.material.opacity = 0.85;
    skeletonHelper.visible = showRig;
    scene.add(skeletonHelper);

    // Record bone rest transforms
    model.traverse((o) => {
      if (o.isBone && !o.userData.restQuat) {
        o.userData.restQuat = o.quaternion.clone();
        o.userData.restPos = o.position.clone();
      }
    });

    // Animation mixer + clips
    mixer = new THREE.AnimationMixer(model);
    window.__viewer.mixer = mixer;
    try {
      animClips = {
        idle: createIdleClip(model),
        combat: createCombatClip(model),
        walk: createWalkClip(model),
        attack: createAttackClip(model),
        heroic: createHeroicClip(model),
      };
      window.__viewer.animClips = animClips;
    } catch (err) {
      console.warn('Procedural anim generation error:', err);
      animClips = {};
    }
    applyAnimation(selectedAnim, 0.0);
  } else {
    mixer = null;
    animClips = {};
  }

  // Camera framing
  const target = new THREE.Vector3(0, size.y * 0.48, 0);
  controls.target.copy(target);
  const dist = Math.max(size.y * 1.15, size.x * 1.5, 2.2);
  camera.position.set(dist * 0.62, size.y * 0.58, dist * 0.95);
  camera.updateProjectionMatrix();
  controls.update();

  // Caption update (Requirement 6 - Top-Left)
  nameEl.textContent = entry.name;
  if (entry.costume) {
    costumeTagEl.textContent = entry.costume;
    costumeTagEl.style.display = 'inline-block';
  } else {
    costumeTagEl.style.display = 'none';
  }
  const tris = countTris(model);
  const nb = skinned.length ? skinned[0].skeleton.bones.length : 0;
  metaEl.textContent = `${entry.source}  ·  ${tris.toLocaleString('pt-BR')} tris  ·  ${entry.textures} texturas`
    + (nb ? `  ·  ${nb} ossos` : '') + '  ·  IGZ v6';

  statusEl.textContent = 'pronto';
}

function loadEntry(entry) {
  if (!entry) return;
  currentEntry = entry;
  setLoading(true, `Carregando ${entry.name}…`);
  statusEl.textContent = 'carregando…';

  // Highlight active button in sidebar and modal
  updateActiveButtons(entry.id);

  loader.load(entry.file, (gltf) => {
    clearModel();
    current = gltf.scene;
    prepare(current, entry);
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

function updateActiveButtons(activeId) {
  // Update sidebar buttons
  listEl.querySelectorAll('.model-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === activeId);
  });
  // Update parent accordion groups
  listEl.querySelectorAll('.accordion-group').forEach((group) => {
    const hasActiveChild = !!group.querySelector(`.model-btn[data-id="${activeId}"]`);
    group.classList.toggle('has-active', hasActiveChild);
    if (hasActiveChild) {
      group.classList.add('expanded');
    }
  });
  // Update gallery modal cards if open
  galleryGrid.querySelectorAll('.gallery-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.id === activeId);
  });
}

// ========================================================
// CHARACTER GROUPING & ACCORDION (Requirement 1 & 3)
// ========================================================
function groupModels(list) {
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.name)) {
      groups.set(m.name, {
        name: m.name,
        accent: m.accent || '#e62429',
        thumb: m.thumb,
        items: [],
      });
    }
    groups.get(m.name).items.push(m);
  }
  return groups;
}

function buildList(filter = '') {
  listEl.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const isCards = settings.sidebarView === 'cards';
  listEl.className = `model-list ${isCards ? 'view-cards' : 'view-list'}`;

  let matchingGroupsCount = 0;
  let matchingItemsCount = 0;

  characterGroups.forEach((group) => {
    // Check if group name or any item matches search
    const groupMatches = q ? group.name.toLowerCase().includes(q) : true;
    const matchingItems = group.items.filter((item) => {
      if (!q) return true;
      const hay = `${item.name} ${item.costume || ''} ${item.source} ${item.id}`.toLowerCase();
      return hay.includes(q);
    });

    if (q && !groupMatches && matchingItems.length === 0) return;

    matchingGroupsCount++;
    const itemsToRender = q && !groupMatches ? matchingItems : group.items;
    matchingItemsCount += itemsToRender.length;

    // Single item character (no accordion needed)
    if (group.items.length === 1) {
      const m = group.items[0];
      const b = createModelButton(m, isCards);
      listEl.appendChild(b);
      return;
    }

    // Multiple variations -> Accordion Group (Requirement 1)
    const accGroup = document.createElement('div');
    accGroup.className = 'accordion-group';
    if (q) accGroup.classList.add('expanded'); // Auto-expand when searching

    const isCurrentActive = group.items.some((item) => currentEntry && item.id === currentEntry.id);
    if (isCurrentActive) {
      accGroup.classList.add('has-active', 'expanded');
    }

    // Header
    const accHeader = document.createElement('button');
    accHeader.className = 'accordion-header';
    accHeader.setAttribute('aria-expanded', accGroup.classList.contains('expanded'));
    accHeader.innerHTML = `
      <span class="accordion-chevron" aria-hidden="true">▶</span>
      ${isCards ? `
        <div class="card-thumb-wrap" style="width:36px; height:36px;">
          <img src="${group.thumb || group.items[0].thumb}" class="card-thumb" alt="${group.name}" loading="lazy">
        </div>
      ` : `
        <span class="accordion-dot" style="--dot:${group.accent}"></span>
      `}
      <div class="accordion-title-wrap">
        <span class="accordion-name">${group.name}</span>
        <span class="accordion-badge">${group.items.length} variações</span>
      </div>
    `;

    accHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const willExpand = !accGroup.classList.contains('expanded');
      accGroup.classList.toggle('expanded', willExpand);
      accHeader.setAttribute('aria-expanded', willExpand);
      // If expanding and not active, optionally load first costume
      if (willExpand && (!currentEntry || !group.items.some(i => i.id === currentEntry.id))) {
        loadEntry(group.items[0]);
      }
    });

    // Body
    const accBody = document.createElement('div');
    accBody.className = 'accordion-body';

    itemsToRender.forEach((m) => {
      const b = createModelButton(m, isCards, true);
      accBody.appendChild(b);
    });

    accGroup.appendChild(accHeader);
    accGroup.appendChild(accBody);
    listEl.appendChild(accGroup);
  });

  // Update counts
  if (q) {
    filterCountText.textContent = `${matchingItemsCount} modelo(s) encontrados`;
  } else {
    filterCountText.textContent = `${characterGroups.size} personagens · ${models.length} variações`;
  }

  if (matchingGroupsCount === 0) {
    listEl.innerHTML = '<div class="vfx-empty" style="text-align:center; padding:24px 8px;">Nenhum personagem encontrado.</div>';
  }
}

function createModelButton(m, isCards, isVariation = false) {
  const b = document.createElement('button');
  b.className = 'model-btn';
  b.dataset.id = m.id;
  if (currentEntry && m.id === currentEntry.id) b.classList.add('active');

  if (isCards) {
    // Card Mode Layout (Requirement 3):
    // [ MINIATURA ] NOME DO PERSONAGEM [tag]
    //               actor/0000 IGZ vX
    b.innerHTML = `
      <div class="card-thumb-wrap">
        <img src="${m.thumb}" class="card-thumb" alt="${m.name}" loading="lazy">
      </div>
      <div class="card-info">
        <div class="card-title-row">
          <span class="card-name">${m.name}</span>
          ${m.costume ? `<span class="costume-tag">${m.costume}</span>` : ''}
        </div>
        <div class="card-sub-row">
          <span class="card-actor">${m.source}</span>
          <span class="card-format">IGZ v6</span>
          <span class="btn-meta">${m.tris ? m.tris.toLocaleString('pt-BR') + 't' : ''}</span>
        </div>
      </div>
    `;
  } else {
    // Compact List Mode
    b.innerHTML = `
      <span class="accordion-dot" style="--dot:${m.accent}"></span>
      <span class="card-name" style="flex:1 1 auto;">${m.name}</span>
      ${m.costume ? `<span class="costume-tag">${m.costume}</span>` : ''}
      <span class="btn-meta">${m.source}</span>
    `;
  }

  b.addEventListener('click', (e) => {
    e.stopPropagation();
    loadEntry(m);
    // Close mobile drawer if open
    if (sidebarEl.classList.contains('mobile-open')) {
      sidebarEl.classList.remove('mobile-open');
      sidebarOverlay.classList.remove('active');
    }
  });

  return b;
}

// View toggle handlers
btnViewCards.addEventListener('click', () => {
  btnViewCards.classList.add('active');
  btnViewCards.setAttribute('aria-pressed', 'true');
  btnViewList.classList.remove('active');
  btnViewList.setAttribute('aria-pressed', 'false');
  saveSetting('sidebarView', 'cards');
  buildList(searchEl.value);
});

btnViewList.addEventListener('click', () => {
  btnViewList.classList.add('active');
  btnViewList.setAttribute('aria-pressed', 'true');
  btnViewCards.classList.remove('active');
  btnViewCards.setAttribute('aria-pressed', 'false');
  saveSetting('sidebarView', 'list');
  buildList(searchEl.value);
});

// Search input
searchEl.addEventListener('input', () => {
  const val = searchEl.value;
  btnClearSearch.style.display = val ? 'block' : 'none';
  buildList(val);
});
btnClearSearch.addEventListener('click', () => {
  searchEl.value = '';
  btnClearSearch.style.display = 'none';
  buildList('');
  searchEl.focus();
});

// Collapse / Expand All
let allExpanded = false;
btnCollapseAll.addEventListener('click', () => {
  allExpanded = !allExpanded;
  btnCollapseAll.textContent = allExpanded ? 'Expandir todos' : 'Recolher todos';
  listEl.querySelectorAll('.accordion-group').forEach((g) => {
    g.classList.toggle('expanded', !allExpanded);
  });
});

// ========================================================
// MODO GALERIA MODAL (Requirement 2)
// ========================================================
function openGalleryModal() {
  galleryModal.classList.add('open');
  buildGalleryGrid();
  gallerySearch.focus();
}

function closeGalleryModal() {
  galleryModal.classList.remove('open');
}

function buildGalleryGrid() {
  galleryGrid.innerHTML = '';
  const q = gallerySearch.value.trim().toLowerCase();
  const cat = galleryCategorySelect.value;

  const filtered = models.filter((m) => {
    // Text search
    if (q) {
      const hay = `${m.name} ${m.costume || ''} ${m.source} ${m.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // Category filter
    if (cat === 'heroes') {
      const heroNames = ['spider', 'iron', 'wolverine', 'captain', 'thor', 'hulk', 'deadpool', 'storm', 'gambit', 'daredevil', 'iceman', 'panther', 'cable', 'jean', 'torch', 'invisible', 'fantastic', 'thing', 'luke', 'msmarvel', 'psylocke', 'fury', 'shehulk', 'colossus', 'hercules', 'goliath', 'songbird', 'penance', 'spiderwoman', 'widow', 'bishop'];
      return heroNames.some(k => m.id.toLowerCase().includes(k) || m.name.toLowerCase().includes(k));
    }
    if (cat === 'villains') {
      const villainNames = ['venom', 'goblin', 'magneto', 'carnage', 'juggernaut', 'tinkerer', 'shocker', 'scorcher', 'wizard', 'whirlwind', 'titanium', 'grimreaper', 'bullseye', 'electro', 'ladydeathstrike', 'jackolantern'];
      return villainNames.some(k => m.id.toLowerCase().includes(k) || m.name.toLowerCase().includes(k));
    }
    if (cat === 'props') {
      return ['baton', 'bola', 'staff', 'chain', 'waldos', 'webmace', 'tongue'].some(k => m.id.toLowerCase().includes(k));
    }
    if (cat === 'npcs') {
      const isHero = ['spider', 'iron', 'wolverine', 'captain', 'thor', 'hulk', 'deadpool', 'storm', 'gambit', 'daredevil', 'iceman', 'panther', 'cable', 'jean', 'torch', 'invisible', 'fantastic', 'thing', 'luke', 'msmarvel', 'psylocke', 'fury'].some(k => m.id.toLowerCase().includes(k));
      const isVillain = ['venom', 'goblin', 'magneto', 'carnage', 'juggernaut'].some(k => m.id.toLowerCase().includes(k));
      return !isHero && !isVillain;
    }
    return true;
  });

  galleryStatsText.textContent = `Exibindo ${filtered.length} de ${models.length} modelos`;

  filtered.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.dataset.id = m.id;
    if (currentEntry && m.id === currentEntry.id) card.classList.add('active');

    card.innerHTML = `
      <img src="${m.thumb}" class="gallery-card-thumb" alt="${m.name}" loading="lazy">
      <div class="gallery-card-body">
        <div class="gallery-card-title-row">
          <span class="gallery-card-name" title="${m.name}">${m.name}</span>
          ${m.costume ? `<span class="costume-tag">${m.costume}</span>` : ''}
        </div>
        <div class="gallery-card-meta">
          <span>${m.source}</span>
          <span>${m.tris ? m.tris.toLocaleString('pt-BR') + ' tris' : ''}</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      loadEntry(m);
      closeGalleryModal();
    });

    galleryGrid.appendChild(card);
  });

  if (filtered.length === 0) {
    galleryGrid.innerHTML = '<div class="vfx-empty" style="grid-column:1/-1; text-align:center; padding:40px;">Nenhum modelo corresponde aos filtros aplicados.</div>';
  }
}

btnOpenGallery.addEventListener('click', openGalleryModal);
galleryClose.addEventListener('click', closeGalleryModal);
gallerySearch.addEventListener('input', buildGalleryGrid);
galleryCategorySelect.addEventListener('change', buildGalleryGrid);
galleryModal.addEventListener('click', (e) => {
  if (e.target === galleryModal) closeGalleryModal();
});

// ========================================================
// PROPS & SCENERY MODAL (Requirement 7)
// ========================================================
function openPropsModal() {
  propsModal.classList.add('open');
}
function closePropsModal() {
  propsModal.classList.remove('open');
}
navBtnProps.addEventListener('click', openPropsModal);
propsClose.addEventListener('click', closePropsModal);
propsModal.addEventListener('click', (e) => {
  if (e.target === propsModal) closePropsModal();
});
btnPropsViewWeapons.addEventListener('click', () => {
  closePropsModal();
  openGalleryModal();
  galleryCategorySelect.value = 'props';
  buildGalleryGrid();
});

// ========================================================
// TOPBAR NAVIGATION TABS
// ========================================================
navBtnChars.addEventListener('click', () => {
  navBtnChars.classList.add('active');
  navBtnProps.classList.remove('active');
  navBtnVfx.classList.remove('active');
  searchEl.value = '';
  buildList('');
});

navBtnVfx.addEventListener('click', () => {
  openVfx();
});

// ========================================================
// BOTTOM TOOLBAR CONTROLS & PERSISTENCE (Requirement 4 & 5)
// ========================================================

// 1. Auto-rotation Orbit
btnRotate.addEventListener('click', (e) => {
  spin = !spin;
  controls.autoRotate = spin;
  btnRotate.classList.toggle('active', spin);
  btnRotate.setAttribute('aria-pressed', spin);
  saveSetting('rotate', spin);
});

// 2. Wireframe
btnWire.addEventListener('click', (e) => {
  wireframe = !wireframe;
  modelRoot.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { m.wireframe = wireframe; });
    }
  });
  btnWire.classList.toggle('active', wireframe);
  btnWire.setAttribute('aria-pressed', wireframe);
  saveSetting('wire', wireframe);
});

// 3. Textures
btnTex.addEventListener('click', (e) => {
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
  btnTex.classList.toggle('active', texturesOn);
  btnTex.setAttribute('aria-pressed', texturesOn);
  saveSetting('tex', texturesOn);
});

// 4. Ground Grid
btnGrid.addEventListener('click', (e) => {
  const isVisible = !grid.visible;
  grid.visible = isVisible;
  ring.visible = isVisible;
  btnGrid.classList.toggle('active', isVisible);
  btnGrid.setAttribute('aria-pressed', isVisible);
  saveSetting('grid', isVisible);
});

// 5. Skeleton Rig Helper
btnRig.addEventListener('click', (e) => {
  showRig = !showRig;
  if (skeletonHelper) skeletonHelper.visible = showRig;
  btnRig.classList.toggle('active', showRig);
  btnRig.setAttribute('aria-pressed', showRig);
  saveSetting('rig', showRig);
});

// 6. Camera Reset
btnReset.addEventListener('click', () => {
  if (!current) return;
  const box = modelBox(current);
  const size = new THREE.Vector3(); box.getSize(size);
  const dist = Math.max(size.y * 1.15, size.x * 1.5, 2.2);
  camera.position.set(dist * 0.62, size.y * 0.58, dist * 0.95);
  controls.target.set(0, size.y * 0.48, 0);
  controls.update();
});

// 7. Open VFX Gallery from Toolbar
btnVfx.addEventListener('click', openVfx);

// Apply initial UI button active states from settings
btnRotate.classList.toggle('active', settings.rotate);
btnRotate.setAttribute('aria-pressed', settings.rotate);
btnWire.classList.toggle('active', settings.wire);
btnWire.setAttribute('aria-pressed', settings.wire);
btnTex.classList.toggle('active', settings.tex);
btnTex.setAttribute('aria-pressed', settings.tex);
btnGrid.classList.toggle('active', settings.grid);
btnGrid.setAttribute('aria-pressed', settings.grid);
btnRig.classList.toggle('active', settings.rig);
btnRig.setAttribute('aria-pressed', settings.rig);
grid.visible = settings.grid;
ring.visible = settings.grid;

// View toggle buttons active states
btnViewCards.classList.toggle('active', settings.sidebarView === 'cards');
btnViewCards.setAttribute('aria-pressed', settings.sidebarView === 'cards');
btnViewList.classList.toggle('active', settings.sidebarView === 'list');
btnViewList.setAttribute('aria-pressed', settings.sidebarView === 'list');

// ========================================================
// ANIMATION LOGIC & PROCEDURAL ACTIONS
// ========================================================
function applyAnimation(name, fadeDuration = 0.35) {
  selectedAnim = name;
  saveSetting('anim', name);
  if (animSelect) animSelect.value = name;
  if (!mixer) return;

  if (name === 'none') {
    if (currentAction) {
      currentAction.fadeOut(fadeDuration);
      currentAction = null;
    }
    if (current) {
      current.traverse((o) => {
        if (o.isBone && o.userData.restQuat) {
          o.quaternion.copy(o.userData.restQuat);
          o.position.copy(o.userData.restPos);
        }
      });
    }
    return;
  }

  const clip = animClips[name];
  if (!clip) return;

  const nextAction = mixer.clipAction(clip);
  if (currentAction === nextAction) return;

  if (currentAction) {
    currentAction.fadeOut(fadeDuration);
  }
  nextAction.reset().fadeIn(fadeDuration).play();
  currentAction = nextAction;
}

if (animSelect) {
  animSelect.value = settings.anim;
  animSelect.addEventListener('change', (e) => {
    applyAnimation(e.target.value);
  });
}

if (btnAnimPlay) {
  animPlaying = settings.animPlaying;
  btnAnimPlay.textContent = animPlaying ? '⏸' : '▶';
  btnAnimPlay.classList.toggle('active', animPlaying);
  btnAnimPlay.addEventListener('click', () => {
    animPlaying = !animPlaying;
    saveSetting('animPlaying', animPlaying);
    btnAnimPlay.textContent = animPlaying ? '⏸' : '▶';
    btnAnimPlay.classList.toggle('active', animPlaying);
  });
}

const speeds = [0.5, 1.0, 1.5, 2.0];
if (btnAnimSpeed) {
  animSpeed = settings.animSpeed || 1.0;
  btnAnimSpeed.textContent = `${animSpeed.toFixed(1)}x`;
  btnAnimSpeed.addEventListener('click', () => {
    const next = speeds[(speeds.indexOf(animSpeed) + 1) % speeds.length];
    animSpeed = next;
    saveSetting('animSpeed', next);
    btnAnimSpeed.textContent = `${next.toFixed(1)}x`;
  });
}

// ========================================================
// KEYBOARD SHORTCUTS
// ========================================================
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  if (e.key === 'Escape') {
    if (galleryModal.classList.contains('open')) closeGalleryModal();
    if (vfxModal.classList.contains('open')) vfxModal.classList.remove('open');
    if (propsModal.classList.contains('open')) closePropsModal();
    return;
  }

  const n = Number(e.key);
  if (n >= 1 && n <= 9 && models[n - 1]) {
    loadEntry(models[n - 1]);
  } else if (e.key.toLowerCase() === 'r') {
    btnReset.click();
  } else if (e.key.toLowerCase() === 'w') {
    btnWire.click();
  } else if (e.key.toLowerCase() === 'b') {
    btnRig.click();
  } else if (e.key.toLowerCase() === 't') {
    btnTex.click();
  } else if (e.key.toLowerCase() === 'g') {
    openGalleryModal();
  } else if (e.key.toLowerCase() === 'p') {
    if (btnAnimPlay) btnAnimPlay.click();
  } else if (e.code === 'Space') {
    e.preventDefault();
    btnRotate.click();
  }
});

// Window resize
function onWindowResize() {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}
window.addEventListener('resize', onWindowResize);

// ========================================================
// ANIMATION LOOP
// ========================================================
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  if (mixer && animPlaying) {
    mixer.update(delta * animSpeed);
  }
  controls.update();
  renderer.render(scene, camera);
});

// ========================================================
// VFX GALLERY IMPLEMENTATION
// ========================================================
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
      card.innerHTML = `
        <img src="${e.thumb}" alt="${e.name}">
        <div class="vfx-name">${e.name.replace(/_/g, ' ')}</div>
        <div class="vfx-path">${e.path}</div>
      `;
      card.addEventListener('click', () => showVfx(e, card));
      vfxGrid.appendChild(card);
    });
    if (data.effects.length) {
      showVfx(data.effects[0], vfxGrid.children[0]);
    }
  } catch (err) {
    vfxGrid.innerHTML = '<div class="vfx-empty">Falha ao carregar a galeria de VFX.</div>';
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
    A animação é um preview visual da textura original do motor.</p>
  `;
}

vfxClose.addEventListener('click', () => vfxModal.classList.remove('open'));
vfxModal.addEventListener('click', (e) => {
  if (e.target === vfxModal) vfxModal.classList.remove('open');
});

// ========================================================
// BOOT
// ========================================================
async function boot() {
  const res = await fetch('assets/models/models.json?v=' + Date.now());
  const data = await res.json();
  models.push(...data.models);

  // Group characters by base name (Requirement 1)
  characterGroups = groupModels(models);

  // Update counts
  if (navCharsCount) navCharsCount.textContent = models.length;
  if (galleryLaunchCount) galleryLaunchCount.textContent = models.length;

  buildList();
  loadEntry(models[0]);
}

boot().catch((err) => {
  console.error(err);
  loadingText.textContent = 'Não foi possível carregar a lista de modelos.';
});
