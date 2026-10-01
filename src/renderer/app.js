// app.js - susurroLive renderer (state + UI). Main owns truth; this is a projection.
import { CaptureEngine, listMicrophones } from './audio.js';
import { Visualizer } from './viz.js';
import { initTheme, applyTheme, renderThemePicker } from './theme.js';

const api = window.susurro;

// ---------------------------------------------------------------- error capture (smoke + UX)
window.__err = null;
window.addEventListener('error', (e) => { window.__err = String(e.message); showToast(`error: ${e.message}`); });
window.addEventListener('unhandledrejection', (e) => { window.__err = String(e.reason); showToast(`error: ${e.reason}`); });

// ---------------------------------------------------------------- state
const S = {
  sources: [],          // [{id, kind, deviceId, label, gain, muted}]
  session: null,
  recording: false,
  paused: false,
  recordBusy: false,
  recordedSeconds: 0,
  gpu: null,
  engine: null,
  settings: null,
  chunks: [],           // [{index,status,durationSec}]
  words: [],
  segments: [],
  wordSpans: [],
  renderedWords: 0,
  activeWord: -1,
  markIdx: 0,
  markT: 0,
  wordSpeakers: [],     // derived in main, aligned with words: 'spk0' | 'spk1' | ... | null
  diarizedAt: null,     // identity of the diarization block currently rendered
  diarSpeakers: 0,      // speakers in that block (legend)
  lastSpk: null,        // last speaker rendered, so a chip marks each new turn
  diar: null,           // diarize.status(): { available, binary, model, reason, running }
  diarizing: false,
  diarManual: false,    // the user clicked the button: toasts come from the click handler
  diarStartedAt: null,  // elapsed-time readout while running
  diarTimer: null,
  playing: false,
  mics: [],
  seq: 1,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function capturePcm(ab) {
  if (!S.recording || S.paused) return;
  S.recordedSeconds += ab.byteLength / (2 * engine.sampleRate);
  api.capture.pcm(ab);
}
let engine = new CaptureEngine({ onPcm: capturePcm });
const viz = new Visualizer($('viz'));

// ---------------------------------------------------------------- toast
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtT(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- sources
function renderSources() {
  const list = $('sourceList');
  list.innerHTML = '';
  $('sourceEmpty').classList.toggle('hidden', S.sources.length > 0);

  for (const s of S.sources) {
    const row = el('div', 'src-row' + (s.muted ? ' muted' : ''));
    row.dataset.id = s.id;

    row.appendChild(el('div', 'src-icon', s.kind === 'mic' ? '🎙' : '🔊'));

    const nameCell = el('div');
    if (s.kind === 'mic' && S.mics.length > 0) {
      const sel = el('select', 'src-name');
      sel.disabled = S.recording;
      for (const m of S.mics) {
        const o = el('option', null, m.label);
        o.value = m.deviceId;
        if (m.deviceId === s.deviceId) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => { s.deviceId = sel.value; s.label = sel.options[sel.selectedIndex].text; };
      nameCell.appendChild(sel);
    } else {
      nameCell.appendChild(el('div', 'src-name', s.label));
      nameCell.appendChild(el('div', 'src-kind', s.kind === 'loopback' ? 'system loopback' : s.kind));
    }
    row.appendChild(nameCell);

    const meter = el('div', 'meter');
    const fill = el('i');
    meter.appendChild(fill);
    row.appendChild(meter);

    const btnMute = el('button', 'src-btn' + (s.muted ? ' on' : ''), s.muted ? 'muted' : 'mute');
    btnMute.onclick = () => { s.muted = !s.muted; engine.setMute(s.id, s.muted); renderSources(); };
    row.appendChild(btnMute);

    const btnRm = el('button', 'src-btn', '✕');
    btnRm.disabled = S.recording;
    btnRm.onclick = () => {
      engine.remove(s.id);
      S.sources = S.sources.filter((x) => x.id !== s.id);
      renderSources();
    };
    row.appendChild(btnRm);

    s._fill = fill;
    list.appendChild(row);
  }
  if (S.recording) {
    if (S.paused) viz.setPaused();
    else viz.setCapture(engine.tracks);
  }
  renderLegend();
}

function renderLegend() {
  const lg = $('vizLegend');
  lg.innerHTML = '';
  for (const s of S.sources) {
    const d = el('div');
    const sw = el('span', 'sw');
    sw.style.background = s.muted ? '#726b68' : '#c99a6b';
    d.appendChild(sw);
    d.appendChild(el('span', null, s.label));
    lg.appendChild(d);
  }
}

async function addMic() {
  S.mics = await listMicrophones();
  if (!S.mics.length) { showToast('no microphone found'); return; }
  const used = new Set(S.sources.filter((s) => s.kind === 'mic').map((s) => s.deviceId));
  const pick = S.mics.find((m) => !used.has(m.deviceId)) || S.mics[0];
  S.sources.push({
    id: `src${S.seq++}`, kind: 'mic', deviceId: pick.deviceId, label: pick.label, gain: 1, muted: false,
  });
  renderSources();
}

async function addSystem() {
  const srcs = await api.capture.desktopSources();
  if (!srcs.length) { showToast('no screen source available for system audio'); return; }
  S.sources.push({
    id: `src${S.seq++}`, kind: 'loopback', deviceId: srcs[0].id,
    label: 'System Audio', gain: 1, muted: false,
  });
  renderSources();
}

// ---------------------------------------------------------------- recording
async function toggleRecord() {
  return recordAction(() => S.recording ? stopRecording() : startRecording());
}

async function recordAction(action) {
  if (S.recordBusy) return;
  S.recordBusy = true;
  renderRecordControls();
  try { await action(); }
  catch (err) { showToast(`recording failed: ${err.message || err}`); }
  finally { S.recordBusy = false; renderRecordControls(); }
}

function renderRecordControls() {
  const record = $('btnRecord');
  record.disabled = S.recordBusy;
  record.classList.toggle('recording', S.recording);
  record.classList.toggle('paused', S.paused);
  record.title = S.recording ? 'Stop recording and finish session' : 'Start recording';
  record.setAttribute('aria-label', record.title);
  const pause = $('btnPause');
  pause.disabled = !S.recording || S.recordBusy;
  pause.textContent = S.paused ? 'Resume' : 'Pause';
  pause.title = S.paused ? 'Resume recording in this session' : 'Pause recording';
  pause.classList.toggle('resuming', S.paused);
  $('btnAddMic').disabled = S.recording || S.recordBusy;
  $('btnAddSys').disabled = S.recording || S.recordBusy;
  $('btnSessions').disabled = S.recording || S.recordBusy;
  if (S.recording) {
    $('recSub').textContent = S.paused ? 'paused · same session' : `${engine.sampleRate / 1000} kHz · ${engine.tracks.length} ${engine.tracks.length === 1 ? 'source' : 'sources'}`;
    setStatus(S.paused ? 'Paused' : 'Recording', S.paused ? 'paused' : 'recording');
  }
}

async function togglePause() {
  return recordAction(async () => {
    if (!S.recording) return;
    if (S.paused) {
      const res = await api.record.resume();
      if (!res.ok) { showToast(`resume failed: ${res.error}`); return; }
      S.paused = false;
      engine.resume();
      viz.setCapture(engine.tracks);
      showToast('recording resumed');
    } else {
      engine.pause(); // Cut capture immediately, then finalize the queued PCM in main.
      const res = await api.record.pause().catch((err) => ({ ok: false, error: String(err) }));
      if (!res.ok) { engine.resume(); showToast(`pause failed: ${res.error}`); return; }
      S.paused = true;
      S.recordedSeconds = res.durationSec;
      viz.setPaused();
      showToast('paused · resume whenever you’re ready');
    }
  });
}

async function startRecording() {
  if (!S.session) { showToast('create or open a session first'); openSessions(); return; }
  if (S.session.chunks?.length) { showToast('create a new session to record another take'); openSessions(); return; }
  if (S.sources.length === 0) { showToast('add at least one source'); return; }

  // Fresh capture each take (browser keeps device handles tight).
  $('player').pause();
  engine = new CaptureEngine({ onPcm: capturePcm });

  const res = await engine.start(S.sources);
  if (!res.ok) { showToast(`capture failed: ${res.error}`); return; }

  const startRes = await api.record.start({
    sources: S.sources.map(({ id, kind, deviceId, label, gain, muted }) => ({ id, kind, deviceId, label, gain, muted })),
    sampleRate: engine.sampleRate,
  }).catch((err) => ({ ok: false, error: String(err) }));
  if (!startRes.ok) { await engine.stop(); showToast(`record failed: ${startRes.error}`); return; }

  S.recording = true;
  S.paused = false;
  S.recordedSeconds = 0;
  S.words = [];
  S.chunks = [];
  resetTranscript();
  setFollow(true);
  $('btnRecord').classList.add('recording');
  $('recSub').textContent = `recording · ${engine.sampleRate} Hz · ${S.sources.length} src`;
  setStatus('Recording', 'recording');
  viz.setCapture(engine.tracks);
  renderSources();
  $('btnPlay').disabled = true;
  $('btnStopPlay').disabled = true;
  showToast('recording');
}

async function stopRecording() {
  engine.pause();
  const res = await api.record.stop().catch((err) => ({ ok: false, error: String(err) }));
  if (!res.ok) {
    if (!S.paused && S.recording) engine.resume();
    showToast(`stop failed: ${res.error}`);
    return;
  }
  await engine.stop();
  viz.setIdle();
  S.recording = false;
  S.paused = false;
  S.recordedSeconds = res.durationSec;
  $('timer').textContent = fmtClock(res.durationSec);
  $('btnRecord').classList.remove('recording');
  $('recSub').textContent = 'not recording';
  renderSources();
  const pipe = await api.pipeline.status();
  setStatus(pipe.remaining ? 'Processing' : 'Ready', pipe.remaining ? 'processing' : 'idle');
  showToast(`stopped · ${res.chunks} chunks · ${fmtClock(res.durationSec)}`);
  if (res.audioUrl) loadPlayer(res.audioUrl);
  await refreshSession();
}

function loadPlayer(url) {
  if (S.recording) return;
  const p = $('player');
  p.src = url;
  $('btnPlay').disabled = false;
  $('btnStopPlay').disabled = false;
}

// ---------------------------------------------------------------- transcript
//
// Continuous prose: words flow as ONE block and the timecodes live in the left margin,
// never breaking the line. Rendering is incremental (append-only) so scroll position and
// the active-word highlight survive every new chunk.

const TIME_MARK_SEC = 15;      // margin timecode every N seconds of audio
const FOLLOW_ANCHOR = 0.38;    // where the active word sits vertically while following
const SMOOTH_MAX = 2.5;        // viewports; beyond this, jump instead of animating

let followPaused = false;
let programmaticScroll = false;
let scrollTimer = null;

function txInner() {
  const box = $('transcript');
  let inner = document.getElementById('txInner');
  if (!inner) {
    box.innerHTML = '';
    inner = el('div', 'tx-inner');
    inner.id = 'txInner';
    box.appendChild(inner);
  }
  return inner;
}

function resetTranscript() {
  const box = $('transcript');
  box.innerHTML = '';
  S.wordSpans = [];
  S.renderedWords = 0;
  S.markIdx = 0;
  S.markT = 0;
  S.activeWord = -1;
  S.lastSpk = null;
}

/** 'spk2' -> 2 (0-based), anything else -> null. */
function spkIndex(id) {
  const m = /^spk(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

/** Inline marker where a speaker's turn starts. Not selectable, so copied text stays clean. */
function speakerChip(idx) {
  const c = el('span', 'spk-chip', `S${idx + 1}`);
  c.dataset.spk = String(idx);
  c.title = `Speaker ${idx + 1}`;
  return c;
}

/** Is what we already rendered still a valid prefix of the current word list? */
function prefixIntact() {
  const n = S.renderedWords;
  if (!n) return true;
  if (n > S.words.length) return false;
  const sp = S.wordSpans[n - 1];
  const w = S.words[n - 1];
  return !!sp && !!w && sp.dataset.t === String(w.t) && sp.dataset.w === w.w;
}

function renderTranscript() {
  const box = $('transcript');

  if (!S.words.length) {
    if (!(S.chunks || []).some((c) => c.status !== 'done')) {
      resetTranscript();
      box.appendChild(el('div', 'empty', 'Transcription appears here as chunks complete.'));
      return;
    }
  }

  const inner = txInner();

  if (!prefixIntact()) {
    inner.innerHTML = '';
    S.wordSpans = [];
    S.renderedWords = 0;
    S.markIdx = 0;
    S.markT = 0;
    S.activeWord = -1;
    S.lastSpk = null;
  }

  if (S.renderedWords < S.words.length) {
    const frag = document.createDocumentFragment();
    for (let i = S.renderedWords; i < S.words.length; i++) {
      const w = S.words[i];
      const spk = spkIndex(S.wordSpeakers[i]);
      // chips are inserted in-flow at render time, so time marks measure the final layout
      if (spk !== null && spk !== S.lastSpk) frag.appendChild(speakerChip(spk));
      const sp = el('span', 'w', `${w.w} `);
      sp.dataset.i = String(i);
      sp.dataset.t = String(w.t);
      sp.dataset.w = w.w;
      if (spk !== null) { sp.dataset.spk = String(spk); S.lastSpk = spk; }
      sp.onclick = () => { const p = $('player'); if (p.duration) p.currentTime = w.t; };
      S.wordSpans.push(sp);
      frag.appendChild(sp);
    }
    inner.appendChild(frag);
    S.renderedWords = S.words.length;
    addTimeMarks();
  }

  const outstanding = (S.chunks || []).some((c) => c.status !== 'done');
  const pend = document.getElementById('txPending');
  if (outstanding && !pend) {
    const p = el('div', 'pending', '… still transcribing');
    p.id = 'txPending';
    inner.appendChild(p);
  } else if (!outstanding && pend) {
    pend.remove();
  }
}

/** Place a timecode in the left margin at the first word past each interval. */
function addTimeMarks() {
  const inner = document.getElementById('txInner');
  if (!inner) return;
  const nextBoundary = () => (Math.floor((S.markT || 0) / TIME_MARK_SEC) + 1) * TIME_MARK_SEC;

  let b = nextBoundary();
  for (let i = S.markIdx || 0; i < S.words.length; i++) {
    const w = S.words[i];
    if (w.t < b) continue;
    const sp = S.wordSpans[i];
    if (sp) {
      const m = el('span', 'tc-mark', fmtClock(Math.floor(w.t)));
      m.style.top = `${sp.offsetTop}px`;
      inner.appendChild(m);
    }
    S.markIdx = i;
    S.markT = b;
    b = nextBoundary();
  }
}

function highlightAt(t) {
  const spans = S.wordSpans;
  if (!spans.length) return;

  // words[] is guaranteed non-decreasing (enforceMonotonic), so binary search is safe
  let lo = 0, hi = spans.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(spans[mid].dataset.t) <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx === S.activeWord) return;

  const prev = S.activeWord;
  if (prev >= 0 && spans[prev]) {
    spans[prev].classList.remove('active');
    spans[prev].classList.add('past');
  }
  if (idx >= 0 && spans[idx]) {
    spans[idx].classList.remove('past');
    spans[idx].classList.add('active');
  }
  if (idx < prev) {
    for (let i = idx + 1; i < Math.min(prev, spans.length); i++) spans[i].classList.remove('past');
  }
  S.activeWord = idx;
  followActive();
}

/**
 * Teleprompter follow: only move when the active word leaves a comfortable band, and snap
 * (rather than animate) across implausibly large gaps, so one bad chunk can't fling the view.
 */
function followActive() {
  if (followPaused || S.activeWord < 0) return;
  const box = $('transcript');
  const sp = S.wordSpans[S.activeWord];
  if (!sp) return;

  const target = Math.max(0, sp.offsetTop - box.clientHeight * FOLLOW_ANCHOR);
  const delta = Math.abs(target - box.scrollTop);
  if (delta < box.clientHeight * 0.12) return;   // already inside the band - stay put

  programmaticScroll = true;
  if (delta > box.clientHeight * SMOOTH_MAX) box.scrollTop = target;
  else box.scrollTo({ top: target, behavior: 'smooth' });

  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { programmaticScroll = false; }, 450);
}

function setFollow(on) {
  followPaused = !on;
  const b = $('btnFollow');
  if (b) b.classList.toggle('hidden', !followPaused);
  if (on) followActive();
}

// ---------------------------------------------------------------- chunk strip
function renderChunks() {
  const strip = $('chunkStrip');
  strip.innerHTML = '';
  for (const c of S.chunks) {
    const chip = el('div', `chip ${c.status || 'pending'}`);
    chip.title = `chunk ${c.index} · ${c.status} · ${(c.durationSec || 0).toFixed(1)}s`;
    chip.onclick = () => api.pipeline.retry(c.index);
    strip.appendChild(chip);
  }
  const failed = S.chunks.filter((c) => c.status === 'error').length;
  const done = S.chunks.filter((c) => c.status === 'done').length;
  const active = S.chunks.filter((c) => c.status === 'running' || c.status === 'queued').length;
  $('pipeStatus').textContent = `${done}/${S.chunks.length} done · ${active} active${failed ? ` · ${failed} failed` : ''}`;
  // Retry only makes sense when something actually failed — a permanently visible
  // retry reads like an undetected failure. Hidden otherwise.
  $('btnRetryAll').classList.toggle('hidden', failed === 0);
  renderSpeakers();   // the Speakers button waits for transcription to finish
}

// ---------------------------------------------------------------- speakers (diarization)
// Main owns the turns and derives one speaker per word; the renderer only draws them.
const sameFolder = (a, b) => !!a && !!b &&
  String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();

/**
 * Take new words + speakers. `diarization` is the block's identity ({speakers, createdAt});
 * a different block forces a full re-render so chips and time marks lay out together.
 */
function setTranscriptData({ words, segments, wordSpeakers, diarization }) {
  S.words = words || [];
  S.segments = segments || [];
  S.wordSpeakers = wordSpeakers || [];
  S.diarSpeakers = diarization?.speakers || 0;
  const at = diarization?.createdAt || null;
  if (at !== S.diarizedAt) {
    S.diarizedAt = at;
    resetTranscript();
  }
  renderTranscript();
  renderSpeakers();
}

function renderSpeakers() {
  // legend: one key per speaker the model found, arrival order
  const legend = $('spkLegend');
  const n = S.diarizedAt ? S.diarSpeakers || 0 : 0;
  legend.innerHTML = '';
  legend.classList.toggle('hidden', !n);
  for (let i = 0; i < n; i++) {
    const k = el('span', 'spk-key', `Speaker ${i + 1}`);
    k.dataset.spk = String(i);
    legend.appendChild(k);
  }
  if (n) legend.appendChild(el('span', 'spk-note', 'by order of first speaking'));

  // button: only when the engine is installed and there is something to label
  const btn = $('btnDiarize');
  const hasWords = S.words.length > 0;
  btn.classList.toggle('hidden', !S.diar?.available || !S.session || !hasWords);
  const outstanding = (S.chunks || []).some((c) => c.status !== 'done' && c.status !== 'error');
  const blocked = S.recording || S.importing || outstanding;
  btn.disabled = !S.diarizing && blocked;   // while running, the button cancels
  btn.classList.toggle('busy', S.diarizing);
  btn.textContent = S.diarizing
    ? `Identifying… ${fmtClock((Date.now() - (S.diarStartedAt || Date.now())) / 1000)}  ✕`
    : n ? '↻ Speakers' : '◐ Identify speakers';
  btn.title = S.diarizing ? 'Identifying who spoke when — click to cancel'
    : blocked ? 'Available once transcription has finished'
      : n ? 'Run speaker identification again' : 'Identify who spoke when';

  // the CLI reports no progress, so show elapsed time instead
  if (S.diarizing && !S.diarTimer) {
    S.diarStartedAt = S.diarStartedAt || Date.now();
    S.diarTimer = setInterval(renderSpeakers, 1000);
  } else if (!S.diarizing && S.diarTimer) {
    clearInterval(S.diarTimer);
    S.diarTimer = null;
    S.diarStartedAt = null;
  }
}

async function refreshDiarStatus() {
  try { S.diar = await api.diarize.status(); } catch { S.diar = null; }
  S.diarizing = !!S.diar?.running && sameFolder(S.diar.running, S.session?.folder);
  renderSpeakers();
}

async function runDiarize() {
  if (S.diarizing) {
    await api.diarize.cancel();   // the pending run() resolves with {cancelled:true}
    return;
  }
  S.diarizing = true;
  S.diarManual = true;
  renderSpeakers();
  const r = await api.diarize.run();
  S.diarManual = false;
  S.diarizing = false;
  if (r.cancelled) showToast('speaker identification cancelled');
  else if (!r.ok) showToast(`speaker identification failed: ${r.error}`);
  else if (sameFolder(r.folder, S.session?.folder)) {
    showToast(`${r.speakers} speaker${r.speakers === 1 ? '' : 's'} identified`);
  }
  renderSpeakers();
}

// ---------------------------------------------------------------- session
async function refreshSession() {
  S.session = await api.session.current();
  if (!S.session) return;
  $('sessionName').value = S.session.name || 'Untitled Session';
  $('folderPath').textContent = S.session.folder || '';
  $('folderPath').title = S.session.folder || '';
  S.chunks = (S.session.chunks || []).map((c) => ({
    index: c.index, status: c.status, durationSec: c.durationSec,
  }));
  renderChunks();
  if (S.session.audioUrl) loadPlayer(S.session.audioUrl);
  if (S.session.transcript) {
    resetTranscript();
    setTranscriptData({
      words: S.session.transcript.words,
      segments: S.session.transcript.segments,
      wordSpeakers: S.session.wordSpeakers,
      diarization: S.session.diarization,
    });
  }
  await refreshDiarStatus();
}

async function openSessions() {
  $('sessionModal').classList.remove('hidden');
  await refreshSessionList();
}

async function refreshSessionList() {
  const list = $('sessionList');
  list.innerHTML = '';
  const parent = S.settings?.lastSessionParent;
  if (!parent) { list.appendChild(el('div', 'empty', 'No session folder chosen yet — click "New session…".')); return; }
  const sessions = await api.session.list(parent);
  if (!sessions.length) { list.appendChild(el('div', 'empty', `No sessions in ${parent}`)); return; }
  for (const s of sessions) {
    const item = el('div', 'sess-item');
    item.appendChild(el('div', 't', s.name || '(untitled)'));
    item.appendChild(el('div', 'm', `${s.folder}  ·  ${fmtClock(s.durationSec)}  ·  ${s.transcribed}/${s.chunks} chunks`));
    item.onclick = async () => {
      const res = await api.session.open(s.folder);
      if (!res.ok) { showToast(`open failed: ${res.error}`); return; }
      $('sessionModal').classList.add('hidden');
      await refreshSession();
      S.activeWord = -1;
      showToast(`opened ${res.session.name}`);
    };
    list.appendChild(item);
  }
}

async function newSession() {
  let parent = S.settings?.lastSessionParent;
  if (!parent) {
    parent = await api.session.pickFolder();
    if (!parent) return;
    S.settings = await api.settings.get();
  }
  const name = $('sessionName').value.trim() || 'Session';
  const res = await api.session.create({ parentDir: parent, name });
  if (!res.ok) { showToast(`create failed: ${res.error}`); return; }
  $('sessionModal').classList.add('hidden');
  await refreshSession();
  showToast(`session created in ${parent}`);
}

// ---------------------------------------------------------------- import media
// Prerecorded audio OR video -> ffmpeg decodes the audio track -> a normal session
// with the same chunking, transcription pipeline, karaoke sync and exports.
let importing = false;

async function importMedia() {
  if (importing) { showToast('an import is already running'); return; }
  if (S.recording) { showToast('stop recording before importing'); return; }
  const mediaPath = await api.import.pickMedia();
  if (!mediaPath) return;
  if (!S.settings?.lastSessionParent) {
    const dir = await api.session.pickFolder();
    if (!dir) { showToast('a session folder is needed before importing'); return; }
    S.settings = await api.settings.get();
  }

  importing = true;
  viz.setImport();
  setStatus('Importing', 'processing');
  $('sessionModal').classList.add('hidden');
  const base = mediaPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  $('sessionName').value = base;
  showToast(`importing ${base}…`);

  const res = await api.import.run({ mediaPath, name: base });
  importing = false;
  if (!res.ok) {
    showToast(`import failed: ${res.error}`);
    viz.setIdle();
    setStatus('Idle', 'idle');
    return;
  }
  // import done -> transcription; the import shimmer keeps running on the rail
  // until the LAST chunk finishes (handled in the 'pipeline' handler), not just
  // for the first chunk. `importing` stays true through transcription.
  S.importing = true;
  S.importSeconds = { done: res.seconds, total: res.seconds };
  await refreshSession();
  S.activeWord = -1;
  setStatus('Processing', 'processing');
  showToast(`imported ${base} · ${fmtClock(res.seconds)} · ${res.chunks} chunks — transcribing`);
}

// ---------------------------------------------------------------- settings
/** v1.5 theme picker: re-renders after each pick so the `on` state follows. */
function renderTheme() {
  renderThemePicker($('themeList'), {
    theme: S.settings.theme || 'default',
    themeMode: S.settings.themeMode || 'dark',
    onPick: async (id) => {
      S.settings = await api.settings.set({ theme: id });
      applyTheme(S.settings.theme, S.settings.themeMode, viz);
      renderTheme();
    },
    onMode: async (m) => {
      S.settings = await api.settings.set({ themeMode: m });
      applyTheme(S.settings.theme, S.settings.themeMode, viz);
      renderTheme();
    },
  });
}

function openSettings() {
  $('settingsDrawer').classList.remove('hidden');
  renderDiag();
}

function renderDiag() {
  const g = S.gpu || {};
  const e = S.engine || {};
  const pk = e.engines?.parakeet || {};
  const lines = [
    `app        ${S.appVersion || '?'}`,
    `gpu        ${g.vendor} ${g.model}${g.compute ? ` (sm_${String(g.compute).replace('.', '')})` : ''}`,
    `cuda       ${g.cuda ? 'yes' : 'no'}   accelerated: ${g.accelerated ? 'yes' : 'no'}`,
    `engine     ${e.engines?.active || 'whisper'}`,
    `whisper    ${e.binary || 'not found'}`,
    `whisperCUDA ${e.binaryCuda ? 'yes' : 'no'}`,
    `models     ${(e.models || []).map((m) => `${m.id} (${m.mb}MB)`).join(', ') || 'none'}`,
    `parakeet   ${pk.available ? (pk.model || 'available') : `unavailable — ${pk.reason || 'not provisioned'}`}`,
    `mode       ${e.available ? 'LIVE transcription' : 'DEMO (placeholder words)'}`,
    `reason     ${e.reason || '-'}`,
    `diarizer   ${S.diar?.binary || 'not found'}`,
    `diar model ${S.diar?.model || 'none'}`,
    `speakers   ${S.diar?.available ? 'available' : `unavailable — ${S.diar?.reason || '?'}`}`,
    ``,
    `bin dir    ${S.paths?.bin}`,
    `model dir  ${S.paths?.models}`,
  ];
  $('diag').textContent = lines.join('\n');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

async function refreshEngine() {
  S.engine = await api.engine.status();
  renderBanner();
  renderDiag();
  await renderModels();
}

/** Model manager: installed / downloadable / downloading, with progress. */
async function renderModels() {
  const box = $('modelList');
  if (!box) return;
  let catalog = [];
  try { catalog = await api.models.catalog(); } catch { /* leave empty */ }
  S.catalog = catalog;
  box.innerHTML = '';
  if (!catalog.length) { box.appendChild(el('div', 'empty', 'No models available.')); return; }

  const activeId = S.settings?.model || 'small.en';

  for (const m of catalog) {
    const row = el('div', 'model-row');
    if (m.installed) row.classList.add('installed');
    if (m.id === activeId) row.classList.add('active-model');
    row.dataset.id = m.id;

    const main = el('div', 'model-main');
    const nameLine = el('div', 'model-name');
    nameLine.appendChild(el('span', null, m.id));
    if (m.lang === 'multi') nameLine.appendChild(el('span', 'badge', 'multi'));
    if (m.id === activeId) nameLine.appendChild(el('span', 'badge active', 'active'));
    if (m.installed) nameLine.appendChild(el('span', 'badge ok', fmtSize(m.bytes)));
    main.appendChild(nameLine);
    main.appendChild(el('div', 'model-note', m.note));
    row.appendChild(main);

    const actions = el('div', 'model-actions');
    if (m.downloading) {
      const pct = el('span', 'model-pct', '0%');
      actions.appendChild(pct);
      const b = el('button', 'src-btn', 'cancel');
      b.onclick = async () => { await api.models.cancel(m.id); await renderModels(); };
      actions.appendChild(b);
      row._pct = pct;
    } else if (m.installed) {
      if (m.id !== activeId) {
        const use = el('button', 'src-btn', 'use');
        use.onclick = () => useModel(m.id);
        actions.appendChild(use);
      }
      const del = el('button', 'src-btn', '✕');
      del.title = 'delete this model from disk';
      del.onclick = () => removeModel(m.id, activeId);
      actions.appendChild(del);
    } else {
      const b = el('button', 'src-btn', `download ${fmtSize(m.mb * 1e6)}`);
      b.onclick = () => downloadModel(m.id);
      actions.appendChild(b);
    }
    row.appendChild(actions);

    if (m.downloading) {
      const prog = el('div', 'model-progress');
      prog.appendChild(el('i'));
      row.appendChild(prog);
    }
    box.appendChild(row);
  }
}

async function useModel(id) {
  S.settings = await api.settings.set({ model: id });
  showToast(`model set to ${id}`);
  await renderModels();
  await refreshEngine();
}

async function downloadModel(id) {
  showToast(`downloading ${id} - this can take a few minutes`);
  const job = api.models.download(id);
  setTimeout(() => { renderModels(); }, 400);        // let main register the job first
  const res = await job;
  if (!res.ok && !res.cancelled) showToast(`download failed: ${res.error}`);
  else if (res.ok) showToast(`${id} downloaded`);
  await renderModels();
  await refreshEngine();
}

async function removeModel(id, activeId) {
  if (id === activeId) { showToast('switch to another model before deleting this one'); return; }
  const res = await api.models.remove(id);
  if (res.ok) showToast(`removed ${id}`);
  else showToast(`remove failed: ${res.error}`);
  await renderModels();
  await refreshEngine();
}

/** One-time in-app provisioning of the parakeet engine (~515 MB, engine + model). */
async function downloadParakeet() {
  if (S.parakeetDownloading) { showToast('parakeet download already running'); return { ok: false }; }
  S.parakeetDownloading = true;
  const offProgress = api.on('parakeetProgress', (p) => {
    const pct = Math.round((p.pct || 0) * 100);
    showToast(`parakeet ${p.phase}: ${pct}%`);
  });
  try {
    const res = await api.parakeet.download();
    if (res.ok) {
      showToast('parakeet installed - select it again to switch');
    } else if (!res.cancelled) {
      showToast(`parakeet install failed: ${res.error}`);
    }
    return res;
  } finally {
    S.parakeetDownloading = false;
    offProgress();
    await refreshEngine();
  }
}

// ---------------------------------------------------------------- banners / status
function setStatus(text, cls) {
  const p = $('statusPill');
  p.textContent = text;
  p.className = `pill pill-${cls}`;
  $('vizState').textContent = text;
}

/** Update pill: quiet unless an update is actually available/downloaded. */
function renderUpdatePill(u) {
  const pill = $('updatePill');
  if (!pill || !u || !u.feedConfigured) return;
  if (u.downloaded) {
    pill.textContent = `restart to update${u.info?.version ? ` → ${u.info.version}` : ''}`;
    pill.className = 'pill pill-ok';
    pill.onclick = () => api.update.install();
    return;
  }
  if (u.available && !u.downloading) {
    pill.textContent = `update ${u.info?.version || ''} — download`;
    pill.className = 'pill pill-attention';
    pill.onclick = () => api.update.download();
    return;
  }
  if (u.downloading) {
    pill.textContent = `updating ${Math.round(u.info?.pct || 0)}%`;
    pill.className = 'pill';
    pill.onclick = null;
    return;
  }
  // not-available / checking / error: stay hidden (errors are in diagnostics)
  pill.className = 'pill hidden';
}

function watchUpdates() {
  api.on('updateStatus', (u) => {
    S.update = u;
    renderUpdatePill(u);
  });
  api.update.status().then((u) => { S.update = u; renderUpdatePill(u); }).catch(() => {});
}

function renderBanner() {
  const b = $('banner');
  const e = S.engine;
  if (!e) return;
  if (!e.available) {
    b.className = 'banner warn demo';
    b.textContent = `DEMO MODE — ${e.reason} Add whisper-cli.exe + a ggml model to native/ and relaunch.`;
    b.classList.remove('hidden');
    return;
  }
  if (!e.gpu?.accelerated) {
    b.className = 'banner warn';
    b.textContent = `CPU transcription — ${e.gpu?.reason || ''} Everything works, just slower.`;
    b.classList.remove('hidden');
    return;
  }
  b.className = 'banner ok';
  b.textContent = `GPU accelerated — ${e.gpu.model} via whisper.cpp CUDA. Model: ${e.models?.[0]?.id || '?'}`;
  b.classList.remove('hidden');
}

// ---------------------------------------------------------------- render loop
function loop() {
  engine.updateLevels();

  // source meters
  for (const s of S.sources) {
    if (!s._fill) continue;
    const t = engine.tracks.find((x) => x.cfg.id === s.id);
    const v = t ? Math.min(1, Math.pow(t.smooth * 7.5, 0.6)) : 0;
    s._fill.style.width = `${Math.round(v * 100)}%`;
  }

  if (S.recording) {
    $('timer').textContent = fmtClock(S.recordedSeconds);
  }

  // playback follow
  const p = $('player');
  if (!p.paused && p.duration) {
    highlightAt(p.currentTime);
    $('playTime').textContent = `${fmtT(p.currentTime)} / ${fmtT(p.duration)}`;
  }

  viz.draw();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('btnRecord').onclick = toggleRecord;
  $('btnPause').onclick = togglePause;
  $('btnAddMic').onclick = addMic;
  $('btnAddSys').onclick = addSystem;

  $('btnFolder').onclick = async () => {
    const dir = await api.session.pickFolder();
    if (!dir) return;
    S.settings = await api.settings.get();
    $('folderPath').textContent = dir;
    $('folderPath').title = dir;
    showToast(`session folder: ${dir}`);
  };

  $('btnSettings').onclick = openSettings;
  $('btnCloseSettings').onclick = () => $('settingsDrawer').classList.add('hidden');
  renderTheme();
  $('btnSessions').onclick = openSessions;
  $('btnCloseSessions').onclick = () => $('sessionModal').classList.add('hidden');
  $('btnNewSession').onclick = newSession;
  $('btnImportMedia').onclick = importMedia;
  $('btnOpenFolder').onclick = async () => {
    const res = await api.session.openDialog();
    if (!res.ok) { if (res.error !== 'cancelled') showToast(`open failed: ${res.error}`); return; }
    $('sessionModal').classList.add('hidden');
    await refreshSession();
    showToast(`opened ${res.session.name}`);
  };
  $('btnRefreshList').onclick = refreshSessionList;
  $('btnRetryAll').onclick = async () => {
    const r = await api.pipeline.retryAll();
    if (!r.ok) showToast(r.error);
    else showToast('re-queued outstanding chunks');
  };

  $('sessionName').onchange = async () => {
    if (!S.session) return;
    const name = $('sessionName').value.trim() || 'Session';
    const r = await api.session.rename(name);
    if (r.ok) { S.session.name = name; showToast('session renamed'); }
    else showToast(`rename failed: ${r.error}`);
  };

  $('chunkSec').onchange = async () => {
    S.settings = await api.settings.set({ chunkSec: Number($('chunkSec').value) });
  };

  // playback
  const p = $('player');
  p.onplay = () => {
    S.playing = true;
    setFollow(true);
    try {
      if (!p._actx) {
        p._actx = new AudioContext();
        const src = p._actx.createMediaElementSource(p);
        const an = p._actx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        an.connect(p._actx.destination);
        p._an = an;
      }
      p._actx.resume();
      viz.setPlayback(p._an, 128);
    } catch (e) { /* analyser is a nicety */ }
  };
  p.onpause = () => {
    S.playing = false;
    if (S.paused) viz.setPaused();
    else if (S.recording) viz.setCapture(engine.tracks);
    else viz.setIdle();
  };
  p.onended = () => { S.playing = false; viz.setIdle(); $('btnPlay').textContent = '▶ Play'; };
  p.ontimeupdate = () => { $('playTime').textContent = `${fmtT(p.currentTime)} / ${fmtT(p.duration || 0)}`; };

  $('btnPlay').onclick = () => {
    if (p.paused) { p.play(); $('btnPlay').textContent = '❚❚ Pause'; }
    else { p.pause(); $('btnPlay').textContent = '▶ Play'; }
  };
  $('btnStopPlay').onclick = () => {
    p.pause(); p.currentTime = 0; S.activeWord = -1;
    for (const sp of S.wordSpans) sp.classList.remove('active', 'past');
    $('btnPlay').textContent = '▶ Play';
    setFollow(true);
  };

  // Transcript follow: if the user scrolls away we stop chasing them and offer to resume.
  // Human scrolling also feeds the visualizer's "reading current" (v1.2); programmatic
  // karaoke scrolling must not drive it.
  const txBox = $('transcript');
  let lastScrollTop = txBox.scrollTop;
  let lastScrollT = performance.now();
  txBox.addEventListener('scroll', () => {
    if (!programmaticScroll) {
      const nowT = performance.now();
      const v = (txBox.scrollTop - lastScrollTop) / Math.max(8, nowT - lastScrollT) * 1000;
      lastScrollTop = txBox.scrollTop;
      lastScrollT = nowT;
      viz.setScrollVelocity(v);
    }
    const nearBottom = txBox.scrollHeight - txBox.scrollTop - txBox.clientHeight < 48;
    if (nearBottom && followPaused) setFollow(true);
    else if (!nearBottom && !followPaused) setFollow(false);
  });
  $('btnFollow').onclick = () => setFollow(true);

  // exports
  for (const btn of document.querySelectorAll('[data-export]')) {
    btn.onclick = async () => {
      const kind = btn.dataset.export;
      const res = await api.exportRun(kind);
      if (!res.ok) { showToast(`export failed: ${res.error}`); $('exportMsg').textContent = ''; return; }
      $('exportMsg').textContent = `→ ${res.path}`;
      showToast(`exported ${kind} (${Math.round((res.bytes || 0) / 1024)} KB)`);
      refreshSession();
    };
  }

  // settings controls
  $('setLang').onchange = async () => { S.settings = await api.settings.set({ language: $('setLang').value }); };
  $('setDevice').onchange = async () => { S.settings = await api.settings.set({ device: $('setDevice').value }); };
  $('setEngine').onchange = async () => {
    const engineId = $('setEngine').value;
    const pk = S.engine?.engines?.parakeet;
    if (engineId === 'parakeet' && pk && !pk.available) {
      const provisioned = await api.parakeet.provisioned().catch(() => false);
      if (!provisioned && !S.parakeetDownloading) {
        showToast('parakeet is not installed - downloading (~510 MB, one time)');
        await downloadParakeet();
      } else if (provisioned) {
        showToast('parakeet files present but not detected - restart the app once');
      } else {
        showToast(`parakeet unavailable: ${pk.reason}`);
      }
      $('setEngine').value = S.settings.engine || 'whisper';
      return;
    }
    S.settings = await api.settings.set({ engine: engineId });
    showToast(engineId === 'parakeet' ? 'engine: parakeet (sherpa-onnx)' : 'engine: whisper.cpp');
    await refreshEngine();
  };
  $('setChunk').onchange = async () => {
    S.settings = await api.settings.set({ chunkSec: Number($('setChunk').value) });
    $('chunkSec').value = $('setChunk').value;
  };
  $('setVad').onchange = async () => { S.settings = await api.settings.set({ vad: $('setVad').checked }); };
  $('setDiarAuto').onchange = async () => {
    S.settings = await api.settings.set({ diarizeAutoOnStop: $('setDiarAuto').checked });
  };
  $('btnDiarize').onclick = runDiarize;

  // main -> renderer events
  api.on('recordState', (st) => {
    S.recording = !!st.recording;
    S.paused = !!st.paused;
    if (Number.isFinite(st.durationSec)) S.recordedSeconds = st.durationSec;
    renderRecordControls();
    renderSpeakers();
  });
  // speaker identification (manual runs toast from runDiarize; these cover auto-runs)
  api.on('diarizeProgress', (p) => {
    if (!sameFolder(p?.folder, S.session?.folder)) return;
    S.diarizing = true;
    renderSpeakers();
  });
  api.on('diarizeDone', (p) => {
    if (!sameFolder(p?.folder, S.session?.folder)) return;
    S.diarizing = false;
    if (!S.diarManual) showToast(`${p.speakers} speaker${p.speakers === 1 ? '' : 's'} identified`);
    renderSpeakers();
  });
  api.on('diarizeError', (p) => {
    if (!sameFolder(p?.folder, S.session?.folder)) return;
    S.diarizing = false;
    if (!S.diarManual) {
      showToast(p.cancelled ? 'speaker identification cancelled' : `speaker identification failed: ${p.error}`);
    }
    renderSpeakers();
  });
  api.on('chunks', (chunks) => { S.chunks = chunks; renderChunks(); });
  api.on('import', (p) => {
    if (p?.phase === 'decoding') {
      $('recSub').textContent = `importing · ${fmtClock(p.seconds)} / ${fmtClock(p.total)}`;
      // the grid's wavefront line tracks decode progress (docs/v1.2-animations.md §C)
      if (Number.isFinite(p.total) && p.total > 0) {
        viz.setImport(Math.min(1, Math.max(0, (p.seconds || 0) / p.total)));
      }
    } else if (p?.phase === 'done') {
      $('recSub').textContent = `imported · ${fmtClock(p.total)}`;
    }
  });
  api.on('chunk', (c) => {
    const found = S.chunks.find((x) => x.index === c.index);
    if (found) {
      found.status = c.status;
      if (c.durationSec != null) found.durationSec = c.durationSec;
    } else {
      S.chunks.push({ index: c.index, status: c.status, durationSec: c.durationSec || 0 });
    }
    renderChunks();
    if (c.status === 'error') viz.pulse('error');
  });
  api.on('chunkDone', (c) => {
    // pipeline emits chunkDone without a preceding 'chunk' done event in older builds;
    // keep both paths marking completion so the strip never freezes mid-state
    const found = S.chunks.find((x) => x.index === c?.index);
    const fresh = found && found.status !== 'done';
    if (fresh) { found.status = 'done'; renderChunks(); }
    // a soft heartbeat travels down the grid for every finished chunk
    if (fresh || !found) viz.pulse('done');
    const p = $('player');
    // keep the player pointed at the freshest full.wav once processing settles
    if (!S.recording && !p.src) api.session.buildFull().then((r) => { if (r.ok) loadPlayer(r.audioUrl); });
  });
  api.on('transcript', (t) => setTranscriptData(t));
  api.on('pipeline', (st) => {
    if (st.remaining === 0) {
      setStatus(S.paused ? 'Paused' : S.recording ? 'Recording' : 'Ready', S.paused ? 'paused' : S.recording ? 'recording' : 'idle');
      if (S.importing && !S.recording) { S.importing = false; viz.sweep(); viz.setIdle(); }
      renderSpeakers();
      if (!S.recording) api.session.buildFull().then((r) => { if (r.ok) loadPlayer(r.audioUrl); });
    }
  });

  // model download lifecycle
  api.on('modelProgress', (p) => {
    const row = document.querySelector(`.model-row[data-id="${p.id}"]`);
    if (!row) return;
    const bar = row.querySelector('.model-progress > i');
    const pct = Math.round((p.pct || 0) * 100);
    if (bar) bar.style.width = `${pct}%`;
    if (row._pct) row._pct.textContent = `${pct}%  ${fmtSize(p.got)}`;
  });
  api.on('modelDone', async (m) => {
    showToast(`${m.id} downloaded (${fmtSize((m.mb || 0) * 1e6)})`);
    await renderModels();
    await refreshEngine();
  });
  api.on('modelError', async (m) => {
    if (!m.cancelled) showToast(`model download failed: ${m.error}`);
    await renderModels();
  });
  api.on('modelRemoved', async () => { await renderModels(); await refreshEngine(); });
}

// ---------------------------------------------------------------- boot
async function boot() {
  S.settings = await api.settings.get();
  S.appVersion = await api.app.version();
  S.paths = await api.app.paths();
  S.gpu = await api.gpu.probe();
  S.engine = await api.engine.status();

  $('chunkSec').value = String(S.settings.chunkSec || 60);
  $('setChunk').value = String(S.settings.chunkSec || 60);
  $('setLang').value = S.settings.language || 'en';
  $('setDevice').value = S.settings.device || 'auto';
  const engineVal = S.settings.engine || 'whisper';
  $('setEngine').value = engineVal;
  if (engineVal === 'parakeet' && S.engine?.engines?.parakeet && !S.engine.engines.parakeet.available) {
    $('setEngine').value = 'whisper';   // unavailable engine: don't offer a dead selection
  }
  $('setVad').checked = S.settings.vad !== false;
  $('setDiarAuto').checked = !!S.settings.diarizeAutoOnStop;
  // v1.5: apply the persisted theme BEFORE first paint of dependent UI, no animation.
  initTheme(S.settings.theme, S.settings.themeMode, viz);
  try { S.diar = await api.diarize.status(); } catch { S.diar = null; }
  await renderModels();
  if (S.settings.lastSessionParent) {
    $('folderPath').textContent = S.settings.lastSessionParent;
    $('folderPath').title = S.settings.lastSessionParent;
  }

  renderBanner();
  renderSources();
  wire();
  watchUpdates();

  const cur = await api.session.current();
  if (cur) await refreshSession();
  else setStatus('Idle', 'idle');

  requestAnimationFrame(loop);
  api.app.ready();
}

boot().catch((e) => {
  window.__err = String(e);
  showToast(`boot failed: ${e.message || e}`);
  console.error(e);
});
