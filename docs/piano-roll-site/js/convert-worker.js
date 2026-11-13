// Web Worker: downloads (and caches) the piano model, then transcribes 16 kHz mono audio.
// Messages in:  { audio: Float32Array }
// Messages out: { type: 'progress', p, m } | { type: 'done', notes } | { type: 'error', message }
importScripts('../vendor/ort/ort.wasm.min.js', 'piano-model.js');

const MODEL_URL = new URL('../model/piano_note_fp16.onnx', self.location.href).href;
const CACHE = 'piano-roll-model-v1';
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let sessionPromise = null;
const post = (p, m) => self.postMessage({ type: 'progress', p, m });

async function fetchModel() {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(MODEL_URL); if (hit) return await hit.arrayBuffer(); } catch (e) { cache = null; }
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error('Could not download the piano model (' + res.status + ').');
  const total = +res.headers.get('content-length') || 49.4e6;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    post(0.25 * Math.min(1, got / total), `Downloading the piano model: ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB (first time only)`);
  }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (cache) { try { await cache.put(MODEL_URL, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {} }
  return buf.buffer;
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const buf = await fetchModel();
      post(0.27, 'Starting the piano model');
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

self.onmessage = async (e) => {
  try {
    post(0, 'Loading the piano model');
    const session = await getSession();
    const notes = await PianoModel.transcribe(ort, session, e.data.audio, (p, m) => post(0.3 + 0.7 * p, m));
    self.postMessage({ type: 'done', notes });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
