// Tag store, autocomplete, the reusable tag editor and the search bar.

import { $, api, h, icon, tagColor, toast, quoteTag } from './util.js';

// ---------------------------------------------------------------------------
// Global list of tags (reused everywhere for autocomplete + sidebar)

export const tagStore = {
  tags: [],
  listeners: new Set(),
  async refresh() {
    try { this.tags = await api('/api/tags'); } catch { return; }
    this.listeners.forEach((fn) => fn(this.tags));
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  byName(name) { const n = name.toLowerCase(); return this.tags.find((t) => t.name.toLowerCase() === n); },
  suggest(text, exclude = []) {
    const q = text.trim().toLowerCase();
    const ex = new Set(exclude.map((e) => e.toLowerCase()));
    return this.tags
      .filter((t) => !ex.has(t.name.toLowerCase()) && (!q || t.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1, bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || b.count - a.count || a.name.localeCompare(b.name);
      })
      .slice(0, 12);
  },
};

export function tagChip(tag, { onRemove, onClick, exclude = false, small = false } = {}) {
  const chip = h('span', {
    class: 'chip' + (exclude ? ' exclude' : '') + (small ? ' small' : '') + (onClick ? ' clickable' : ''),
    style: { '--tag': tagColor(tag) },
    title: exclude ? `Excluding "${tag.name}"` : tag.name,
    onclick: onClick ? (e) => { e.stopPropagation(); e.preventDefault(); onClick(e); } : null,
  }, h('span', { class: 'dot' }), exclude ? '−' : null, tag.name);
  if (onRemove) {
    chip.append(h('button', {
      class: 'chip-x', title: 'Remove', 'aria-label': `Remove ${tag.name}`,
      onclick: (e) => { e.stopPropagation(); e.preventDefault(); onRemove(); },
    }, '×'));
  }
  return chip;
}

// ---------------------------------------------------------------------------
// Autocomplete dropdown attached to an <input>

export function autocomplete(input, dropdown, { suggestions, onPick, allowCreate = true, autoSelect = 'exact' }) {
  let items = [], active = -1;

  function render() {
    const text = input.value.trim();
    items = suggestions(text).map((t) => ({ tag: t, name: t.name }));
    if (allowCreate && text && !items.some((i) => i.name.toLowerCase() === text.toLowerCase())
        && !tagStore.byName(text)) {
      items.push({ name: text, create: true });
    }
    // 'exact': Enter keeps what was typed unless it exactly matches a tag; 'first': Enter takes the top hit.
    active = !text ? -1 : autoSelect === 'first' ? (items.length ? 0 : -1)
      : items.findIndex((i) => !i.create && i.name.toLowerCase() === text.toLowerCase());
    dropdown.replaceChildren(...items.map((it, i) => h('div', {
      class: 'suggest-item' + (i === active ? ' active' : ''),
      onmousedown: (e) => { e.preventDefault(); pick(i, e); },
    },
      it.create ? h('span', { class: 'suggest-new' }, '+ Create tag ') : h('span', { class: 'dot', style: { '--tag': tagColor(it.tag) } }),
      h('span', { class: 'suggest-name' }, it.name),
      it.tag ? h('span', { class: 'suggest-count' }, it.tag.count) : null,
    )));
    dropdown.hidden = !items.length || document.activeElement !== input;
  }

  function highlight() {
    [...dropdown.children].forEach((c, i) => c.classList.toggle('active', i === active));
    dropdown.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i, e) {
    const it = items[i];
    if (!it) return;
    onPick(it.name, e);
    input.value = '';
    render();
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 120));
  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(-1, active - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'Escape') { dropdown.hidden = true; e.stopPropagation(); }
  });

  return {
    get active() { return dropdown.hidden ? null : items[active] || null; },
    pickActive(e) { if (!dropdown.hidden && items[active]) { pick(active, e); return true; } return false; },
    refresh: render,
    close() { dropdown.hidden = true; },
  };
}

// ---------------------------------------------------------------------------
// Tag editor for one media item

export function tagEditor(item, { onChange, onTagClick } = {}) {
  const chips = h('div', { class: 'tag-editor-chips' });
  const input = h('input', { class: 'tag-input', type: 'text', placeholder: 'Add a tag…', autocomplete: 'off', spellcheck: false });
  const dropdown = h('div', { class: 'suggest', hidden: true });
  const root = h('div', { class: 'tag-editor' }, chips, h('div', { class: 'tag-input-wrap' }, input, dropdown));
  let saving = Promise.resolve();

  const names = () => (item.tags || []).map((t) => t.name);

  function render() {
    chips.replaceChildren(...(item.tags || []).map((t) =>
      tagChip(t, { onRemove: () => save(names().filter((n) => n !== t.name)), onClick: onTagClick ? () => onTagClick(t) : null })));
  }

  function save(list) {
    saving = saving.then(async () => {
      try {
        const res = await api(`/api/media/${item.id}/tags`, { method: 'PUT', body: { tags: list } });
        item.tags = res.tags;
        render();
        onChange?.(item);
        tagStore.refresh();
      } catch (err) { toast(err.message, { error: true }); }
    });
    return saving;
  }

  function add(name) {
    name = name.replace(/\s+/g, ' ').trim().replace(/^#/, '');
    if (!name) return;
    const existing = tagStore.byName(name);
    if (existing) name = existing.name; // reuse the canonical spelling
    if (names().some((n) => n.toLowerCase() === name.toLowerCase())) return;
    save([...names(), name]);
  }

  const ac = autocomplete(input, dropdown, {
    suggestions: (text) => tagStore.suggest(text, names()),
    onPick: (name) => add(name),
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger player/lightbox shortcuts while typing
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' && input.value.trim()) {
      e.preventDefault();
      if (!ac.pickActive(e) && input.value.trim()) { add(input.value); input.value = ''; ac.refresh(); }
    } else if (e.key === 'Backspace' && !input.value && item.tags?.length) {
      save(names().slice(0, -1));
    } else if (e.key === 'Escape') {
      input.blur();
    }
  });

  render();
  root.focusInput = () => input.focus();
  root.setItem = (it) => { item = it; render(); };
  return root;
}

// ---------------------------------------------------------------------------
// Search bar: tag chips (include / exclude) + free text

const TOKEN = /(-)?(?:(tag|type|is):|(#))?(?:"([^"]*)"?|(\S+))/gi;

// Same synonyms as search.py; "type:image" in the search bar switches to the Gallery.
const KIND_WORDS = new Map(Object.entries({ video: 'video', movie: 'video', clip: 'video', vid: 'video',
  image: 'image', photo: 'image', picture: 'image', pic: 'image', img: 'image' }));

export function parseQuery(q) {
  const chips = [], rest = [];
  let kind = null;
  for (const m of (q || '').matchAll(TOKEN)) {
    const prefix = (m[2] || m[3] || '').toLowerCase();
    const value = (m[4] ?? m[5] ?? '').trim();
    if (!value) continue;
    const k = (prefix === 'type' || prefix === 'is') && KIND_WORDS.get(value.toLowerCase().replace(/s+$/, ''));
    if (k) kind = k;
    else if (prefix === 'tag' || prefix === '#') chips.push({ name: value, exclude: !!m[1] });
    else rest.push(m[0]);
  }
  return { chips, text: rest.join(' '), kind };
}

export function buildQuery(chips, text) {
  return [...chips.map((c) => `${c.exclude ? '-' : ''}tag:${quoteTag(c.name)}`), text.trim()].filter(Boolean).join(' ');
}

export function searchBar({ onSearch }) {
  const input = $('#search-input'), chipsEl = $('#search-chips'), dropdown = $('#search-suggest');
  let chips = [];

  function renderChips() {
    chipsEl.replaceChildren(...chips.map((c, i) => {
      const tag = tagStore.byName(c.name) || { name: c.name };
      return tagChip(tag, {
        exclude: c.exclude,
        onClick: () => { chips[i] = { ...c, exclude: !c.exclude }; submit(); },
        onRemove: () => { chips.splice(i, 1); submit(); },
      });
    }));
    chipsEl.title = chips.length ? 'Click a tag to toggle include/exclude' : '';
    $('#search-clear').hidden = !chips.length && !input.value;
  }

  function submit() {
    renderChips();
    onSearch(buildQuery(chips, input.value));
  }

  function addChip(name, exclude = false) {
    const existing = tagStore.byName(name);
    name = existing ? existing.name : name;
    const i = chips.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) chips[i].exclude = exclude; else chips.push({ name, exclude });
    submit();
  }

  // Autocomplete only kicks in for "#word" / "-#word" / "tag:word" or when explicitly browsing.
  const tagPrefix = /(^|\s)(-?)(#|tag:)([^\s"]*)$/i;
  const ac = autocomplete(input, dropdown, {
    allowCreate: false,
    autoSelect: 'first',
    suggestions: (text) => {
      const m = input.value.match(tagPrefix);
      const word = m ? m[4] : text.split(/\s+/).pop();
      if (!m && word.length < 2) return [];
      return tagStore.suggest(word, chips.map((c) => c.name)).slice(0, 8);
    },
    onPick: (name, e) => {
      const m = input.value.match(tagPrefix);
      const exclude = !!(m && m[2]) || e?.altKey;
      const before = m ? input.value.slice(0, m.index + m[1].length) : input.value.replace(/\S*$/, '');
      setTimeout(() => { input.value = before.trimEnd(); addChip(name, exclude); });
    },
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tagPrefix.test(input.value) && ac.pickActive(e)) return;
      ac.close();
      submit();
      input.blur();
    } else if (e.key === 'Backspace' && !input.value && chips.length) {
      chips.pop();
      submit();
    } else if (e.key === 'Escape') {
      input.blur();
    }
  });
  input.addEventListener('input', () => { $('#search-clear').hidden = !chips.length && !input.value; });
  $('#search-btn').addEventListener('click', () => { ac.close(); submit(); });
  $('#search-clear').addEventListener('click', () => { chips = []; input.value = ''; submit(); });
  tagStore.subscribe(renderChips);

  return {
    set(q) { const p = parseQuery(q); chips = p.chips; input.value = p.text; renderChips(); },
    addChip,
    focus() { input.focus(); input.select(); },
  };
}
