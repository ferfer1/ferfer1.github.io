// Runs the ByteDance high-resolution piano transcription note model (Kong et al., 2020)
// through onnxruntime, then turns its frame-wise outputs into notes. The post-processing
// is a line-by-line port of piano_transcription_inference's RegressionPostProcessor.
(function (root) {
'use strict';

const SR = 16000, SEG = 160000, FPS = 100, CLASSES = 88, BEGIN_NOTE = 21, VEL_SCALE = 128;
const ONSET_T = 0.3, OFFSET_T = 0.3, FRAME_T = 0.1;
const KEYS = ['reg_onset_output', 'reg_offset_output', 'frame_output', 'velocity_output'];

// Audio (16 kHz mono) -> 10 s segments with 50 % overlap, same as the Python enframe().
function enframe(x) {
  const padded = Math.ceil(x.length / SEG) * SEG || SEG;
  const segs = [];
  for (let p = 0; p + SEG <= padded; p += SEG / 2) {
    const s = new Float32Array(SEG);
    s.set(x.subarray(p, Math.min(p + SEG, x.length)));
    segs.push(s);
  }
  return segs;
}

// Per-segment outputs (frames x 88, row-major) -> one continuous roll, same as deframe().
function deframe(parts) {
  const N = parts.length;
  if (N === 1) return parts[0];
  const F = parts[0].length / CLASSES - 1;           // drop the extra last frame
  const q = F / 4;
  const ranges = parts.map((_, i) => i === 0 ? [0, 3 * q] : i === N - 1 ? [q, F] : [q, 3 * q]);
  const total = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Float32Array(total * CLASSES);
  let o = 0;
  parts.forEach((p, i) => { const [a, b] = ranges[i]; out.set(p.subarray(a * CLASSES, b * CLASSES), o); o += (b - a) * CLASSES; });
  return out;
}

function binarize(reg, frames, threshold, neighbour) {
  const bin = new Uint8Array(frames * CLASSES), shift = new Float32Array(frames * CLASSES);
  for (let k = 0; k < CLASSES; k++) {
    const x = (n) => reg[n * CLASSES + k];
    for (let n = neighbour; n < frames - neighbour; n++) {
      if (!(x(n) > threshold)) continue;
      let mono = true;
      for (let i = 0; i < neighbour; i++) {
        if (x(n - i) < x(n - i - 1)) mono = false;
        if (x(n + i) < x(n + i + 1)) mono = false;
      }
      if (!mono) continue;
      bin[n * CLASSES + k] = 1;
      shift[n * CLASSES + k] = x(n - 1) > x(n + 1)
        ? (x(n + 1) - x(n - 1)) / (x(n) - x(n + 1)) / 2
        : (x(n + 1) - x(n - 1)) / (x(n) - x(n - 1)) / 2;
    }
  }
  return { bin, shift };
}

// Port of note_detection_with_onset_offset_regress (Python truthiness kept: frame 0 counts as "no onset").
function detectNotes(r, frames) {
  const on = binarize(r.reg_onset_output, frames, ONSET_T, 2);
  const off = binarize(r.reg_offset_output, frames, OFFSET_T, 4);
  const frame = r.frame_output, vel = r.velocity_output;
  const notes = [];
  for (let k = 0; k < CLASSES; k++) {
    const at = (arr, i) => arr[i * CLASSES + k];
    let bgn = 0, frameGone = 0, offAt = 0;
    const push = (b, fin, offShift) => notes.push({
      start: (b + at(on.shift, b)) / FPS, end: (fin + offShift) / FPS,
      pitch: k + BEGIN_NOTE, vel: Math.max(1, Math.min(127, Math.floor(at(vel, b) * VEL_SCALE))),
    });
    for (let i = 0; i < frames; i++) {
      if (at(on.bin, i) === 1) {
        if (bgn) { push(bgn, Math.max(i - 1, 0), 0); frameGone = 0; offAt = 0; }
        bgn = i;
      }
      if (bgn && i > bgn) {
        if (at(frame, i) <= FRAME_T && !frameGone) frameGone = i;
        if (at(off.bin, i) === 1 && !offAt) offAt = i;
        if (frameGone) {
          const fin = offAt && offAt - bgn > frameGone - offAt ? offAt : frameGone;
          push(bgn, fin, at(off.shift, fin));
          bgn = 0; frameGone = 0; offAt = 0;
        }
        if (bgn && (i - bgn >= 600 || i === frames - 1)) {
          push(bgn, i, at(off.shift, i));
          bgn = 0; frameGone = 0; offAt = 0;
        }
      }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const n of notes) if (n.end <= n.start) n.end = n.start + 0.02;
  return notes;
}

// ort: the onnxruntime namespace; session: an InferenceSession for piano_note.onnx.
async function transcribe(ort, session, audio16k, onProgress) {
  const segs = enframe(audio16k);
  const parts = Object.fromEntries(KEYS.map((k) => [k, []]));
  for (let i = 0; i < segs.length; i++) {
    if (onProgress) onProgress(i / segs.length, `Listening: ${Math.min(Math.round((i * SEG / 2 + SEG) / SR), Math.round(audio16k.length / SR))} of ${Math.round(audio16k.length / SR)} s`);
    const out = await session.run({ audio: new ort.Tensor('float32', segs[i], [1, SEG]) });
    for (const k of KEYS) parts[k].push(out[k].data);
  }
  if (onProgress) onProgress(1, 'Picking out notes');
  const rolls = {};
  for (const k of KEYS) rolls[k] = deframe(parts[k]);
  const frames = rolls.frame_output.length / CLASSES;
  return detectNotes(rolls, frames);
}

const api = { transcribe, SR, enframe, deframe, detectNotes };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PianoModel = api;
})(typeof self !== 'undefined' ? self : this);
