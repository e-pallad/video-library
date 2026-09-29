// Fullscreen image viewer: prev/next, zoom & pan, slideshow, filmstrip and an info/tag panel.

import { $, api, fmtDate, fmtSize, h, icon, store } from './util.js';
import { tagEditor } from './tags.js';

let state = null;

export function isLightboxOpen() { return !!state; }

/**
 * @param {object} source  { items: [...], index, total, loadMore: async () => newItems[] }
 * @param {object} hooks   { onTagClick(tag), onChange(item), openExternal(item, reveal) }
 */
export function openLightbox(source, hooks = {}) {
  closeLightbox();
  const root = $('#lightbox');
  root.hidden = false;
  document.body.classList.add('no-scroll');

  const img = h('img', { class: 'lb-img', draggable: false, alt: '' });
  const stage = h('div', { class: 'lb-stage' }, img);
  const counter = h('span', { class: 'lb-counter' });
  const title = h('span', { class: 'lb-title' });
  const zoomLabel = h('span', { class: 'lb-zoom' });
  const btn = (name, label, fn, cls = '') => h('button', { class: 'lb-btn ' + cls, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name));
  const playBtn = btn('slideshow', 'Slideshow (s)', () => toggleSlideshow());
  const intervalSel = h('select', { class: 'lb-interval', title: 'Slideshow interval', onchange: () => { store.set('lb.interval', +intervalSel.value); if (state.timer) { stopSlideshow(); startSlideshow(); } } },
    [2, 3, 5, 8, 12, 20].map((s) => h('option', { value: s }, `${s}s`)));
  intervalSel.value = store.get('lb.interval', 5);
  const infoBtn = btn('info', 'Info & tags (i)', () => toggleInfo());

  const top = h('div', { class: 'lb-top' },
    h('div', { class: 'lb-top-left' }, counter, title),
    h('div', { class: 'lb-top-right' },
      zoomLabel,
      btn('zoomOut', 'Zoom out (-)', () => zoomBy(1 / 1.4)),
      btn('fit', 'Fit to screen (0)', () => resetZoom()),
      btn('zoomIn', 'Zoom in (+)', () => zoomBy(1.4)),
      h('span', { class: 'lb-sep' }),
      playBtn, intervalSel,
      infoBtn,
      btn('external', 'Open in default app', () => hooks.openExternal?.(cur())),
      btn('close', 'Close (Esc)', () => closeLightbox()),
    ));
  const prevBtn = btn('left', 'Previous (←)', () => go(-1), 'lb-nav lb-prev');
  const nextBtn = btn('right', 'Next (→)', () => go(1), 'lb-nav lb-next');
  const strip = h('div', { class: 'lb-strip' });
  const panel = h('aside', { class: 'lb-panel' });
  const progress = h('div', { class: 'lb-progress' });

  root.replaceChildren(h('div', { class: 'lb-main' }, top, stage, prevBtn, nextBtn, strip, progress), panel);

  state = {
    source, hooks, root, img, stage, panel, strip, counter, title, zoomLabel, playBtn, intervalSel, progress, prevBtn, nextBtn,
    index: source.index || 0, scale: 1, x: 0, y: 0, timer: null, info: store.get('lb.info', false), loading: false,
    cleanup: [],
  };
  root.classList.toggle('with-info', state.info);
  infoBtn.classList.toggle('on', state.info);

  // -- zoom & pan --------------------------------------------------------
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (state.scale > 1.01) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY);
  });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y, moved: false, target: e.target };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (state.scale > 1.01) { state.x = drag.ox + dx; state.y = drag.oy + dy; applyTransform(false); }
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    // Swipe to navigate when not zoomed.
    if (state.scale <= 1.01 && Math.abs(dx) > 60 && e.pointerType !== 'mouse') go(dx < 0 ? 1 : -1);
    else if (state.scale <= 1.01 && !drag.moved && drag.target === stage) closeLightbox();
    drag = null;
  });

  const onKey = (e) => {
    if (!state || e.target.closest('input, textarea, select')) return;
    const k = e.key;
    if (k === 'Escape') closeLightbox();
    else if (k === 'ArrowRight' || k === 'PageDown') go(1);
    else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
    else if (k === 'Home') show(0);
    else if (k === '+' || k === '=') zoomBy(1.4);
    else if (k === '-' || k === '_') zoomBy(1 / 1.4);
    else if (k === '0') resetZoom();
    else if (k === 's' || k === 'S' || k === ' ') toggleSlideshow();
    else if (k === 'i' || k === 'I') toggleInfo();
    else if (k === 't' || k === 'T') { if (!state.info) toggleInfo(); setTimeout(() => state?.editor?.focusInput(), 50); }
    else if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen().catch(() => {}); }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener('keydown', onKey, true);
  const onResize = () => applyTransform(false);
  window.addEventListener('resize', onResize);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey, true), () => window.removeEventListener('resize', onResize));

  show(state.index);
}

export function closeLightbox({ silent = false } = {}) {
  if (!state) return;
  stopSlideshow();
  state.cleanup.forEach((fn) => fn());
  if (document.fullscreenElement === state.root) document.exitFullscreen().catch(() => {});
  state.root.hidden = true;
  state.root.replaceChildren();
  const { onClose } = state.hooks;
  state = null;
  if (!silent) onClose?.();
  document.body.classList.remove('no-scroll');
}

const cur = () => state.source.items[state.index];

async function go(delta) {
  if (!state) return;
  let i = state.index + delta;
  const items = state.source.items;
  if (i >= items.length) {
    if (state.source.loadMore && items.length < (state.source.total ?? Infinity) && !state.loading) {
      state.loading = true;
      try { await state.source.loadMore(); } finally { if (state) state.loading = false; }
      if (!state) return;
    }
    if (i >= state.source.items.length) {
      if (state.timer) i = 0; else return; // slideshow wraps around
    }
  }
  if (i < 0) return;
  show(i);
}

function show(i) {
  const s = state;
  s.index = i;
  const item = cur();
  s.scale = 1; s.x = 0; s.y = 0;
  s.img.classList.add('loading');
  s.img.onload = () => { s.img.classList.remove('loading'); applyTransform(false); };
  // Show the cached thumbnail instantly, then swap in the full image.
  if (item.thumb) {
    s.img.src = item.thumb;
    const full = new Image();
    full.onload = () => { if (state === s && cur() === item) s.img.src = full.src; };
    full.src = item.url;
  } else {
    s.img.src = item.url;
  }
  s.img.alt = item.title;
  s.counter.textContent = `${i + 1} / ${s.source.total ?? s.source.items.length}`;
  s.title.textContent = item.filename;
  s.prevBtn.disabled = i === 0;
  s.nextBtn.disabled = i >= (s.source.total ?? s.source.items.length) - 1;
  applyTransform(false);
  renderStrip();
  renderPanel();
  // Preload neighbours.
  for (const j of [i + 1, i - 1, i + 2]) {
    const n = s.source.items[j];
    if (n) new Image().src = n.url;
  }
  api(`/api/media/${item.id}/view`, { method: 'POST' }).catch(() => {});
  if (s.timer) restartProgress();
}

function renderStrip() {
  const s = state, items = s.source.items;
  const from = Math.max(0, s.index - 15), to = Math.min(items.length, s.index + 16);
  s.strip.replaceChildren(...items.slice(from, to).map((it, k) => {
    const j = from + k;
    return h('button', { class: 'lb-thumb' + (j === s.index ? ' active' : ''), title: it.filename, onclick: (e) => { e.stopPropagation(); show(j); } },
      h('img', { src: it.thumb || it.url, loading: 'lazy', alt: '' }));
  }));
  s.strip.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderPanel() {
  const s = state, item = cur();
  if (!s.info) { s.panel.replaceChildren(); return; }
  s.editor = tagEditor(item, { onChange: (it) => s.hooks.onChange?.(it), onTagClick: (t) => { closeLightbox(); s.hooks.onTagClick?.(t); } });
  const row = (k, v) => v ? h('div', { class: 'lb-meta-row' }, h('span', {}, k), h('span', {}, v)) : null;
  s.panel.replaceChildren(
    h('h3', { class: 'lb-panel-title' }, item.title),
    h('div', { class: 'lb-panel-section' }, h('div', { class: 'label' }, 'Tags'), s.editor),
    h('div', { class: 'lb-panel-section lb-meta' },
      row('Dimensions', item.width ? `${item.width} × ${item.height}` : ''),
      row('Size', fmtSize(item.size)),
      row('Modified', fmtDate(item.mtime)),
      row('Folder', item.folder || '/'),
      row('Type', item.ext.replace('.', '').toUpperCase()),
      row('Views', String(item.view_count + 1)),
    ),
    h('div', { class: 'lb-panel-actions' },
      h('button', { class: 'btn', onclick: () => s.hooks.openExternal?.(item, true) }, icon('folder'), 'Show in folder'),
    ),
  );
}

function toggleInfo() {
  state.info = !state.info;
  store.set('lb.info', state.info);
  state.root.classList.toggle('with-info', state.info);
  state.root.querySelector('[title^="Info"]')?.classList.toggle('on', state.info);
  renderPanel();
  setTimeout(() => applyTransform(false), 220);
}

// -- zoom helpers -----------------------------------------------------------

function applyTransform(animate = true) {
  const s = state;
  if (!s) return;
  s.img.style.transition = animate ? 'transform .15s ease-out' : 'none';
  // Keep the image from being dragged completely off-screen.
  const r = s.stage.getBoundingClientRect();
  const iw = s.img.offsetWidth * s.scale, ih = s.img.offsetHeight * s.scale;
  const maxX = Math.max(0, (iw - r.width) / 2), maxY = Math.max(0, (ih - r.height) / 2);
  s.x = Math.max(-maxX, Math.min(maxX, s.x));
  s.y = Math.max(-maxY, Math.min(maxY, s.y));
  s.img.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`;
  s.stage.classList.toggle('zoomed', s.scale > 1.01);
  s.zoomLabel.textContent = s.scale > 1.01 ? `${Math.round(s.scale * 100)}%` : '';
}

function zoomAt(factor, cx, cy) {
  const s = state;
  const next = Math.max(1, Math.min(10, s.scale * factor));
  const r = s.stage.getBoundingClientRect();
  // Zoom around the cursor: keep the point under the pointer fixed.
  const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
  const k = next / s.scale;
  s.x = px - (px - s.x) * k;
  s.y = py - (py - s.y) * k;
  s.scale = next;
  if (next === 1) { s.x = 0; s.y = 0; }
  applyTransform();
}

function zoomBy(f) {
  const r = state.stage.getBoundingClientRect();
  zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
}

function resetZoom() { state.scale = 1; state.x = 0; state.y = 0; applyTransform(); }

// -- slideshow ----------------------------------------------------------------

function toggleSlideshow() { state.timer ? stopSlideshow() : startSlideshow(); }

function startSlideshow() {
  const s = state;
  const ms = +s.intervalSel.value * 1000;
  s.timer = setInterval(() => go(1), ms);
  s.playBtn.classList.add('on');
  s.root.classList.add('playing');
  restartProgress();
}

function restartProgress() {
  const s = state;
  s.progress.style.transition = 'none';
  s.progress.style.width = '0';
  void s.progress.offsetWidth;
  s.progress.style.transition = `width ${+s.intervalSel.value}s linear`;
  s.progress.style.width = '100%';
  clearInterval(s.timer);
  s.timer = setInterval(() => go(1), +s.intervalSel.value * 1000);
}

function stopSlideshow() {
  const s = state;
  if (!s || !s.timer) return;
  clearInterval(s.timer);
  s.timer = null;
  s.playBtn.classList.remove('on');
  s.root.classList.remove('playing');
  s.progress.style.transition = 'none';
  s.progress.style.width = '0';
}
