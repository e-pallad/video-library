// Custom HTML5 video player with YouTube-style controls, resume and keyboard shortcuts.
//
// Files the browser can't decode (MKV, AVI, HEVC, AC-3 audio, ...) are streamed by the server as
// fragmented MP4 converted on the fly. Such a stream can't be seeked by byte ranges, so the player
// keeps a *virtual timeline*: seeking restarts the stream at the wanted time (`offset`) and the
// position shown is `offset + video.currentTime`.

import { api, fmtDuration, h, icon, store, toast } from './util.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function createPlayer(item, { onPrev, onNext, onEnded, onTheater, onOpenExternal } = {}) {
  const video = h('video', { class: 'player-video', preload: 'metadata', playsinline: true, poster: item.thumb || null });
  video.volume = store.get('player.volume', 1);
  video.muted = store.get('player.muted', false);

  // -- playback source state -------------------------------------------------
  let mode = !item.playback || item.playback === 'direct' ? 'direct' : 'stream';
  let forceTranscode = false;
  let offset = 0;            // stream mode: media time at which the current stream starts
  let pendingSeek = null;    // position shown while a stream restart is in flight
  let streamToken = 0;
  let seekTimer = null;
  let wantPlay = false;      // the user wants playback running (survives stream restarts)
  let looping = false;
  let destroyed = false;
  let catchUp = null;        // { target } while fast-forwarding from a keyframe to the exact seek time
  const audioTracks = item.audio_tracks || [];
  let audioIndex = pickAudioTrack(audioTracks);
  if (audioIndex > 0 && mode === 'direct') mode = 'stream'; // browsers can't switch tracks themselves

  const now = () => pendingSeek ?? (mode === 'direct' ? video.currentTime : offset + video.currentTime);
  const total = () => item.duration || (mode === 'direct' && isFinite(video.duration) ? video.duration : 0) || 0;

  // -- DOM ------------------------------------------------------------------------
  const bigPlay = h('button', { class: 'player-bigplay', 'aria-label': 'Play' }, icon('play'));
  const spinner = h('div', { class: 'player-spinner', hidden: true });
  const flash = h('div', { class: 'player-flash' });
  const errorBox = h('div', { class: 'player-error', hidden: true });
  const subtitleBox = h('div', { class: 'player-subtitles' });
  const badge = h('div', { class: 'player-badge', hidden: true });

  const buffered = h('div', { class: 'bar-buffered' });
  const played = h('div', { class: 'bar-played' });
  const hoverBar = h('div', { class: 'bar-hover' });
  const scrubber = h('div', { class: 'bar-scrubber' });
  const tooltip = h('div', { class: 'bar-tooltip', hidden: true });
  const progress = h('div', { class: 'player-progress', role: 'slider', 'aria-label': 'Seek' },
    h('div', { class: 'bar-track' }, buffered, hoverBar, played), scrubber, tooltip);

  const btn = (name, title, onclick) => h('button', { class: 'pbtn', title, 'aria-label': title, onclick }, icon(name));
  const playBtn = btn('play', 'Play (k)', () => toggle());
  const prevBtn = onPrev ? btn('prev', 'Previous (Shift+P)', () => onPrev()) : null;
  const nextBtn = onNext ? btn('next', 'Next (Shift+N)', () => onNext()) : null;
  const muteBtn = btn('volume', 'Mute (m)', () => { video.muted = !video.muted; });
  const volume = h('input', { class: 'player-volume', type: 'range', min: 0, max: 1, step: 0.02, value: video.muted ? 0 : video.volume, 'aria-label': 'Volume' });
  const time = h('span', { class: 'player-time' });
  const loopBtn = btn('loop', 'Loop', () => { looping = !looping; loopBtn.classList.toggle('on', looping); showFlash(looping ? 'Loop on' : 'Loop off'); });
  const autoBtn = h('button', { class: 'pbtn autoplay-toggle', title: 'Autoplay next' }, h('span', { class: 'switch' }, h('span', { class: 'knob' })));
  const pipBtn = document.pictureInPictureEnabled ? btn('pip', 'Picture-in-picture (i)', () => togglePip()) : null;
  const theaterBtn = onTheater ? btn('theater', 'Theater mode (t)', () => onTheater()) : null;
  const fsBtn = btn('fullscreen', 'Fullscreen (f)', () => toggleFullscreen());

  // Menus (speed, audio track, subtitles)
  const menus = [];
  function menu(button, build) {
    const box = h('div', { class: 'player-menu', hidden: true });
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = box.hidden;
      menus.forEach((m) => { m.hidden = true; });
      if (open) { box.replaceChildren(...build()); box.hidden = false; }
    });
    menus.push(box);
    return h('div', { class: 'player-menu-wrap' }, button, box);
  }
  const item_ = (label, on, fn) => h('button', { class: 'menu-item' + (on ? ' on' : ''), onclick: () => { fn(); menus.forEach((m) => { m.hidden = true; }); } }, label);

  const speedBtn = h('button', { class: 'pbtn pbtn-text', title: 'Playback speed' }, '1×');
  const speedMenu = menu(speedBtn, () => SPEEDS.map((s) => item_(s === 1 ? 'Normal' : `${s}×`, video.playbackRate === s, () => setSpeed(s))));

  const audioBtn = h('button', { class: 'pbtn', title: 'Audio track' }, icon('audio'));
  const audioMenu = audioTracks.length > 1 ? menu(audioBtn, () => [
    h('div', { class: 'menu-title' }, 'Audio track'),
    ...audioTracks.map((t) => item_(t.label, t.index === audioIndex, () => setAudioTrack(t.index))),
  ]) : null;

  const subtitles = item.subtitles || [];
  const ccBtn = h('button', { class: 'pbtn', title: 'Subtitles (c)' }, icon('cc'));
  const ccMenu = subtitles.length ? menu(ccBtn, () => [
    h('div', { class: 'menu-title' }, 'Subtitles'),
    item_('Off', !activeSub, () => setSubtitle(null)),
    ...subtitles.map((s) => item_(s.label, activeSub?.key === s.key, () => setSubtitle(s))),
  ]) : null;

  let autoplayNext = store.get('player.autoplay', true);
  const setAuto = () => { autoBtn.classList.toggle('on', autoplayNext); autoBtn.title = `Autoplay next is ${autoplayNext ? 'on' : 'off'}`; };
  autoBtn.addEventListener('click', () => { autoplayNext = !autoplayNext; store.set('player.autoplay', autoplayNext); setAuto(); showFlash(autoBtn.title); });
  setAuto();

  const controls = h('div', { class: 'player-controls' },
    progress,
    h('div', { class: 'player-row' },
      prevBtn, playBtn, nextBtn,
      h('div', { class: 'player-vol' }, muteBtn, volume),
      time,
      h('div', { class: 'spacer' }),
      onEnded ? autoBtn : null,
      ccMenu, audioMenu, loopBtn, speedMenu,
      pipBtn, theaterBtn, fsBtn,
    ));

  const el = h('div', { class: 'player paused', tabindex: 0 }, video, subtitleBox, bigPlay, spinner, flash, badge, errorBox, controls);

  // -- sources -----------------------------------------------------------------

  function streamUrl(start) {
    const p = new URLSearchParams({ t: start.toFixed(3), audio: audioIndex });
    if (forceTranscode) p.set('transcode', '1');
    return `${item.stream_url}?${p}`;
  }

  async function startStream(t) {
    const token = ++streamToken;
    t = Math.max(0, Math.min(t, Math.max(0, total() - 0.5)));
    pendingSeek = t;
    spinner.hidden = false;
    updateTime();
    let start = t;
    // Stream copy can only start on a keyframe; ask the server where that is so time stays exact.
    if (t > 0 && !forceTranscode && item.stream_mode === 'remux') {
      try { start = (await api(`/api/media/${item.id}/stream-start?t=${t.toFixed(3)}`)).start; } catch {}
    }
    if (token !== streamToken || destroyed) return;
    endCatchUp(false);
    offset = start;
    video.src = streamUrl(start);
    applySpeed();
    if (t - start > 0.3) {
      beginCatchUp(t);
    } else {
      pendingSeek = null;
      if (wantPlay) video.play().catch(() => {});
    }
    updateBadge();
  }

  // A copied stream starts on the keyframe before the requested time. The browser can't seek inside
  // it, so play the lead-in hidden, muted and at 16x until the requested time is reached.
  function beginCatchUp(target) {
    catchUp = { target, muted: video.muted, timer: setTimeout(() => endCatchUp(true), 15000) };
    video.muted = true;
    video.classList.add('catching-up');
    video.playbackRate = 16;
    video.play().catch(() => endCatchUp(true));
    const tick = () => {
      if (!catchUp || catchUp.target !== target) return;
      const left = target - (offset + video.currentTime);
      if (left <= 0.04) { endCatchUp(true); return; }
      // Slow down near the target so we stop on it instead of overshooting.
      video.playbackRate = left > 3 ? 16 : Math.max(1, Math.min(16, left * 5));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function endCatchUp(resume) {
    if (!catchUp) return;
    clearTimeout(catchUp.timer);
    video.muted = catchUp.muted;
    catchUp = null;
    video.classList.remove('catching-up');
    spinner.hidden = true;
    pendingSeek = null;
    applySpeed();
    if (resume && !wantPlay) video.pause();
    updateTime();
  }

  function useDirect(t = 0) {
    video.src = item.url;
    if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
    applySpeed();
    if (wantPlay) video.play().catch(() => {});
  }

  function seek(t) {
    const d = total();
    t = Math.max(0, d ? Math.min(d - 0.05, t) : t);
    if (mode === 'direct') { video.currentTime = t; return; }
    // Restart the stream, debounced so dragging the bar / repeated key presses start one ffmpeg only.
    pendingSeek = t;
    updateTime();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => startStream(t), 300);
  }

  function setAudioTrack(index) {
    audioIndex = index;
    const t = audioTracks.find((a) => a.index === index);
    if (t?.lang) store.set('player.audioLang', t.lang);
    const at = now();
    if (mode === 'direct') {
      if (index === 0) return;
      mode = 'stream';
    }
    startStream(at);
    showFlash(t ? t.label.split(' · ')[0] : `Track ${index + 1}`);
  }

  function updateBadge() {
    const labels = { remux: 'Repackaged for playback', transcode: 'Converting for playback' };
    const m = mode === 'direct' ? null : forceTranscode ? 'transcode' : (item.stream_mode || 'transcode');
    badge.hidden = !m;
    badge.textContent = m ? labels[m] : '';
    badge.title = m === 'transcode'
      ? 'The video is re-encoded to H.264 on the fly because your browser cannot decode its original format. Seeking restarts the conversion.'
      : 'The video is copied into an MP4 container on the fly (no quality loss).';
  }

  // -- behaviour ---------------------------------------------------------------

  function toggle() {
    if (catchUp) { wantPlay = !wantPlay; return; }  // applied once the seek finishes
    if (video.paused || video.ended) { wantPlay = true; video.play().catch(() => {}); }
    else { wantPlay = false; video.pause(); }
  }

  function applySpeed() {
    const s = store.get('player.speed', 1);
    video.defaultPlaybackRate = s;
    video.playbackRate = s;
  }
  function setSpeed(s) {
    store.set('player.speed', s);
    applySpeed();
    speedBtn.textContent = `${s}×`;
  }
  speedBtn.textContent = `${store.get('player.speed', 1)}×`;

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
    const d = total(), t = now();
    const pct = d ? `${Math.min(100, (t / d) * 100)}%` : '0';
    played.style.width = pct;
    scrubber.style.left = pct;
    time.textContent = `${fmtDuration(t)} / ${fmtDuration(d)}`;
    renderSubtitle(t);
  }

  function updateBuffered() {
    const d = total();
    if (!d || !video.buffered.length) return;
    const base = mode === 'direct' ? 0 : offset;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
    }
    buffered.style.left = mode === 'direct' ? '0' : `${(base / d) * 100}%`;
    buffered.style.width = `${Math.max(0, Math.min(100, (end / d) * 100))}%`;
  }

  function updateVolume() {
    if (catchUp) return; // temporary mute while catching up; don't show or remember it
    const v = video.muted ? 0 : video.volume;
    volume.value = v;
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
    seek(fraction(e) * total());
  });
  progress.addEventListener('pointermove', (e) => {
    const f = fraction(e), d = total();
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
  subtitleBox.addEventListener('click', toggle);
  bigPlay.addEventListener('click', toggle);
  video.addEventListener('play', () => { if (!catchUp) wantPlay = true; el.classList.remove('paused'); playBtn.replaceChildren(icon('pause')); poke(); });
  video.addEventListener('pause', () => {
    if (catchUp) return;
    el.classList.add('paused'); playBtn.replaceChildren(icon('play'));
    if (pendingSeek == null) savePosition();
    poke();
  });
  video.addEventListener('timeupdate', () => { updateTime(); throttledSave(); });
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('volumechange', updateVolume);
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { if (!catchUp) spinner.hidden = true; errorBox.hidden = true; });
  video.addEventListener('canplay', () => { if (!catchUp) spinner.hidden = true; });
  video.addEventListener('ended', () => {
    if (looping) { seek(0); if (mode === 'direct') video.play().catch(() => {}); return; }
    savePosition(0);
    if (autoplayNext && onEnded) onEnded();
  });
  video.addEventListener('error', () => {
    if (destroyed || !video.getAttribute('src')) return;
    const at = now();
    // Fall back step by step: native file -> repackaged stream -> full H.264 conversion.
    if (mode === 'direct' && item.stream_url) {
      mode = 'stream';
      showFlash('Converting for playback…');
      startStream(at);
    } else if (mode === 'stream' && !forceTranscode && item.stream_mode !== 'transcode') {
      forceTranscode = true;
      startStream(at);
    } else {
      showError();
    }
  });
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('click', closeMenus);

  function onFsChange() {
    const fs = document.fullscreenElement === el;
    el.classList.toggle('fullscreen', fs);
    fsBtn.replaceChildren(icon(fs ? 'exitFullscreen' : 'fullscreen'));
  }
  function closeMenus(e) { if (!menus.some((m) => m.parentElement.contains(e.target))) menus.forEach((m) => { m.hidden = true; }); }

  function showError() {
    spinner.hidden = true;
    errorBox.hidden = false;
    errorBox.replaceChildren(
      h('div', { class: 'player-error-title' }, `This ${item.ext.replace('.', '').toUpperCase()} file can't be played in the browser`),
      h('div', { class: 'player-error-sub' }, 'Converting it failed too (the file may be damaged or use an unusual codec). Open it in your default player instead:'),
      h('button', { class: 'btn primary', onclick: () => onOpenExternal?.() }, icon('external'), 'Open in default player'),
    );
  }

  // Auto-hide controls while playing
  let idleTimer;
  function poke() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(() => { if (menus.every((m) => m.hidden)) el.classList.add('idle'); }, 2600);
  }
  el.addEventListener('pointermove', poke);
  el.addEventListener('pointerleave', () => { if (!video.paused) el.classList.add('idle'); });

  // -- subtitles -------------------------------------------------------------------

  let activeSub = null, cues = [], lastCue = null;
  const cueCache = new Map();

  async function setSubtitle(track, { quiet = false } = {}) {
    activeSub = track;
    cues = [];
    lastCue = undefined;
    ccBtn.classList.toggle('on', !!track);
    store.set('player.subLang', track ? (track.lang || track.label) : null);
    renderSubtitle(now());
    if (!track) { if (!quiet) showFlash('Subtitles off'); return; }
    try {
      if (!cueCache.has(track.key)) {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error('Could not load subtitles');
        cueCache.set(track.key, parseVtt(await res.text()));
      }
      if (activeSub === track) { cues = cueCache.get(track.key); renderSubtitle(now()); }
      if (!quiet) showFlash(track.label);
    } catch (e) {
      toast(e.message, { error: true });
      if (activeSub === track) { activeSub = null; ccBtn.classList.remove('on'); }
    }
  }

  function renderSubtitle(t) {
    const active = cues.filter((c) => t >= c.start && t < c.end);
    const key = active.map((c) => c.id).join(',');
    if (key === lastCue) return;
    lastCue = key;
    subtitleBox.replaceChildren(...active.map((c) => h('div', { class: 'cue', html: c.html })));
  }

  function toggleSubtitles() {
    if (!subtitles.length) return;
    if (activeSub) setSubtitle(null);
    else setSubtitle(subtitles.find((s) => (s.lang || s.label) === store.get('player.subLang.last')) || subtitles[0]);
    if (activeSub) store.set('player.subLang.last', activeSub.lang || activeSub.label);
  }

  // Re-enable the subtitle language used last time.
  const preferred = store.get('player.subLang', null);
  const autoSub = preferred && subtitles.find((s) => (s.lang || s.label) === preferred);
  if (autoSub) setSubtitle(autoSub, { quiet: true });

  // -- resume position ---------------------------------------------------------------

  let lastSaved = 0;
  function savePosition(pos) {
    const t = pos ?? now();
    if (!isFinite(t)) return;
    lastSaved = Date.now();
    item.position = t;
    const body = JSON.stringify({ position: t });
    if (!navigator.sendBeacon?.(`/api/media/${item.id}/position`, new Blob([body], { type: 'application/json' }))) {
      fetch(`/api/media/${item.id}/position`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  }
  function throttledSave() { if (Date.now() - lastSaved > 5000 && !video.paused && pendingSeek == null) savePosition(); }
  const onUnload = () => { if (!video.paused) savePosition(); };
  window.addEventListener('pagehide', onUnload);

  const resumeAt = item.position > 5 && (!item.duration || item.position < item.duration - 5) ? item.position : 0;
  if (resumeAt) toast(`Resumed at ${fmtDuration(resumeAt)}`, { action: 'Start over', onAction: () => seek(0) });
  if (mode === 'direct') useDirect(resumeAt); else startStream(resumeAt);
  updateBadge();

  // -- keyboard --------------------------------------------------------------------------

  function onKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    const d = total();
    const rate = video.playbackRate;
    switch (k) {
      case ' ': case 'k': case 'K': toggle(); showFlash(wantPlay ? '▶' : '❚❚'); break;
      case 'ArrowLeft': seek(now() - 5); showFlash('« 5s'); break;
      case 'ArrowRight': seek(now() + 5); showFlash('5s »'); break;
      case 'j': case 'J': seek(now() - 10); showFlash('« 10s'); break;
      case 'l': case 'L': seek(now() + 10); showFlash('10s »'); break;
      case 'ArrowUp': video.muted = false; video.volume = Math.min(1, video.volume + 0.05); showFlash(`${Math.round(video.volume * 100)}%`); break;
      case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.05); showFlash(`${Math.round(video.volume * 100)}%`); break;
      case 'm': case 'M': video.muted = !video.muted; showFlash(video.muted ? 'Muted' : 'Unmuted'); break;
      case 'c': case 'C': toggleSubtitles(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 't': case 'T': onTheater?.(); break;
      case 'i': case 'I': togglePip(); break;
      case 'Home': seek(0); break;
      case 'End': seek(d); break;
      case '>': { const s = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(rate) + 1)] || 1; setSpeed(s); showFlash(`${s}×`); break; }
      case '<': { const s = SPEEDS[Math.max(0, SPEEDS.indexOf(rate) - 1)] || 1; setSpeed(s); showFlash(`${s}×`); break; }
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
    get mode() { return mode === 'direct' ? 'direct' : forceTranscode ? 'transcode' : item.stream_mode; },
    currentTime: now,
    play() { wantPlay = true; if (video.getAttribute('src')) video.play().catch(() => { el.classList.add('paused'); }); },
    destroy() {
      if (!video.paused && !catchUp) savePosition();
      destroyed = true;
      if (catchUp) { clearTimeout(catchUp.timer); video.muted = catchUp.muted; catchUp = null; }
      clearTimeout(seekTimer);
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

function pickAudioTrack(tracks) {
  if (!tracks.length) return 0;
  const lang = store.get('player.audioLang', null);
  const byLang = lang && tracks.find((t) => t.lang === lang);
  return (byLang || tracks.find((t) => t.default) || tracks[0]).index;
}

// Minimal WebVTT parser (ffmpeg converts SRT/ASS/embedded tracks to VTT on the server).
export function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  let id = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = vttTime(a), end = vttTime(b);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ id: id++, start, end, html: sanitizeCue(body) });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function vttTime(s) {
  const m = (s || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
}

function sanitizeCue(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Keep basic styling tags only; drop voice/class/ruby spans.
  return esc
    .replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>')
    .replace(/&lt;\/?(?:c|v|lang|ruby|rt)(?:[.\s][^&]*)?&gt;/g, '')
    .replace(/\n/g, '<br>');
}
