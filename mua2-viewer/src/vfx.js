const PAGE_SIZE = 100;
const PLAYBACK_NOTICE = 'Reprodução indisponível: emissor ainda não decodificado';
const STATUS_LABELS = { decoded: 'Decodificado', partial: 'Parcial', 'metadata-only': 'Metadados', error: 'Erro' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function textureUrl(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  // Catalog images stay within the shipped texture directory, never remote URLs.
  return /^assets\/vfx\/[\w./-]+$/.test(path) && !path.split('/').includes('..') ? path : null;
}

function normalizeEffect(raw) {
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

function matches(effect, query, category, character) {
  return (category === 'all' || effect.category === category)
    && (character === 'all' || effect.character === character)
    && (!query || `${effect.id} ${effect.name} ${effect.path} ${effect.character || ''} ${effect.category} ${effect.textures.join(' ')}`.toLowerCase().includes(query));
}

function badge(effect) {
  return `<span class="vfx-badge status-${effect.status}">${STATUS_LABELS[effect.status]}</span>`;
}

export class VfxCatalogController {
  constructor({ models = [], loadModel = () => {}, openModal = () => {}, closeModal = () => {}, refreshIcons = () => {} } = {}) {
    Object.assign(this, { models, loadModel, openModal, closeModal, refreshIcons });
    this.effects = [];
    this.selectedEffect = null;
    this.viewMode = 'cards';
    this.hasLoaded = false;
    this.loading = null;
    this.surfaces = {};
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
      // A decoded definition is inspectable, not evidence of an implemented player.
      surface.detail.innerHTML = `<h3 class="vfx-selection-title">${title}</h3><div class="effect-path">${escapeHtml(effect.path)}</div><div class="vfx-selection-meta-row">${badge(effect)}<span class="vfx-meta-tag">${escapeHtml(effect.category)}</span></div><p class="vfx-unavail-banner">${PLAYBACK_NOTICE}</p>`;
      const model = this.models.find((model) => effect.modelIds.includes(model.id));
      if (effect.character) {
        const association = document.createElement('p');
        association.textContent = `Personagem: ${effect.character}${model ? '' : ' · sem modelo disponível nos modelIds explícitos'}`;
        surface.detail.append(association);
      }
      if (model) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vfx-char-btn';
        button.textContent = `Carregar ${model.name} e manter efeito selecionado`;
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = `Carregando ${model.name}…`;
          try {
            await this.loadModel(model);
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
      if (effect.thumb) {
        const preview = document.createElement('figure');
        preview.className = 'vfx-preview';
        preview.innerHTML = `<img src="${escapeHtml(effect.thumb)}" alt="Textura estática de ${title}"><figcaption>Textura estática original. Não é uma animação de VFX.</figcaption>`;
        surface.detail.append(preview);
      }
      const textures = document.createElement('ul');
      textures.className = 'vfx-tex-list';
      for (const texture of effect.textures) {
        const item = document.createElement('li');
        item.textContent = texture;
        textures.append(item);
      }
      surface.detail.append(textures);
      for (const [label, value] of [['Definição', effect.definition], ['Não suportado', effect.unsupported]]) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = label;
        const pre = document.createElement('pre');
        pre.textContent = value == null ? 'Não disponível' : JSON.stringify(value, null, 2);
        details.append(summary, pre);
        surface.detail.append(details);
      }
      if (name === 'sidebar') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'vfx-load-more-btn';
        close.textContent = 'Fechar detalhes';
        close.addEventListener('click', () => {
          this.selectedEffect = null;
          this.renderDetails();
          this.render('sidebar');
          this.render('modal');
          surface.list.querySelector('button')?.focus();
        });
        surface.detail.append(close);
      }
    }
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
}

export function initVfxCatalog(options) {
  const controller = new VfxCatalogController(options);
  controller.init();
  return controller;
}

// Run: node --input-type=module -e "import('./src/vfx.js').then(m => m.selfCheckVfxCatalog())"
export function selfCheckVfxCatalog() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
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
  return 'VFX catalog self-check passed';
}
