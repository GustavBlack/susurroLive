'use strict';
/**
 * Export: clean text, timecoded JSON, and the audio itself.
 * (Subtitles are deferred to v2 per docs/PLAN.md section 3.)
 *
 * Speakers: when the session carries a diarization block, .txt becomes one paragraph per
 * speaker turn and .json gains the block plus a derived `spk` on every word. Sessions without
 * one export byte-identical to before.
 */
const fs = require('fs');
const path = require('path');
const { isValidBlock, assignSpeakers, speakerNumber } = require('./diarize-join');

/** Same spacing rules as transcript.fullText (assemble.js). */
function joinWords(words) {
  return words.map((w) => w.w).join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One paragraph per run of the same speaker; a null-speaker word continues the current one. */
function speakerParagraphs(words, speakers) {
  const paras = [];
  let cur = null;
  words.forEach((w, i) => {
    const s = speakers[i];
    if (!cur || (s && s !== cur.spk)) {
      cur = { spk: s || null, words: [] };
      paras.push(cur);
    }
    cur.words.push(w);
  });
  return paras.map((p) => `${p.spk ? `Speaker ${speakerNumber(p.spk)}` : 'Speaker ?'}: ${joinWords(p.words)}`);
}

/** {block, speakers} when the session is diarized and has words, else null. */
function diarized(session) {
  const block = session.diarization;
  const words = session.transcript?.words || [];
  if (!isValidBlock(block) || !words.length) return null;
  return { block, speakers: assignSpeakers(words, block.turns) };
}

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(2).padStart(5, '0');
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${r}`
    : `${String(m).padStart(2, '0')}:${r}`;
}

function written(p) {
  const st = fs.statSync(p);
  return { path: p, bytes: st.size };
}

function exportTxt(session, outPath) {
  const d = diarized(session);
  const head = [
    session.name,
    `Recorded: ${session.recording?.startedAt || 'n/a'}`,
    `Duration: ${fmtTime(session.recording?.durationSec || 0)}  |  Model: ${session.model?.name}  |  Device: ${session.model?.device}`,
    ...(d ? [`Speakers: ${d.block.speakers} (numbered by order of first speaking)`] : []),
    '',
    '-'.repeat(60),
    '',
  ].join('\n');
  const body = d
    ? speakerParagraphs(session.transcript.words, d.speakers).join('\n\n')
    : session.transcript?.fullText || '(no transcript yet)';
  fs.writeFileSync(outPath, `${head}${body}\n`, 'utf8');
  return written(outPath);
}

function exportJson(session, outPath) {
  const d = diarized(session);
  const doc = {
    session: {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      durationSec: session.recording?.durationSec ?? 0,
    },
    model: session.model,
    sources: session.recording?.sources ?? [],
    transcript: {
      language: session.transcript?.language ?? null,
      fullText: session.transcript?.fullText ?? '',
      words: session.transcript?.words ?? [],
      segments: session.transcript?.segments ?? [],
    },
    chunks: (session.chunks || []).map((c) => ({
      index: c.index, offsetSec: c.offsetSec, durationSec: c.durationSec,
      status: c.status, engine: c.engine || null, audioFile: c.audioFile,
    })),
  };
  if (d) {
    // consumers get the speaker on each word, no join required
    doc.transcript.words = doc.transcript.words.map((w, i) => ({ ...w, spk: d.speakers[i] }));
    doc.diarization = d.block;
  }
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');
  return written(outPath);
}

/** Export a single audio file. Prefers the concatenated full.wav, else the chunks. */
function exportAudio(session, outPath, { concatWavs } = {}) {
  const full = path.join(session.folder, 'audio', 'full.wav');
  if (fs.existsSync(full)) {
    fs.copyFileSync(full, outPath);
    return written(outPath);
  }
  const chunks = (session.chunks || [])
    .sort((a, b) => a.index - b.index)
    .map((c) => path.join(session.folder, c.audioFile))
    .filter((p) => fs.existsSync(p));
  if (chunks.length === 0) throw new Error('no audio to export');
  if (concatWavs) {
    concatWavs(chunks, outPath);
    return written(outPath);
  }
  throw new Error('no concatenated audio available');
}

module.exports = { exportTxt, exportJson, exportAudio, fmtTime };
