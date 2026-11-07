// Voice search: record someone saying or singing a song, transcribe it with OpenAI,
// find the song (Genius lyric search + Spotify search), and return the top matches.
//
// API keys are stored only in this browser's localStorage, never on GitHub.
// Note: the Even app's built-in browser has its own storage, so keys must be
// entered once on the glasses page (inside the Even app) as well.
import { searchTracks } from "./spotify.js";

const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"]; // try in order
const GENIUS_URL = "https://api.genius.com/search";
export const MAX_LISTEN_MS = 10000;

// ---------- Keys ----------
export const getOpenAIKey = () => localStorage.getItem("openai_key") || "";
export const getGeniusToken = () => localStorage.getItem("genius_token") || "";
function saveKey(name, value) {
  value = value.trim();
  if (value) localStorage.setItem(name, value); else localStorage.removeItem(name);
}

/** Builds the "Voice search settings" box inside `container`. */
export function mountVoiceSettings(container) {
  container.innerHTML = `
    <details class="voice-settings">
      <summary>Voice search settings</summary>
      <label>OpenAI API key (for listening)
        <input id="vs-openai" type="password" autocomplete="off" placeholder="sk-..." />
      </label>
      <label>Genius access token (for finding songs by lyrics)
        <input id="vs-genius" type="password" autocomplete="off" placeholder="Client access token" />
      </label>
      <button id="vs-save" class="secondary">Save</button>
      <p class="hint" id="vs-status"></p>
      <p class="hint">Keys are saved only on this device, not on GitHub.</p>
    </details>`;
  const status = container.querySelector("#vs-status");
  const describe = () => {
    status.textContent = `OpenAI: ${getOpenAIKey() ? "saved ✓" : "not set"} · Genius: ${getGeniusToken() ? "saved ✓" : "not set"}`;
  };
  container.querySelector("#vs-save").onclick = () => {
    const openai = container.querySelector("#vs-openai");
    const genius = container.querySelector("#vs-genius");
    if (openai.value.trim()) saveKey("openai_key", openai.value);
    if (genius.value.trim()) saveKey("genius_token", genius.value);
    openai.value = genius.value = "";
    describe();
  };
  describe();
}

// ---------- Recording in a normal browser (phone / PC) ----------
/** Start recording from the device microphone. Returns { stop(): Promise<{ blob, filename }> }. */
export async function startBrowserRecording() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("Microphone permission was denied.");
  }
  const recorder = new MediaRecorder(stream);
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.start();

  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || parts[0]?.type || "audio/webm";
        const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
        resolve({ blob: new Blob(parts, { type }), filename: `voice.${ext}` });
      };
      recorder.state === "inactive" ? recorder.onstop() : recorder.stop();
    }),
  };
}

/** Free fallback when there's no OpenAI key: the browser's own speech recognition (talking works best). */
export function browserSpeechAvailable() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}
export function startBrowserSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Recognition();
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let text = "";
  const done = new Promise((resolve, reject) => {
    rec.onresult = (e) => { text = [...e.results].map((r) => r[0].transcript).join(" "); };
    rec.onerror = (e) => (e.error === "no-speech" ? resolve("") : reject(new Error(`Speech recognition: ${e.error}`)));
    rec.onend = () => resolve(text);
  });
  rec.start();
  return { stop: () => { rec.stop(); return done; } };
}

// ---------- Glasses microphone audio (raw PCM) → WAV ----------
/** Wrap raw 16-bit mono PCM chunks (from the glasses) in a WAV file. */
export function pcmToWav(chunks, sampleRate = 16000) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + length, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, length, true);
  let offset = 44;
  for (const c of chunks) { new Uint8Array(buffer, offset, c.length).set(c); offset += c.length; }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- OpenAI transcription ----------
export async function transcribe(blob, filename) {
  const key = getOpenAIKey();
  if (!key) throw new Error("Add your OpenAI key in Voice search settings.");

  let lastError;
  for (const model of OPENAI_MODELS) {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", model);
    form.append("prompt", "Someone is singing or saying song lyrics, or a song title and artist.");
    const res = await fetch(OPENAI_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });

    if (res.ok) return ((await res.json()).text || "").trim();
    if (res.status === 401) throw new Error("OpenAI rejected the API key.");
    if (res.status === 429) throw new Error("OpenAI quota or rate limit reached.");
    let msg = `OpenAI error (${res.status})`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    lastError = new Error(msg);
    if (!/model/i.test(msg)) break; // only fall back to the next model for model errors
  }
  throw lastError;
}

// ---------- Finding the song ----------
const cleanGenius = (s) => (s || "")
  .replace(/[ ​]/g, " ")
  .replace(/\s*\((feat|ft)\.?[^)]*\)/gi, "")
  .replace(/\s+/g, " ")
  .trim();

/** Songs on Genius whose lyrics/title match the text: [{ title, artist }]. */
async function geniusSearch(text) {
  const token = getGeniusToken();
  if (!token) return [];
  // Token in the URL (Genius supports this) avoids an extra CORS preflight request.
  const res = await fetch(`${GENIUS_URL}?${new URLSearchParams({ q: text, access_token: token })}`);
  if (res.status === 401) throw new Error("Genius rejected the access token.");
  if (!res.ok) return [];
  const hits = (await res.json())?.response?.hits ?? [];
  return hits
    .filter((h) => h.type === "song" && h.result)
    .map((h) => ({ title: cleanGenius(h.result.title), artist: cleanGenius(h.result.primary_artist?.name) }));
}

/**
 * Find up to `max` Spotify tracks matching what was heard.
 * Lyric matches from Genius come first, then Spotify's own title/artist search.
 */
export async function findSongs(text, max = 3) {
  const [genius, direct] = await Promise.all([
    geniusSearch(text).catch((e) => { if (/Genius/.test(e.message)) throw e; return []; }),
    searchTracks(text, 5).catch(() => []),
  ]);

  const fromGenius = await Promise.all(genius.slice(0, max).map(async ({ title, artist }) => {
    const exact = await searchTracks(`track:${title} artist:${artist}`, 1).catch(() => []);
    if (exact.length) return exact[0];
    return (await searchTracks(`${title} ${artist}`, 1).catch(() => []))[0];
  }));

  const seen = new Set();
  return [...fromGenius, ...direct]
    .filter((t) => t && !seen.has(t.id) && seen.add(t.id))
    .slice(0, max);
}
