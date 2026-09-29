// Main application: routing, library grid, gallery, watch page, tag manager and settings.

import { $, $$, api, debounce, fmtAgo, fmtDate, fmtDuration, fmtSize, h, icon, store, tagColor, toast } from './util.js';
import { autocomplete, parseQuery, searchBar, tagChip, tagEditor, tagStore } from './tags.js';
import { createPlayer } from './player.js';
import { closeLightbox, isLightboxOpen, openLightbox } from './lightbox.js';

const view = $('#view');
const PAGE = 60;

const S = {
  route: null,
  cleanup: [],          // teardown callbacks for the current view
  listing: null,        // current listing state (results, paging)
  queue: null,          // { ids, items } of the listing a video was opened from (for "Up next")
  selected: new Set(),
  settings: null,
  player: null,
};

// ---------------------------------------------------------------------------
// Routing

const LISTINGS = {
  '': { title: 'Home', type: null, layout: 'grid' },
  videos: { title: 'Videos', type: 'video', layout: 'grid' },
  gallery: { title: 'Gallery', type: 'image', layout: 'justified' },
  continue: { title: 'Continue watching', type: 'video', layout: 'grid', filter: 'in_progress', sort: 'recent' },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || '', arg: parts[1], params: new URLSearchParams(qs || '') };
}

function hashFor(name, params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const qs = p.toString();
  return `#/${name}${qs ? '?' + qs : ''}`;
}

function navigate(name, params, { replace = false } = {}) {
  const hash = hashFor(name, params);
  if (replace) { history.replaceState(null, '', hash); route(); }
  else if (location.hash === hash) route();
  else location.hash = hash;
}

function teardown() {
  S.cleanup.forEach((fn) => { try { fn(); } catch {} });
  S.cleanup = [];
  S.player = null;
}

async function route() {
  const r = parseHash();
  closeLightbox({ silent: true });
  teardown();
  if (document.body.classList.contains('select-mode')) setSelectMode(false);
  S.route = r;
  $$('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (r.name || 'home')));
  document.body.classList.toggle('watching', r.name === 'watch');
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  if (r.name in LISTINGS) {
    search.set(r.params.get('q') || '');
    return renderListing(r);
  }
  if (r.name === 'watch') return renderWatch(+r.arg);
  if (r.name === 'tags') return renderTagsPage();
  if (r.name === 'settings') return renderSettings();
  navigate('', {}, { replace: true });
}

// ---------------------------------------------------------------------------
// Search bar + sidebar

const search = searchBar({
  onSearch(q) {
    const r = S.route || { name: '' };
    const name = r.name in LISTINGS ? r.name : '';
    const params = name in LISTINGS ? Object.fromEntries(r.params) : {};
    navigate(name, { ...params, q });
  },
});

function renderSidebarTags() {
  const filter = $('#tag-filter').value.trim().toLowerCase();
  const list = $('#tag-list');
  const tags = tagStore.tags.filter((t) => t.count > 0 && (!filter || t.name.toLowerCase().includes(filter)));
  list.replaceChildren(...tags.map((t) => h('a', {
    href: '#', class: 'tag-link', title: `${t.name} — click to filter, right-click to exclude`,
    onclick: (e) => { e.preventDefault(); search.addChip(t.name, e.altKey); },
    oncontextmenu: (e) => { e.preventDefault(); search.addChip(t.name, true); },
  }, h('span', { class: 'dot', style: { '--tag': tagColor(t) } }), h('span', { class: 'tag-link-name' }, t.name), h('span', { class: 'tag-link-count' }, t.count))));
  if (!tags.length) list.append(h('div', { class: 'muted small pad' }, tagStore.tags.length ? 'No matching tags' : 'No tags yet — open any video or image and add some.'));
}
tagStore.subscribe(renderSidebarTags);
$('#tag-filter').addEventListener('input', renderSidebarTags);

$('#menu-btn').addEventListener('click', () => {
  const b = document.body.classList;
  // On the watch page and small screens the sidebar is an overlay; elsewhere it collapses the column.
  if (b.contains('watching') || window.innerWidth <= 900) { b.toggle('sidebar-open'); return; }
  b.toggle('sidebar-collapsed');
  store.set('sidebar.collapsed', b.contains('sidebar-collapsed'));
});
$('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('sidebar-open'); });
if (store.get('sidebar.collapsed', false)) document.body.classList.add('sidebar-collapsed');

$('#theme-btn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
});

// ---------------------------------------------------------------------------
// Scanning status

let scanPoll = null, wasRunning = false;
async function pollScan() {
  clearTimeout(scanPoll);
  let st;
  try { st = await api('/api/scan/status'); } catch { scanPoll = setTimeout(pollScan, 5000); return; }
  const el = $('#scan-status');
  if (st.running) {
    el.hidden = false;
    el.textContent = st.phase === 'thumbnails'
      ? `Thumbnails ${st.thumbs_done}/${st.thumbs_total}`
      : `Scanning… ${st.found} files`;
    wasRunning = true;
    scanPoll = setTimeout(pollScan, 1200);
    $('#rescan-btn').classList.add('spin');
  } else {
    el.hidden = true;
    $('#rescan-btn').classList.remove('spin');
    if (wasRunning) {
      wasRunning = false;
      const bits = [];
      if (st.added) bits.push(`${st.added} new`);
      if (st.moved) bits.push(`${st.moved} moved`);
      if (st.missing) bits.push(`${st.missing} missing`);
      toast(st.error ? `Scan failed: ${st.error}` : `Library updated${bits.length ? ': ' + bits.join(', ') : ''}`, { error: !!st.error });
      tagStore.refresh();
      if (S.route?.name in LISTINGS && S.listing) S.listing.reload(true);
    }
  }
}

$('#rescan-btn').addEventListener('click', async () => {
  try { await api('/api/scan', { method: 'POST' }); pollScan(); }
  catch (e) { toast(e.message, { error: true }); if (/No library/.test(e.message)) navigate('settings'); }
});

// ---------------------------------------------------------------------------
// Listing views (home / videos / gallery / continue watching)

async function renderListing(r) {
  const cfg = LISTINGS[r.name];
  const q = r.params.get('q') || '';
  const sort = r.params.get('sort') || cfg.sort || store.get(`sort.${r.name || 'home'}`, 'newest');
  const type = cfg.type || r.params.get('type') || null;
  const seed = +(r.params.get('seed') || 0) || Math.floor(Math.random() * 1e6) + 1;

  if (!S.settings) S.settings = await api('/api/settings').catch(() => ({ roots: [] }));
  if (!S.settings.roots.length) return renderWelcome();

  const L = S.listing = {
    cfg, q, sort, type, seed, items: [], total: null, loading: false, name: r.name,
    reload: (keep) => { if (keep && L.items.length) refreshLoaded(); else navigate(r.name, Object.fromEntries(r.params), { replace: true }); },
  };

  // Header: title, type chips, popular tags, sort, select.
  const sortSel = h('select', { class: 'select', title: 'Sort', onchange: () => { store.set(`sort.${r.name || 'home'}`, sortSel.value); navigate(r.name, { ...Object.fromEntries(r.params), sort: sortSel.value, seed: sortSel.value === 'random' ? seed : '' }); } },
    [['newest', 'Newest'], ['oldest', 'Oldest'], ['added', 'Recently added'], ['name', 'Name A–Z'], ['name_desc', 'Name Z–A'],
     ['recent', 'Recently watched'], ['most_viewed', 'Most viewed'], ['longest', 'Longest'], ['shortest', 'Shortest'], ['largest', 'Largest'], ['random', 'Shuffle']]
      .map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
  const count = h('span', { class: 'result-count muted' });
  const typeChips = r.name === '' ? h('div', { class: 'chipbar-group' },
    [[null, 'All'], ['video', 'Videos'], ['image', 'Images']].map(([t, l]) => h('button', {
      class: 'pill' + ((type || null) === t ? ' active' : ''),
      onclick: () => navigate('', { ...Object.fromEntries(r.params), type: t || '' }),
    }, l))) : null;
  const tagPills = h('div', { class: 'chipbar-group tag-pills' });
  const renderPills = () => {
    const included = new Set(parseQuery(q).chips.filter((c) => !c.exclude).map((c) => c.name.toLowerCase()));
    tagPills.replaceChildren(...tagStore.tags.filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count).slice(0, 20)
      .map((t) => h('button', {
        class: 'pill' + (included.has(t.name.toLowerCase()) ? ' active' : ''),
        onclick: () => search.addChip(t.name), title: `${t.count} items`,
      }, h('span', { class: 'dot', style: { '--tag': tagColor(t) } }), t.name)));
  };
  renderPills();
  S.cleanup.push(tagStore.subscribe(renderPills));

  const selectBtn = h('button', { class: 'btn ghost', title: 'Select items to tag several at once', onclick: () => setSelectMode(!document.body.classList.contains('select-mode')) }, icon('check'), 'Select');
  const sizeSlider = cfg.layout === 'justified' ? h('input', { type: 'range', class: 'size-slider', min: 120, max: 420, step: 10, value: store.get('gallery.rowHeight', 220), title: 'Thumbnail size',
    oninput: () => { store.set('gallery.rowHeight', +sizeSlider.value); layoutJustified(); } }) : null;

  const container = h('div', { class: cfg.layout === 'justified' ? 'justified' : 'grid' });
  const sentinel = h('div', { class: 'sentinel' }, h('div', { class: 'loader' }));
  const empty = h('div', { class: 'empty', hidden: true });

  view.replaceChildren(h('div', { class: 'listing' },
    h('div', { class: 'chipbar' }, typeChips, tagPills),
    h('div', { class: 'listing-head' },
      h('h1', {}, cfg.title), count, h('div', { class: 'spacer' }), sizeSlider, selectBtn, sortSel),
    container, empty, sentinel));

  async function loadMore() {
    if (L.loading || (L.total != null && L.items.length >= L.total)) return [];
    L.loading = true;
    try {
      const p = new URLSearchParams({ q, sort, offset: L.items.length, limit: PAGE, seed });
      if (type) p.set('type', type);
      if (cfg.filter) p.set('filter', cfg.filter);
      const res = await api(`/api/media?${p}`);
      if (S.listing !== L) return [];
      L.total = res.total;
      L.items.push(...res.items);
      count.textContent = `${res.total.toLocaleString()} ${res.total === 1 ? 'item' : 'items'}`;
      appendCards(res.items);
      sentinel.hidden = L.items.length >= L.total;
      if (!L.total) showEmpty();
      return res.items;
    } catch (e) {
      toast(e.message, { error: true });
      return [];
    } finally {
      L.loading = false;
    }
  }
  L.loadMore = loadMore;

  async function refreshLoaded() {
    // Re-fetch what's already on screen (e.g. after a scan finished) without losing scroll position.
    const p = new URLSearchParams({ q, sort, offset: 0, limit: Math.max(PAGE, L.items.length), seed });
    if (type) p.set('type', type);
    if (cfg.filter) p.set('filter', cfg.filter);
    const res = await api(`/api/media?${p}`).catch(() => null);
    if (!res || S.listing !== L) return;
    L.items = res.items; L.total = res.total;
    container.replaceChildren();
    appendCards(res.items);
    count.textContent = `${res.total.toLocaleString()} items`;
  }

  function showEmpty() {
    empty.hidden = false;
    empty.replaceChildren(
      icon(cfg.type === 'image' ? 'image' : 'video', 'empty-icon'),
      h('h2', {}, q ? 'No results' : cfg.filter ? 'Nothing in progress' : 'Nothing here yet'),
      h('p', { class: 'muted' }, q ? 'Try removing a tag or search term.' : cfg.filter ? 'Videos you stop part-way through show up here.' : 'Add a library folder or rescan to find media.'),
    );
  }

  function appendCards(items) {
    if (cfg.layout === 'justified') {
      container.append(...items.map((it) => galleryTile(it)));
      layoutJustified();
    } else {
      container.append(...items.map((it) => card(it)));
    }
    items.forEach(maybeCaptureThumb);
  }

  function layoutJustified() {
    if (cfg.layout !== 'justified') return;
    const width = container.clientWidth;
    if (!width) return;
    const target = +(store.get('gallery.rowHeight', 220));
    const gap = 6;
    const tiles = [...container.children];
    let row = [];
    let aspectSum = 0;
    const flush = (last) => {
      if (!row.length) return;
      const hgt = last ? Math.min(target, (width - gap * (row.length - 1)) / aspectSum) : (width - gap * (row.length - 1)) / aspectSum;
      row.forEach(({ el, a }) => { el.style.width = `${Math.floor(a * hgt)}px`; el.style.height = `${Math.floor(hgt)}px`; });
      row = []; aspectSum = 0;
    };
    for (const el of tiles) {
      const a = +el.dataset.aspect || 1.5;
      row.push({ el, a });
      aspectSum += a;
      if (aspectSum * target + gap * (row.length - 1) >= width) flush(false);
    }
    flush(true);
  }
  const onResize = debounce(layoutJustified, 100);
  window.addEventListener('resize', onResize);
  S.cleanup.push(() => window.removeEventListener('resize', onResize));
  const ro = new ResizeObserver(onResize);
  ro.observe(container);
  S.cleanup.push(() => ro.disconnect());

  const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '800px' });
  io.observe(sentinel);
  S.cleanup.push(() => io.disconnect());

  // Opening items from this listing
  L.openItem = (item, e) => {
    if (document.body.classList.contains('select-mode') || e?.ctrlKey || e?.metaKey || e?.shiftKey) {
      toggleSelect(item, e);
      return;
    }
    if (item.kind === 'video') {
      S.queue = { items: L.items.filter((i) => i.kind === 'video'), label: cfg.title + (q ? ` · “${q}”` : '') };
      location.hash = `#/watch/${item.id}`;
    } else {
      const images = L.items.filter((i) => i.kind === 'image');
      const imageSource = {
        get items() { return images; },
        index: images.indexOf(item),
        get total() { return type === 'image' ? L.total : images.length + (L.items.length < (L.total || 0) ? 1 : 0); },
        async loadMore() {
          const more = await loadMore();
          images.push(...more.filter((i) => i.kind === 'image'));
        },
      };
      openLightbox(imageSource, lightboxHooks());
    }
  };

  await loadMore();
}

function lightboxHooks() {
  return {
    onTagClick: (t) => search.addChip(t.name),
    onChange: (item) => updateCardTags(item),
    openExternal: (item, reveal) => openExternal(item, reveal),
  };
}

function card(item) {
  const watched = item.kind === 'video' && item.duration && item.position > 5 ? Math.min(100, (item.position / item.duration) * 100) : 0;
  const thumbImg = thumbFor(item);
  const selected = S.selected.has(item.id);
  const el = h('a', {
    class: 'card' + (selected ? ' selected' : '') + (item.kind === 'image' ? ' is-image' : ''),
    href: item.kind === 'video' ? `#/watch/${item.id}` : '#',
    'data-id': item.id,
    onclick: (e) => { e.preventDefault(); S.listing?.openItem(item, e); },
  },
    h('div', { class: 'thumb' },
      thumbImg,
      item.kind === 'video' && item.duration ? h('span', { class: 'badge' }, fmtDuration(item.duration)) : null,
      item.kind === 'image' ? h('span', { class: 'badge badge-icon' }, icon('image')) : null,
      watched ? h('div', { class: 'watched' }, h('div', { style: { width: `${watched}%` } })) : null,
      h('button', { class: 'select-box', title: 'Select', 'aria-label': 'Select', onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(item, e); } }, icon('check')),
    ),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title', title: item.filename }, item.title),
      h('div', { class: 'card-meta' },
        item.folder ? h('span', { class: 'card-folder' }, item.folder) : null,
        h('span', {}, [item.kind === 'image' && item.width ? `${item.width}×${item.height}` : null, item.view_count ? `${item.view_count} view${item.view_count > 1 ? 's' : ''}` : null, fmtAgo(item.mtime)].filter(Boolean).join(' · '))),
      h('div', { class: 'card-tags' }, cardTags(item)),
    ));
  if (item.kind === 'video' && item.browser_playable) attachHoverPreview(el, item);
  return el;
}

function cardTags(item) {
  const tags = item.tags || [];
  return [
    ...tags.slice(0, 4).map((t) => tagChip(t, { small: true, onClick: () => search.addChip(t.name) })),
    tags.length > 4 ? h('span', { class: 'chip small more' }, `+${tags.length - 4}`) : null,
  ];
}

function galleryTile(item) {
  const aspect = item.width && item.height ? item.width / item.height : 1.5;
  const selected = S.selected.has(item.id);
  return h('a', {
    class: 'tile' + (selected ? ' selected' : ''), href: '#', 'data-id': item.id, 'data-aspect': aspect.toFixed(4),
    title: item.filename + (item.tags?.length ? '\n' + item.tags.map((t) => '#' + t.name).join(' ') : ''),
    onclick: (e) => { e.preventDefault(); S.listing?.openItem(item, e); },
  },
    thumbFor(item),
    h('div', { class: 'tile-overlay' },
      h('div', { class: 'tile-name' }, item.title),
      h('div', { class: 'card-tags' }, cardTags(item))),
    h('button', { class: 'select-box', title: 'Select', onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(item, e); } }, icon('check')));
}

function thumbFor(item) {
  if (item.thumb) return h('img', { src: item.thumb, loading: 'lazy', alt: '', decoding: 'async' });
  if (item.kind === 'image' && item.thumb_state === 'failed') return h('img', { src: item.url, loading: 'lazy', alt: '' });
  return h('div', { class: 'thumb-placeholder' }, icon(item.kind === 'image' ? 'image' : 'video'));
}

function attachHoverPreview(el, item) {
  let timer, vid;
  el.addEventListener('mouseenter', () => {
    timer = setTimeout(() => {
      const start = item.position > 5 ? item.position : (item.duration ? item.duration * 0.1 : 0);
      vid = h('video', { class: 'hover-preview', src: `${item.url}#t=${start.toFixed(1)}`, muted: true, autoplay: true, loop: true, playsinline: true, preload: 'auto' });
      vid.muted = true;
      vid.addEventListener('playing', () => vid.classList.add('show'));
      el.querySelector('.thumb').append(vid);
    }, 700);
  });
  el.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); vid = null; }
  });
}

function updateCardTags(item) {
  for (const list of [S.listing?.items, S.queue?.items]) {
    const found = list?.find((i) => i.id === item.id);
    if (found && found !== item) found.tags = item.tags;
  }
  $$(`[data-id="${item.id}"] .card-tags`).forEach((el) => el.replaceChildren(...cardTags(item)));
}

// ---------------------------------------------------------------------------
// Multi-select + bulk tagging

let lastSelected = null;
function setSelectMode(on) {
  document.body.classList.toggle('select-mode', on);
  if (!on) { S.selected.clear(); $$('.card.selected, .tile.selected').forEach((c) => c.classList.remove('selected')); }
  updateBulkbar();
}

function toggleSelect(item, e) {
  const items = S.listing?.items || [];
  if (e?.shiftKey && lastSelected != null) {
    const a = items.findIndex((i) => i.id === lastSelected), b = items.findIndex((i) => i.id === item.id);
    if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selected.add(items[i].id);
  } else if (S.selected.has(item.id)) S.selected.delete(item.id);
  else S.selected.add(item.id);
  lastSelected = item.id;
  document.body.classList.add('select-mode');
  $$('[data-id]').forEach((c) => c.classList.toggle('selected', S.selected.has(+c.dataset.id)));
  updateBulkbar();
}

const bulkInput = h('input', { type: 'text', placeholder: 'Tag name…', autocomplete: 'off', spellcheck: false });
const bulkSuggest = h('div', { class: 'suggest up', hidden: true });
$('#bulk-tagger').append(bulkInput, bulkSuggest);
autocomplete(bulkInput, bulkSuggest, { suggestions: (t) => tagStore.suggest(t), onPick: (name) => { bulkInput.value = name; } });
bulkInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && bulkSuggest.hidden) bulkApply('add'); });

function updateBulkbar() {
  const n = S.selected.size;
  $('#bulkbar').hidden = !document.body.classList.contains('select-mode');
  $('#bulk-count').textContent = n ? `${n} selected` : 'Click items to select (Shift-click for a range)';
}

async function bulkApply(mode) {
  const name = bulkInput.value.trim();
  if (!name) { bulkInput.focus(); return; }
  if (!S.selected.size) { toast('Select some items first'); return; }
  try {
    const res = await api('/api/media/bulk-tags', { method: 'POST', body: { ids: [...S.selected], [mode]: [name] } });
    for (const [id, tags] of Object.entries(res.tags)) {
      const item = S.listing?.items.find((i) => i.id === +id);
      if (item) { item.tags = tags; updateCardTags(item); }
    }
    toast(`${mode === 'add' ? 'Added' : 'Removed'} “${name}” ${mode === 'add' ? 'to' : 'from'} ${S.selected.size} item(s)`);
    bulkInput.value = '';
    tagStore.refresh();
  } catch (e) { toast(e.message, { error: true }); }
}
$('#bulk-add').addEventListener('click', () => bulkApply('add'));
$('#bulk-remove').addEventListener('click', () => bulkApply('remove'));
$('#bulk-clear').addEventListener('click', () => setSelectMode(false));
$('#bulk-all').addEventListener('click', () => {
  (S.listing?.items || []).forEach((i) => S.selected.add(i.id));
  $$('[data-id]').forEach((c) => c.classList.toggle('selected', S.selected.has(+c.dataset.id)));
  updateBulkbar();
});

// ---------------------------------------------------------------------------
// Browser-side thumbnail fallback (used when ffmpeg couldn't make one)

const captureQueue = [];
let capturing = 0;
function maybeCaptureThumb(item) {
  if (item.kind !== 'video' || item.thumb || item.thumb_state !== 'failed' || !item.browser_playable || item._capturing) return;
  item._capturing = true;
  captureQueue.push(item);
  pumpCapture();
}
function pumpCapture() {
  while (capturing < 2 && captureQueue.length) {
    const item = captureQueue.shift();
    capturing++;
    captureFrame(item).finally(() => { capturing--; pumpCapture(); });
  }
}
function captureFrame(item) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const done = () => { v.removeAttribute('src'); v.load(); resolve(); };
    const timeout = setTimeout(done, 20000);
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(60, (v.duration || 0) * 0.1); });
    v.addEventListener('seeked', () => {
      try {
        const w = 480, hgt = Math.round((v.videoHeight / v.videoWidth) * w) || 270;
        const c = document.createElement('canvas');
        c.width = w; c.height = hgt;
        c.getContext('2d').drawImage(v, 0, 0, w, hgt);
        c.toBlob(async (blob) => {
          clearTimeout(timeout);
          if (blob) {
            try {
              const res = await api(`/api/media/${item.id}/thumb`, {
                method: 'POST', raw: true, body: blob,
                headers: { 'Content-Type': 'image/jpeg', 'X-Duration': String(v.duration || ''), 'X-Width': String(v.videoWidth), 'X-Height': String(v.videoHeight) },
              });
              Object.assign(item, { thumb: res.thumb, duration: res.duration, width: res.width, height: res.height, thumb_state: 'ok' });
              $$(`[data-id="${item.id}"] .thumb-placeholder`).forEach((ph) => ph.replaceWith(h('img', { src: res.thumb, alt: '' })));
            } catch {}
          }
          done();
        }, 'image/jpeg', 0.82);
      } catch { clearTimeout(timeout); done(); }
    }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timeout); done(); }, { once: true });
    v.src = item.url;
  });
}

// ---------------------------------------------------------------------------
// Watch page

async function renderWatch(id) {
  view.replaceChildren(h('div', { class: 'loader center' }));
  let item;
  try { item = await api(`/api/media/${id}`); }
  catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Not found'), h('p', { class: 'muted' }, e.message))); return; }
  if (S.route?.name !== 'watch' || +S.route.arg !== id) return;

  if (item.kind === 'image') {
    // Images open in the lightbox; show it over the related grid.
    const images = [item, ...item.related.filter((r) => r.kind === 'image')];
    view.replaceChildren(h('div', { class: 'listing' }, h('h1', {}, item.title)));
    openLightbox({ items: images, index: 0 }, { ...lightboxHooks(), onClose: () => history.length > 1 ? history.back() : navigate('gallery') });
    return;
  }

  const theater = store.get('player.theater', false);
  const page = h('div', { class: 'watch' + (theater ? ' theater' : '') });

  // Up next: rest of the listing the video was opened from, then related videos.
  const queue = S.queue?.items || [];
  const qi = queue.findIndex((i) => i.id === id);
  const upNext = [];
  const seen = new Set([id]);
  if (qi >= 0) for (const i of queue.slice(qi + 1, qi + 26)) { upNext.push(i); seen.add(i.id); }
  for (const r of item.related) if (!seen.has(r.id)) { upNext.push(r); seen.add(r.id); }
  const prevItem = qi > 0 ? queue[qi - 1] : null;
  const nextItem = upNext.find((i) => i.kind === 'video');

  const openExt = () => openExternal(item);
  const player = createPlayer(item, {
    onPrev: prevItem ? () => { location.hash = `#/watch/${prevItem.id}`; } : null,
    onNext: nextItem ? () => { location.hash = `#/watch/${nextItem.id}`; } : null,
    onEnded: nextItem ? () => { history.replaceState(null, '', `#/watch/${nextItem.id}`); route(); } : null,
    onTheater: () => { page.classList.toggle('theater'); store.set('player.theater', page.classList.contains('theater')); },
    onOpenExternal: openExt,
  });
  S.player = player;
  S.cleanup.push(() => player.destroy());

  const editor = tagEditor(item, { onChange: updateCardTags, onTagClick: (t) => { navigate('', { q: `tag:${t.name.includes(' ') ? `"${t.name}"` : t.name}` }); } });
  const infoRow = (k, v) => v ? h('span', {}, h('b', {}, k), ' ', v) : null;

  const main = h('div', { class: 'watch-main' },
    h('div', { class: 'player-wrap' }, player.el),
    h('h1', { class: 'watch-title' }, item.title),
    h('div', { class: 'watch-bar' },
      h('div', { class: 'watch-stats muted' },
        `${(item.view_count + 1).toLocaleString()} view${item.view_count ? 's' : ''} · ${fmtDate(item.mtime)}`),
      h('div', { class: 'watch-actions' },
        h('button', { class: 'btn', onclick: () => openExternal(item) }, icon('external'), 'Open externally'),
        h('button', { class: 'btn', onclick: () => openExternal(item, true) }, icon('folder'), 'Show in folder'),
        h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(item.path); toast('Path copied'); } }, icon('copy'), 'Copy path'),
      )),
    h('div', { class: 'watch-desc' },
      h('div', { class: 'label' }, icon('tag'), 'Tags'),
      editor,
      h('div', { class: 'watch-meta muted' },
        infoRow('Duration', fmtDuration(item.duration)),
        infoRow('Resolution', item.width ? `${item.width}×${item.height}` : ''),
        infoRow('Size', fmtSize(item.size)),
        infoRow('Format', item.ext.replace('.', '').toUpperCase()),
        infoRow('Folder', item.folder || '/')),
      h('div', { class: 'watch-path muted small', title: item.path }, item.path)),
  );

  const side = h('aside', { class: 'watch-side' },
    h('div', { class: 'side-head' }, h('span', {}, 'Up next'), S.queue && qi >= 0 ? h('span', { class: 'muted small' }, S.queue.label) : null),
    ...upNext.slice(0, 40).map((it) => compactCard(it)),
    upNext.length ? null : h('p', { class: 'muted small' }, 'Tag this video to get related suggestions here.'));

  page.append(main, side);
  view.replaceChildren(page);
  document.title = `${item.title} — Media Library`;
  S.cleanup.push(() => { document.title = 'Media Library'; });

  if (!item.missing) {
    api(`/api/media/${id}/view`, { method: 'POST' }).catch(() => {});
    player.play();
  }
  player.el.focus({ preventScroll: true });

  const onKey = (e) => {
    if (isLightboxOpen()) return;
    if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); search.focus(); return; }
    if (e.key === 'g' && !e.target.closest('input, textarea')) { e.preventDefault(); editor.focusInput(); return; }
    player.onKey(e);
  };
  document.addEventListener('keydown', onKey);
  S.cleanup.push(() => document.removeEventListener('keydown', onKey));
}

function compactCard(it) {
  const watched = it.kind === 'video' && it.duration && it.position > 5 ? Math.min(100, (it.position / it.duration) * 100) : 0;
  return h('a', {
    class: 'compact', href: `#/watch/${it.id}`, 'data-id': it.id,
    onclick: (e) => {
      if (it.kind === 'image') { e.preventDefault(); openLightbox({ items: [it], index: 0 }, lightboxHooks()); }
    },
  },
    h('div', { class: 'thumb' }, thumbFor(it),
      it.duration ? h('span', { class: 'badge' }, fmtDuration(it.duration)) : null,
      it.kind === 'image' ? h('span', { class: 'badge badge-icon' }, icon('image')) : null,
      watched ? h('div', { class: 'watched' }, h('div', { style: { width: `${watched}%` } })) : null),
    h('div', { class: 'compact-body' },
      h('div', { class: 'card-title' }, it.title),
      h('div', { class: 'card-meta' }, it.folder || ''),
      h('div', { class: 'card-tags' }, cardTags(it))));
}

async function openExternal(item, reveal = false) {
  try { await api(`/api/media/${item.id}/open`, { method: 'POST', body: { reveal } }); }
  catch (e) { toast(e.message, { error: true }); }
}

// ---------------------------------------------------------------------------
// Tag manager

async function renderTagsPage() {
  await tagStore.refresh();
  let sortBy = store.get('tags.sort', 'name');
  let filter = '';
  const body = h('tbody');
  const filterInput = h('input', { type: 'search', class: 'input', placeholder: 'Filter tags…', oninput: () => { filter = filterInput.value.toLowerCase(); render(); } });
  const newInput = h('input', { type: 'text', class: 'input', placeholder: 'New tag name', onkeydown: (e) => { if (e.key === 'Enter') create(); } });

  async function create() {
    const name = newInput.value.trim();
    if (!name) return;
    try { await api('/api/tags', { method: 'POST', body: { name } }); newInput.value = ''; await tagStore.refresh(); }
    catch (e) { toast(e.message, { error: true }); }
  }

  function render() {
    const tags = tagStore.tags.filter((t) => !filter || t.name.toLowerCase().includes(filter))
      .sort((a, b) => sortBy === 'count' ? b.count - a.count || a.name.localeCompare(b.name) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    body.replaceChildren(...tags.map((t) => {
      const color = h('input', { type: 'color', class: 'color-input', value: toHex(tagColor(t)), title: 'Tag colour',
        onchange: async () => { await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { color: color.value } }).catch((e) => toast(e.message, { error: true })); tagStore.refresh(); } });
      const name = h('input', { type: 'text', class: 'input inline', value: t.name,
        onkeydown: (e) => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = t.name; name.blur(); } },
        onchange: async () => {
          const newName = name.value.trim();
          if (!newName || newName === t.name) { name.value = t.name; return; }
          const other = tagStore.byName(newName);
          if (other && other.id !== t.id && !confirm(`“${other.name}” already exists. Merge “${t.name}” into it?`)) { name.value = t.name; return; }
          try { await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { name: newName } }); toast(other && other.id !== t.id ? 'Tags merged' : 'Tag renamed'); }
          catch (e) { toast(e.message, { error: true }); name.value = t.name; }
          tagStore.refresh();
        } });
      return h('tr', {},
        h('td', {}, color),
        h('td', {}, name),
        h('td', { class: 'num' }, t.videos),
        h('td', { class: 'num' }, t.images),
        h('td', { class: 'actions' },
          h('a', { class: 'btn ghost', href: hashFor('', { q: `tag:${t.name.includes(' ') ? `"${t.name}"` : t.name}` }) }, 'View'),
          t.color ? h('button', { class: 'btn ghost', title: 'Use automatic colour', onclick: async () => { await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { color: null } }); tagStore.refresh(); } }, 'Reset colour') : null,
          h('button', { class: 'btn ghost danger', onclick: async () => {
            if (!confirm(`Delete tag “${t.name}”? It will be removed from ${t.count} item(s).`)) return;
            await api(`/api/tags/${t.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, { error: true }));
            tagStore.refresh();
          } }, 'Delete')));
    }));
    if (!tags.length) body.append(h('tr', {}, h('td', { colspan: 5, class: 'muted pad' }, tagStore.tags.length ? 'No matching tags.' : 'No tags yet. Tags you add to videos and images appear here.')));
  }

  const sortSel = h('select', { class: 'select', onchange: () => { sortBy = sortSel.value; store.set('tags.sort', sortBy); render(); } },
    h('option', { value: 'name', selected: sortBy === 'name' }, 'Sort by name'), h('option', { value: 'count', selected: sortBy === 'count' }, 'Sort by usage'));

  view.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Manage tags'),
    h('p', { class: 'muted' }, 'Rename a tag to an existing name to merge them. Tags are stored in the library database and survive restarts and rescans.'),
    h('div', { class: 'toolbar' }, filterInput, sortSel, h('div', { class: 'spacer' }), newInput, h('button', { class: 'btn primary', onclick: create }, 'Create tag')),
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', { class: 'num' }, 'Videos'), h('th', { class: 'num' }, 'Images'), h('th', {}, ''))),
      body)));
  render();
  S.cleanup.push(tagStore.subscribe(render));
}

function toHex(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = color;
  const v = c.fillStyle;
  if (v.startsWith('#')) return v;
  const m = v.match(/\d+/g);
  return m ? '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('') : '#888888';
}

// ---------------------------------------------------------------------------
// Settings / welcome

function rootsEditor(roots, onSaved) {
  const list = h('div', { class: 'roots' });
  const input = h('input', { type: 'text', class: 'input grow', placeholder: 'e.g. D:\\Videos  or  C:\\Users\\me\\Pictures', onkeydown: (e) => { if (e.key === 'Enter') add(); } });
  let current = [...roots];

  function render() {
    list.replaceChildren(...current.map((r, i) => h('div', { class: 'root-row' }, icon('folder'), h('span', { class: 'grow' }, r),
      h('button', { class: 'btn ghost danger', onclick: () => { current.splice(i, 1); save(); } }, 'Remove'))));
    if (!current.length) list.append(h('div', { class: 'muted pad' }, 'No folders yet.'));
  }
  async function save() {
    try {
      S.settings = await api('/api/settings', { method: 'PUT', body: { roots: current } });
      current = [...S.settings.roots];
      render();
      pollScan();
      onSaved?.();
    } catch (e) { toast(e.message, { error: true }); current = [...(S.settings?.roots || [])]; render(); }
  }
  function add() {
    const v = input.value.trim().replace(/^"|"$/g, '');
    if (!v) return;
    current.push(v);
    input.value = '';
    save();
  }
  render();
  return h('div', {}, list, h('div', { class: 'toolbar' }, input, h('button', { class: 'btn primary', onclick: add }, 'Add folder')));
}

async function renderSettings() {
  S.settings = await api('/api/settings');
  const stats = await api('/api/stats');
  view.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Library folders'),
    h('p', { class: 'muted' }, 'All videos and images inside these folders (including sub-folders) are added to the library. Paste the full folder path.'),
    rootsEditor(S.settings.roots),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => $('#rescan-btn').click() }, 'Rescan now')),
    h('h2', {}, 'Library'),
    h('div', { class: 'stats' },
      stat('Videos', stats.videos), stat('Images', stats.images), stat('Tags', stats.tags), stat('Total size', fmtSize(stats.bytes)),
      stats.missing ? stat('Missing files', stats.missing) : null),
    h('h2', {}, 'About'),
    h('p', { class: 'muted' }, `Data (tags, thumbnails) stored in: `, h('code', {}, S.settings.data_dir)),
    h('p', { class: 'muted' }, `Video thumbnails: ${S.settings.ffmpeg ? 'ffmpeg (bundled)' : 'browser fallback — ffmpeg not available'}`),
    h('h2', {}, 'Keyboard shortcuts'),
    h('div', { class: 'shortcuts' },
      ...[['/', 'Focus search'], ['Space / K', 'Play / pause'], ['← / →', 'Seek 5s (video) · prev/next (image)'], ['J / L', 'Seek 10s'], ['↑ / ↓', 'Volume'],
        ['M', 'Mute'], ['F', 'Fullscreen'], ['T', 'Theater mode (video) · tag image (lightbox)'], ['I', 'Picture-in-picture · info panel (lightbox)'], ['< / >', 'Playback speed'],
        ['0–9', 'Jump to 0–90%'], ['G', 'Add a tag (watch page)'], ['Shift+N / Shift+P', 'Next / previous video'], ['S', 'Slideshow (lightbox)'], ['+ / − / 0', 'Zoom (lightbox)'], ['Esc', 'Close lightbox']]
        .map(([k, d]) => h('div', { class: 'shortcut' }, h('kbd', {}, k), h('span', {}, d))))));
}

function stat(label, value) { return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, String(value ?? 0)), h('div', { class: 'stat-label muted' }, label)); }

function renderWelcome() {
  view.replaceChildren(h('div', { class: 'page welcome' },
    icon('video', 'empty-icon'),
    h('h1', {}, 'Welcome to your media library'),
    h('p', { class: 'muted' }, 'Add a folder that contains your videos and images. It is scanned recursively; nothing is moved or modified.'),
    rootsEditor([], () => navigate('', {}, { replace: true }))));
}

// ---------------------------------------------------------------------------
// Global keys + boot

document.addEventListener('keydown', (e) => {
  if (S.route?.name === 'watch' || isLightboxOpen()) return;
  if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); search.focus(); }
  if (e.key === 'Escape' && document.body.classList.contains('select-mode') && !e.target.closest('input')) setSelectMode(false);
});

window.addEventListener('hashchange', route);
tagStore.refresh();
pollScan();
route();
