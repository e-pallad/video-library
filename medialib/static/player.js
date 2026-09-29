// Custom HTML5 video player with YouTube-style controls, resume and keyboard shortcuts.

import { api, fmtDuration, h, icon, store, toast } from './util.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function createPlayer(item, { onPrev, onNext, onEnded, onTheater, onOpenExternal } = {}) {
  const video = h('video', {
    class: 'player-video', preload: 'metadata', playsinline: true,
    poster: item.thumb || null, src: item.url,
  });
  video.volume = store.get('player.volume', 1);
  video.muted = store.get('player.muted', false);

  const bigPlay = h('button', { class: 'player-bigplay', 'aria-label': 'Play' }, icon('play'));
  const spinner = h('div', { class: 'player-spinner', hidden: true });
  const flash = h('div', { class: 'player-flash' });
  const errorBox = h('div', { class: 'player-error', hidden: true });

  // Progress bar
  const buffered = h('div', { class: 'bar-buffered' });
  const played = h('div', { class: 'bar-played' });
  const hoverBar = h('div', { class: 'bar-hover' });
  const scrubber = h('div', { class: 'bar-scrubber' });
  const tooltip = h('div', { class: 'bar-tooltip', hidden: true });
  const progress = h('div', { class: 'player-progress', role: 'slider', 'aria-label': 'Seek' },
    h('div', { class: 'bar-track' }, buffered, hoverBar, played), scrubber, tooltip);

  // Buttons
  const btn = (name, title, onclick) => h('button', { class: 'pbtn', title, 'aria-label': title, onclick }, icon(name));
  const playBtn = btn('play', 'Play (k)', () => toggle());
  const prevBtn = onPrev ? btn('prev', 'Previous (Shift+P)', () => onPrev()) : null;
  const nextBtn = onNext ? btn('next', 'Next (Shift+N)', () => onNext()) : null;
  const muteBtn = btn('volume', 'Mute (m)', () => { video.muted = !video.muted; });
  const volume = h('input', { class: 'player-volume', type: 'range', min: 0, max: 1, step: 0.02, value: video.muted ? 0 : video.volume, 'aria-label': 'Volume' });
  const time = h('span', { class: 'player-time' }, '0:00 / ', fmtDuration(item.duration) || '0:00');
  const speedBtn = h('button', { class: 'pbtn pbtn-text', title: 'Playback speed' }, '1×');
  const speedMenu = h('div', { class: 'player-menu', hidden: true });
  const loopBtn = btn('loop', 'Loop', () => { video.loop = !video.loop; loopBtn.classList.toggle('on', video.loop); showFlash(video.loop ? 'Loop on' : 'Loop off'); });
  const autoBtn = h('button', { class: 'pbtn autoplay-toggle', title: 'Autoplay next' },
    h('span', { class: 'switch' }, h('span', { class: 'knob' })));
  const pipBtn = document.pictureInPictureEnabled ? btn('pip', 'Picture-in-picture (i)', () => togglePip()) : null;
  const theaterBtn = onTheater ? btn('theater', 'Theater mode (t)', () => onTheater()) : null;
  const fsBtn = btn('fullscreen', 'Fullscreen (f)', () => toggleFullscreen());

  let autoplayNext = store.get('player.autoplay', true);
  const setAuto = () => { autoBtn.classList.toggle('on', autoplayNext); autoBtn.title = `Autoplay next is ${autoplayNext ? 'on' : 'off'}`; };
  autoBtn.addEventListener('click', () => { autoplayNext = !autoplayNext; store.set('player.autoplay', autoplayNext); setAuto(); showFlash(autoBtn.title); });
  setAuto();

  speedMenu.append(...SPEEDS.map((s) => h('button', { class: 'menu-item', 'data-speed': s, onclick: () => { setSpeed(s); speedMenu.hidden = true; } }, s === 1 ? 'Normal' : `${s}×`)));
  speedBtn.addEventListener('click', (e) => { e.stopPropagation(); speedMenu.hidden = !speedMenu.hidden; });

  const controls = h('div', { class: 'player-controls' },
    progress,
    h('div', { class: 'player-row' },
      prevBtn, playBtn, nextBtn,
      h('div', { class: 'player-vol' }, muteBtn, volume),
      time,
      h('div', { class: 'spacer' }),
      onEnded ? autoBtn : null,
      loopBtn,
      h('div', { class: 'player-speed' }, speedBtn, speedMenu),
      pipBtn, theaterBtn, fsBtn,
    ));

  const el = h('div', { class: 'player paused', tabindex: 0 }, video, bigPlay, spinner, flash, errorBox, controls);

  // -- behaviour ----------------------------------------------------------

  function toggle() { video.paused || video.ended ? video.play().catch(() => {}) : video.pause(); }

  function setSpeed(s) {
    video.playbackRate = s;
    speedBtn.textContent = `${s}×`;
    [...speedMenu.children].forEach((c) => c.classList.toggle('on', +c.dataset.speed === s));
    store.set('player.speed', s);
  }
  setSpeed(store.get('player.speed', 1));

  function seek(t) {
    const d = video.duration || item.duration || 0;
    video.currentTime = Math.max(0, Math.min(d ? d - 0.05 : t, t));
  }

  function showFlash(text) {
    flash.textContent = text;
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {}
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {}
  }

  function updateTime() {
    const d = video.duration || item.duration || 0;
    const t = video.currentTime;
    played.style.width = d ? `${(t / d) * 100}%` : '0';
    scrubber.style.left = d ? `${(t / d) * 100}%` : '0';
    time.textContent = `${fmtDuration(t)} / ${fmtDuration(d)}`;
  }

  function updateBuffered() {
    const d = video.duration;
    if (!d || !video.buffered.length) return;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
    }
    buffered.style.width = `${(end / d) * 100}%`;
  }

  function updateVolume() {
    const v = video.muted ? 0 : video.volume;
    volume.value = v;
    volume.style.setProperty('--fill', `${v * 100}%`);
    muteBtn.replaceChildren(icon(v === 0 ? 'mute' : 'volume'));
    store.set('player.volume', video.volume);
    store.set('player.muted', video.muted);
  }

  // Progress bar interaction
  const fraction = (e) => {
    const r = progress.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  let dragging = false;
  progress.addEventListener('pointerdown', (e) => {
    dragging = true;
    progress.setPointerCapture(e.pointerId);
    el.classList.add('scrubbing');
    seek(fraction(e) * (video.duration || 0));
  });
  progress.addEventListener('pointermove', (e) => {
    const f = fraction(e), d = video.duration || item.duration || 0;
    tooltip.hidden = false;
    tooltip.textContent = fmtDuration(f * d);
    const r = progress.getBoundingClientRect();
    tooltip.style.left = `${Math.max(24, Math.min(r.width - 24, f * r.width))}px`;
    hoverBar.style.width = `${f * 100}%`;
    if (dragging) seek(f * d);
  });
  progress.addEventListener('pointerup', () => { dragging = false; el.classList.remove('scrubbing'); });
  progress.addEventListener('pointerleave', () => { tooltip.hidden = true; hoverBar.style.width = '0'; });

  volume.addEventListener('input', () => { video.volume = +volume.value; video.muted = +volume.value === 0; });

  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', toggleFullscreen);
  bigPlay.addEventListener('click', toggle);
  video.addEventListener('play', () => { el.classList.remove('paused'); playBtn.replaceChildren(icon('pause')); poke(); });
  video.addEventListener('pause', () => { el.classList.add('paused'); playBtn.replaceChildren(icon('play')); savePosition(); poke(); });
  video.addEventListener('timeupdate', () => { updateTime(); throttledSave(); });
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('volumechange', updateVolume);
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; errorBox.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });
  video.addEventListener('ended', () => {
    savePosition(0);
    if (!video.loop && autoplayNext && onEnded) onEnded();
  });
  video.addEventListener('error', () => showError());
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('click', closeMenus);

  function onFsChange() {
    const fs = document.fullscreenElement === el;
    el.classList.toggle('fullscreen', fs);
    fsBtn.replaceChildren(icon(fs ? 'exitFullscreen' : 'fullscreen'));
  }
  function closeMenus(e) { if (!speedMenu.contains(e.target) && e.target !== speedBtn) speedMenu.hidden = true; }

  function showError() {
    spinner.hidden = true;
    errorBox.hidden = false;
    errorBox.replaceChildren(
      h('div', { class: 'player-error-title' }, `Your browser can't play this ${item.ext.replace('.', '').toUpperCase()} file`),
      h('div', { class: 'player-error-sub' }, 'MP4 (H.264) and WebM play everywhere. Open it in your default player instead:'),
      h('button', { class: 'btn primary', onclick: () => onOpenExternal?.() }, icon('external'), 'Open in default player'),
    );
  }

  // Auto-hide controls while playing
  let idleTimer;
  function poke() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(() => { if (!speedMenu.hidden) return; el.classList.add('idle'); }, 2600);
  }
  el.addEventListener('pointermove', poke);
  el.addEventListener('pointerleave', () => { if (!video.paused) el.classList.add('idle'); });

  // -- resume position ----------------------------------------------------

  let lastSaved = 0;
  function savePosition(pos) {
    const t = pos ?? video.currentTime;
    if (!isFinite(t)) return;
    lastSaved = Date.now();
    item.position = t;
    const body = JSON.stringify({ position: t });
    if (!navigator.sendBeacon?.(`/api/media/${item.id}/position`, new Blob([body], { type: 'application/json' }))) {
      fetch(`/api/media/${item.id}/position`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  }
  function throttledSave() { if (Date.now() - lastSaved > 5000 && !video.paused) savePosition(); }
  const onUnload = () => { if (!video.paused) savePosition(); };
  window.addEventListener('pagehide', onUnload);

  video.addEventListener('loadedmetadata', () => {
    const d = video.duration;
    const p = item.position || 0;
    if (p > 5 && d && p < d - 5) {
      video.currentTime = p;
      toast(`Resumed at ${fmtDuration(p)}`, { action: 'Start over', onAction: () => { video.currentTime = 0; } });
    }
    updateTime();
  }, { once: true });

  // -- keyboard -------------------------------------------------------------

  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    const d = video.duration || 0;
    switch (k) {
      case ' ': case 'k': case 'K': toggle(); showFlash(video.paused ? '❚❚' : '▶'); break;
      case 'ArrowLeft': seek(video.currentTime - 5); showFlash('« 5s'); break;
      case 'ArrowRight': seek(video.currentTime + 5); showFlash('5s »'); break;
      case 'j': case 'J': seek(video.currentTime - 10); showFlash('« 10s'); break;
      case 'l': case 'L': seek(video.currentTime + 10); showFlash('10s »'); break;
      case 'ArrowUp': video.muted = false; video.volume = Math.min(1, video.volume + 0.05); showFlash(`${Math.round(video.volume * 100)}%`); break;
      case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.05); showFlash(`${Math.round(video.volume * 100)}%`); break;
      case 'm': case 'M': video.muted = !video.muted; showFlash(video.muted ? 'Muted' : 'Unmuted'); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 't': case 'T': onTheater?.(); break;
      case 'i': case 'I': togglePip(); break;
      case 'Home': seek(0); break;
      case 'End': seek(d); break;
      case '>': { const s = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(video.playbackRate) + 1)] || 1; setSpeed(s); showFlash(`${s}×`); break; }
      case '<': { const s = SPEEDS[Math.max(0, SPEEDS.indexOf(video.playbackRate) - 1)] || 1; setSpeed(s); showFlash(`${s}×`); break; }
      case 'N': if (e.shiftKey && onNext) onNext(); else return false; break;
      case 'P': if (e.shiftKey && onPrev) onPrev(); else return false; break;
      default:
        if (/^[0-9]$/.test(k) && d) { seek((d * +k) / 10); break; }
        return false;
    }
    e.preventDefault();
    poke();
    return true;
  }

  updateVolume();
  updateTime();

  return {
    el, video, onKey,
    play() { video.play().catch(() => { el.classList.add('paused'); }); },
    destroy() {
      if (!video.paused) savePosition();
      video.pause();
      video.removeAttribute('src');
      video.load();
      clearTimeout(idleTimer);
      window.removeEventListener('pagehide', onUnload);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('click', closeMenus);
    },
  };
}
