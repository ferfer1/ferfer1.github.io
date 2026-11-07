// Lyrics for the current song, from LRCLIB (https://lrclib.net, free, no key needed),
// with automatic romanization of non-Latin lyrics:
//   Japanese → romaji (OpenAI if your key is set in Voice search settings — fast and
//              context-aware, saved per song; otherwise the kuroshiro dictionary in a worker)
//   Chinese  → pinyin (pinyin-pro)
//   Korean   → Revised Romanization (built-in rules)
//   Russian / Ukrainian (Cyrillic) → Latin letters (built-in table)
// Spotify's own lyrics aren't available through its public API.

import { getContextTracks } from "./spotify.js";
import { store } from "./storage.js";

const LRCLIB = "https://lrclib.net/api";
const KUROMOJI_DICT = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
const vendor = (file) => new URL(`./vendor/${file}`, import.meta.url).href;

// ---------- On/off setting (on by default) ----------
export const lyricsEnabled = () => store.get("lyrics_on") !== "0";
export const setLyricsEnabled = (on) => store.set("lyrics_on", on ? "1" : "0");

// ---------- Script detection ----------
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HAN = /[㐀-鿿豈-﫿]/;
const HANGUL = /[가-힯]/;
const CYRILLIC = /[Ѐ-ӿ]/;
// Anything that isn't basic/extended Latin, digits, punctuation or whitespace.
const NON_LATIN = /[^\u0000-ɏḀ-ỿ -⁯\s]/;

/** "ja" | "zh" | "ko" | "ru" | "latin" for a whole block of text. */
export function detectLanguage(text) {
  if (KANA.test(text)) return "ja";
  if (HANGUL.test(text)) return "ko";
  if (HAN.test(text)) return "zh";
  if (CYRILLIC.test(text)) return "ru";
  return "latin";
}

// ---------- Loading helper libraries on demand ----------
const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Couldn't load ${src}`));
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

// Japanese is converted in a background worker (romaji-worker.js): loading the
// ~12 MB dictionary on the main thread froze the page, especially on phones.
const ROMAJI_TIMEOUT_MS = 60000; // first use downloads the dictionary; give up after this
let romajiWorker = null;
let romajiJobId = 0;
const romajiJobs = new Map();

function getRomajiWorker() {
  if (!romajiWorker) {
    romajiWorker = new Worker(new URL("./romaji-worker.js", import.meta.url));
    romajiWorker.onmessage = ({ data }) => {
      const job = romajiJobs.get(data.id);
      if (!job) return;
      romajiJobs.delete(data.id);
      clearTimeout(job.timer);
      data.error ? job.reject(new Error(data.error)) : job.resolve(data.out);
    };
    romajiWorker.onerror = (e) => {
      // Worker crashed or couldn't load: fail every waiting job and start fresh next time.
      for (const job of romajiJobs.values()) { clearTimeout(job.timer); job.reject(new Error(e.message || "Romaji worker failed")); }
      romajiJobs.clear();
      romajiWorker?.terminate();
      romajiWorker = null;
    };
  }
  return romajiWorker;
}

/** Convert many Japanese texts to romaji in one go (in the background). */
function japaneseBatchToRomaji(texts) {
  return new Promise((resolve, reject) => {
    const id = ++romajiJobId;
    const timer = setTimeout(() => {
      romajiJobs.delete(id);
      reject(new Error("Romaji conversion took too long"));
    }, ROMAJI_TIMEOUT_MS);
    romajiJobs.set(id, { resolve, reject, timer });
    getRomajiWorker().postMessage({ id, texts, dictPath: KUROMOJI_DICT });
  }).then((out) => out.map(tidy));
}

let pinyinReady = null;
function getPinyin() {
  pinyinReady ??= loadScript(vendor("pinyin-pro.min.js")).then(() => window.pinyinPro.pinyin);
  pinyinReady.catch(() => { pinyinReady = null; });
  return pinyinReady;
}

// ---------- Romanizers ----------
// Macrons (ō, ū) may not exist in the glasses' font, so spell long vowels out.
const MACRONS = { ā: "aa", ī: "ii", ū: "uu", ē: "ee", ō: "ou", Ā: "Aa", Ī: "Ii", Ū: "Uu", Ē: "Ee", Ō: "Ou" };
const tidy = (s) => s
  .replace(/[āīūēōĀĪŪĒŌ]/g, (c) => MACRONS[c])
  .replace(/\s+/g, " ")
  .replace(/\s+([.,!?;:)\]」』])/g, "$1") // no space before punctuation
  .trim();

async function japaneseToRomaji(text) {
  return (await japaneseToRomajiMany([text]))[0];
}

// --- Japanese via OpenAI (preferred when a key is set) ---
// Much lighter than the 12 MB dictionary (which can fail inside the Even app),
// and it picks kanji readings from context, so the romaji is more accurate.
const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";
const ROMAJI_MODELS = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-mini"]; // first available wins
const ROMAJI_INSTRUCTIONS =
  "You convert Japanese song lyrics to Hepburn romaji. You receive JSON {\"lines\": [...]}. " +
  "Reply with JSON {\"lines\": [...]} containing exactly one romanized string per input line, in the same order. " +
  "Use the correct readings for the song's context. Lowercase, words separated by spaces. " +
  "Write long vowels with doubled letters (ou, uu, ei, aa) and never use macrons. " +
  "Keep English words and punctuation as they are. Never translate.";

const openAIKey = () => store.get("openai_key") || ""; // set in Voice search settings

async function openAIRomaji(texts) {
  let lastError;
  for (const model of ROMAJI_MODELS) {
    const res = await fetch(OPENAI_CHAT, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAIKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ROMAJI_INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ lines: texts }) },
        ],
      }),
    });
    if (res.ok) {
      const content = (await res.json()).choices?.[0]?.message?.content ?? "{}";
      const lines = JSON.parse(content).lines;
      if (!Array.isArray(lines)) throw new Error("OpenAI returned no romaji");
      return texts.map((_, i) => (typeof lines[i] === "string" ? tidy(lines[i]) : null));
    }
    if (res.status === 401) throw new Error("OpenAI rejected the API key.");
    if (res.status === 429) throw new Error("OpenAI quota or rate limit reached.");
    let msg = `OpenAI error (${res.status})`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    lastError = new Error(msg);
    if (!/model/i.test(msg)) break; // only try the next model on "unknown model" errors
  }
  throw lastError;
}

/**
 * Japanese → romaji for many texts: OpenAI if there's a key, else the dictionary worker.
 * With allowDictionary: false, OpenAI errors are thrown instead of falling back.
 */
async function japaneseToRomajiMany(texts, { allowDictionary = true } = {}) {
  if (!texts.length) return [];
  const unique = [...new Set(texts)]; // choruses repeat; convert each line once
  let converted;
  if (openAIKey()) {
    try {
      converted = await openAIRomaji(unique);
    } catch (e) {
      if (!allowDictionary) throw e;
      console.warn("OpenAI romaji failed, trying the dictionary instead:", e);
    }
  }
  converted ??= await japaneseBatchToRomaji(unique);
  const byText = new Map(unique.map((t, i) => [t, converted[i]]));
  return texts.map((t) => byText.get(t) ?? null);
}

// --- Saved romaji, so a song is only ever sent to OpenAI once ---
// Stored in this browser's IndexedDB (database "spotify-controller", table "romaji"), which is
// meant for larger data and is separate from the ~5 MB localStorage that all apps on
// ferfer1.github.io share. Each entry keeps the romaji plus a short fingerprint of the
// original lyrics (to notice if they change). Capped at 5,000 songs (~20 MB); when full,
// the songs played least recently are dropped first.
const DB_NAME = "spotify-controller";
const DB_STORE = "romaji";
const ROMAJI_MAX_SONGS = 5000;

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

let dbPromise = null;
const memoryFallback = new Map(); // only used if IndexedDB is unavailable (not saved across visits)

/** Open the database (once). Resolves to null if IndexedDB can't be used. */
function openDb() {
  dbPromise ??= new Promise((resolve) => {
    if (!self.indexedDB) return resolve(null);
    const timer = setTimeout(() => resolve(null), 15000); // generous, for slow phones
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      clearTimeout(timer);
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE, { keyPath: "key" }).createIndex("at", "at");
    };
    request.onsuccess = async () => {
      clearTimeout(timer);
      const db = request.result;
      await moveOldRomajiCache(db).catch((e) => console.warn("Couldn't move old saved romaji:", e));
      navigator.storage?.persist?.().catch(() => {}); // ask the browser not to clear it under pressure
      resolve(db);
    };
    request.onerror = request.onblocked = () => { clearTimeout(timer); resolve(null); };
  });
  return dbPromise;
}

/** Older versions saved romaji in localStorage ("romaji_cache"); move it into IndexedDB once. */
async function moveOldRomajiCache(db) {
  const raw = localStorage.getItem("romaji_cache") ?? localStorage.getItem("spotify:romaji_cache");
  if (!raw) return;
  const old = JSON.parse(raw);
  const tx = db.transaction(DB_STORE, "readwrite");
  for (const [key, e] of Object.entries(old)) {
    if (!Array.isArray(e?.out)) continue;
    const h = e.h ?? (Array.isArray(e.texts) ? fingerprint(e.texts) : null);
    if (h) tx.objectStore(DB_STORE).put({ key, at: e.at || Date.now(), h, out: e.out, size: JSON.stringify(e.out).length * 2 });
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  localStorage.removeItem("romaji_cache");
  localStorage.removeItem("spotify:romaji_cache");
}

async function dbGet(key) {
  const db = await openDb();
  if (!db) return memoryFallback.get(key);
  return asPromise(db.transaction(DB_STORE).objectStore(DB_STORE).get(key));
}

async function dbPut(entry, { trim = true } = {}) {
  const db = await openDb();
  if (!db) { memoryFallback.set(entry.key, entry); return; }
  await asPromise(db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(entry));
  if (trim) await trimRomaji(db);
}

/** Drop the least recently played songs beyond the cap. */
async function trimRomaji(db) {
  const store = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE);
  let extra = (await asPromise(store.count())) - ROMAJI_MAX_SONGS;
  if (extra <= 0) return;
  await new Promise((resolve, reject) => {
    const cursorRequest = store.index("at").openCursor(); // oldest first
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || extra-- <= 0) return resolve();
      cursor.delete();
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

/** Short fingerprint of a song's original texts (FNV-1a hash + length). */
function fingerprint(texts) {
  const s = texts.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

async function readRomajiCache(songKey, texts) {
  let entry;
  try { entry = await dbGet(songKey); } catch { return null; }
  if (!entry || entry.h !== fingerprint(texts)) return null;
  if (!Array.isArray(entry.out) || entry.out.length !== texts.length) return null;
  if (Date.now() - entry.at > 60_000) { // mark as recently played
    dbPut({ ...entry, at: Date.now() }, { trim: false }).catch(() => {});
  }
  return entry.out;
}

async function writeRomajiCache(songKey, texts, out) {
  try {
    await dbPut({ key: songKey, at: Date.now(), h: fingerprint(texts), out, size: JSON.stringify(out).length * 2 });
  } catch (e) {
    console.warn("Couldn't save romaji:", e); // e.g. storage full; the romaji still shows this time
  }
}

/** How much romaji is saved on this device: { songs, kb, persistent }. */
export async function romajiCacheStats() {
  const db = await openDb();
  if (!db) return { songs: memoryFallback.size, kb: 0, persistent: false };
  const all = await asPromise(db.transaction(DB_STORE).objectStore(DB_STORE).getAll());
  return { songs: all.length, kb: Math.round(all.reduce((n, e) => n + (e.size || 0), 0) / 1024), persistent: true };
}

/** Romanize a song's texts (title, artist, lyric lines); Latin-only texts come back as null. */
async function japaneseSongToRomaji(songKey, texts, options) {
  const cached = await readRomajiCache(songKey, texts);
  if (cached) return cached;
  const needed = texts.filter((t) => t && NON_LATIN.test(t));
  const converted = await japaneseToRomajiMany(needed, options);
  let j = 0;
  const out = texts.map((t) => (t && NON_LATIN.test(t) ? converted[j++] : null));
  await writeRomajiCache(songKey, texts, out);
  return out;
}

async function chineseToPinyin(text) {
  const pinyin = await getPinyin();
  return tidy(pinyin(text, { toneType: "none", nonZh: "consecutive" }).replace(/ü/g, "u"));
}

// Korean: Revised Romanization, with the common "carry the last consonant over" rule.
const KO_INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const KO_VOWEL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const KO_FINAL = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
// How a final consonant sounds when the next syllable starts with a vowel (ㅇ).
const KO_LINKED = { 1: "g", 2: "kk", 4: "n", 7: "d", 8: "r", 16: "m", 17: "b", 19: "s", 20: "ss", 21: "ng", 22: "j", 23: "ch", 24: "k", 25: "t", 26: "p", 27: "" };

function koreanToLatin(text) {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0) - 0xac00;
    if (code < 0 || code > 11171) { out += chars[i]; continue; }
    const initial = Math.floor(code / 588);
    const vowel = Math.floor((code % 588) / 28);
    const final = code % 28;

    const nextCode = (chars[i + 1]?.codePointAt(0) ?? 0) - 0xac00;
    const nextStartsWithVowel = nextCode >= 0 && nextCode <= 11171 && Math.floor(nextCode / 588) === 11;
    const finalSound = nextStartsWithVowel && final in KO_LINKED ? KO_LINKED[final] : KO_FINAL[final];
    out += KO_INITIAL[initial] + KO_VOWEL[vowel] + finalSound;
  }
  return tidy(out);
}

const CYR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g", ў: "w",
};
function cyrillicToLatin(text) {
  return tidy([...text].map((c) => {
    const lower = c.toLowerCase();
    if (!(lower in CYR)) return c;
    const latin = CYR[lower];
    return c === lower ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
  }).join(""));
}

/**
 * Romanize text. `language` is a hint from detectLanguage() on the whole song
 * (needed because a line of only kanji could be Japanese or Chinese).
 * Returns null if the text is already in Latin letters.
 */
export async function romanize(text, language = detectLanguage(text)) {
  if (!text || !NON_LATIN.test(text)) return null;
  if (KANA.test(text)) language = "ja";
  switch (language) {
    case "ja": return japaneseToRomaji(text);
    case "zh": return chineseToPinyin(text);
    case "ko": return koreanToLatin(text);
    case "ru": return cyrillicToLatin(text);
    default:
      if (HANGUL.test(text)) return koreanToLatin(text);
      if (CYRILLIC.test(text)) return cyrillicToLatin(text);
      if (HAN.test(text)) return chineseToPinyin(text);
      return null; // other scripts: show as-is
  }
}

// ---------- LRCLIB ----------
/** Parse "[mm:ss.xx] text" lines (a line may have several timestamps). */
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const [, m, s] of stamps) lines.push({ time: (Number(m) * 60 + Number(s)) * 1000, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

async function lrclib(path, params) {
  const res = await fetch(`${LRCLIB}${path}?${new URLSearchParams(params)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Lyrics service error (${res.status})`);
  return res.json();
}

async function findLyrics(item) {
  const track = item.name;
  const artist = item.artists?.[0]?.name ?? "";
  const seconds = Math.round((item.duration_ms ?? 0) / 1000);

  // 1) Exact match on title, artist, album and length.
  const exact = await lrclib("/get", {
    track_name: track, artist_name: artist, album_name: item.album?.name ?? "", duration: seconds,
  });
  if (exact?.syncedLyrics || exact?.instrumental) return exact;

  // 2) The exact match may only have unsynced lyrics, so search for a synced
  //    version with a similar length, then any synced version.
  const results = (await lrclib("/search", { track_name: track, artist_name: artist })) ?? [];
  const close = (r) => Math.abs((r.duration ?? 0) - seconds) <= 4;
  return results.find((r) => r.syncedLyrics && close(r))
    ?? results.find((r) => r.syncedLyrics)
    ?? (exact?.plainLyrics ? exact : null)
    ?? results.find((r) => r.plainLyrics)
    ?? null;
}

// ---------- Shared song analysis ----------
const songKey = (item) => item.id || item.uri || item.name;

/**
 * Work out a song's lyric lines and what needs romanizing. Used by both the live player
 * and "Romanize this playlist now", so they produce identical saved entries.
 */
function analyzeSong(item, found) {
  const language = detectLanguage([item.name, found?.syncedLyrics || found?.plainLyrics || ""].join("\n"));
  const synced = Boolean(found?.syncedLyrics);
  const lines = !found ? []
    : synced ? parseLrc(found.syncedLyrics)
    : (found.plainLyrics || "").split(/\r?\n/).map((text) => ({ time: null, text: text.trim() }));
  const todo = lines.filter((l) => NON_LATIN.test(l.text));
  const artistText = item.artists?.map((a) => a.name).join(", ") ?? "";
  const japanese = language === "ja" || KANA.test(item.name) || todo.some((l) => KANA.test(l.text));
  return { language, synced, lines, todo, artistText, japanese, texts: [item.name, artistText, ...todo.map((l) => l.text)] };
}

// ---------- "Romanize this playlist now" ----------
/**
 * Pre-romanize every Japanese song in a list of Spotify tracks, so nothing waits while
 * listening. Songs already saved are skipped (no tokens). Each song is one OpenAI request.
 * onProgress({ total, checked, converted, alreadySaved, notJapanese, noLyrics, failed })
 */
export async function romanizeTracksNow(tracks, { onProgress = () => {}, isCancelled = () => false } = {}) {
  if (!openAIKey()) throw new Error("Add your OpenAI key in Voice search settings first.");
  const items = tracks.filter((t) => t && t.type !== "episode" && t.name);
  const stats = { total: items.length, checked: 0, converted: 0, alreadySaved: 0, notJapanese: 0, noLyrics: 0, failed: 0 };
  onProgress({ ...stats });

  let next = 0;
  const workerLoop = async () => {
    while (next < items.length && !isCancelled() && !stats.stopped) {
      const item = items[next++];
      try {
        const found = await findLyrics(item);
        const song = analyzeSong(item, found);
        if (!found) stats.noLyrics++;
        if (!song.japanese) {
          if (found) stats.notJapanese++;
        } else if (await readRomajiCache(songKey(item), song.texts)) {
          stats.alreadySaved++;
        } else if (!isCancelled()) {
          await japaneseSongToRomaji(songKey(item), song.texts, { allowDictionary: false });
          stats.converted++;
        }
      } catch (e) {
        console.warn("Couldn't romanize", item.name, e);
        stats.failed++;
        if (/OpenAI rejected|quota or rate limit/.test(e.message)) { stats.stopped = e.message; throw e; }
      }
      stats.checked++;
      onProgress({ ...stats });
    }
  };
  await Promise.all([workerLoop(), workerLoop()]); // two songs at a time (gentle on LRCLIB/OpenAI)
  return stats;
}

/**
 * Builds the "Romanize this playlist now" button and the saved-romaji storage line.
 * `getPlaybackState` returns Spotify's current playback state (for the playing playlist/album).
 */
export function mountRomajiTools(container, getPlaybackState) {
  container.innerHTML = `
    <div class="romaji-tools">
      <button class="secondary rp-btn">Romanize this playlist now</button>
      <p class="hint rp-status"></p>
      <p class="hint rp-storage"></p>
    </div>`;
  const btn = container.querySelector(".rp-btn");
  const status = container.querySelector(".rp-status");
  const storage = container.querySelector(".rp-storage");
  const showStorage = async () => {
    const { songs, kb, persistent } = await romajiCacheStats();
    storage.textContent = persistent
      ? `Saved romaji on this device: ${songs} song${songs === 1 ? "" : "s"} (${kb} KB)`
      : "This browser can't save romaji, so it's redone each visit.";
  };

  let running = false;
  let cancelled = false;
  btn.onclick = async () => {
    if (running) { cancelled = true; btn.textContent = "Stopping…"; return; }
    running = true;
    cancelled = false;
    btn.textContent = "Stop";
    try {
      status.textContent = "Loading the playlist's songs…";
      const { name, tracks } = await getContextTracks(getPlaybackState()?.context);
      const s = await romanizeTracksNow(tracks, {
        isCancelled: () => cancelled,
        onProgress: (p) => {
          status.textContent = `${name}: checked ${p.checked}/${p.total} · ${p.converted} romanized · ${p.alreadySaved} already saved`;
          showStorage();
        },
      });
      status.textContent = `${cancelled ? "Stopped." : "Done!"} ${name}: ${s.converted} Japanese song${s.converted === 1 ? "" : "s"} romanized, ` +
        `${s.alreadySaved} already saved, ${s.notJapanese} don't need it, ${s.noLyrics} have no lyrics` +
        (s.failed ? `, ${s.failed} failed` : "") + ".";
    } catch (e) {
      status.textContent = e.message;
    }
    running = false;
    btn.textContent = "Romanize this playlist now";
    showStorage();
  };
  showStorage();
}

// ---------- Tracking lyrics for the current song ----------
/**
 * Keeps lyrics (and romanized title/artist) in sync with the current track.
 * Call update(item) whenever playback changes; onChange fires when something new is ready.
 *
 * state.status: "idle" | "loading" | "ready" | "none" | "error"
 * state.lyrics: { language, synced, instrumental, lines: [{ time, text, roman }], romanizing }
 */
export class LyricsTracker {
  constructor(onChange) {
    this.onChange = onChange;
    this.key = null;
    this.state = { status: "idle" };
    this.titleRoman = null;
    this.artistRoman = null;
  }

  update(item) {
    const key = item ? songKey(item) : null;
    if (key === this.key) return;
    this.key = key;
    this.titleRoman = this.artistRoman = null;
    this.state = { status: key && item.type !== "episode" ? "loading" : "idle" };
    this.onChange();
    if (this.state.status === "loading") this.load(item, key);
  }

  async load(item, key) {
    const stillCurrent = () => this.key === key;
    let found;
    try {
      found = await findLyrics(item);
    } catch {
      if (stillCurrent()) { this.state = { status: "error" }; this.onChange(); }
      return;
    }
    if (!stillCurrent()) return;

    const song = analyzeSong(item, found);
    const { language, artistText, todo } = song;

    if (!found) {
      this.state = { status: "none" };
    } else {
      this.state = {
        status: "ready",
        lyrics: {
          language, synced: song.synced, instrumental: Boolean(found.instrumental),
          lines: song.lines, romanizing: todo.length > 0,
        },
      };
    }
    this.onChange();

    // Romanize title/artist and lyrics in the background.
    try {
      const lyrics = this.state.lyrics;

      if (song.japanese) {
        // Japanese: title, artist and every lyric line in one request (saved per song).
        const out = await japaneseSongToRomaji(key, song.texts);
        if (!stillCurrent()) return;
        this.titleRoman = out[0];
        this.artistRoman = out[1];
        todo.forEach((line, i) => { line.roman = out[i + 2]; });
      } else {
        const [title, artist] = await Promise.all([romanize(item.name, language), romanize(artistText, language)]);
        if (!stillCurrent()) return;
        this.titleRoman = title;
        this.artistRoman = artist;
        this.onChange();
        for (const line of todo) {
          line.roman = await romanize(line.text, language);
          if (!stillCurrent()) return;
        }
      }
      if (lyrics) lyrics.romanizing = false;
      this.onChange();
    } catch (e) {
      console.warn("Romanization failed:", e);
      if (stillCurrent() && this.state.lyrics) {
        this.state.lyrics.romanizing = false;
        this.state.lyrics.romanFailed = true;
        this.onChange();
      }
    }
  }

  /** Index of the line being sung at `ms` (-1 before the first line). */
  lineIndexAt(ms) {
    const lines = this.state.lyrics?.synced ? this.state.lyrics.lines : null;
    if (!lines) return -1;
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }
}
