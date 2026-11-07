// Lyrics for the current song, from LRCLIB (https://lrclib.net, free, no key needed),
// with automatic romanization of non-Latin lyrics:
//   Japanese → romaji (kuroshiro + kuromoji dictionary, loaded only when needed)
//   Chinese  → pinyin (pinyin-pro)
//   Korean   → Revised Romanization (built-in rules)
//   Russian / Ukrainian (Cyrillic) → Latin letters (built-in table)
// Spotify's own lyrics aren't available through its public API.

const LRCLIB = "https://lrclib.net/api";
const KUROMOJI_DICT = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
const vendor = (file) => new URL(`./vendor/${file}`, import.meta.url).href;

// ---------- On/off setting (on by default) ----------
export const lyricsEnabled = () => localStorage.getItem("lyrics_on") !== "0";
export const setLyricsEnabled = (on) => localStorage.setItem("lyrics_on", on ? "1" : "0");

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
const ROMAJI_TIMEOUT_MS = 90000; // first use downloads the dictionary; give up after this
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
  return (await japaneseBatchToRomaji([text]))[0];
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
    const key = item ? item.id || item.uri || item.name : null;
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

    const allText = [item.name, found?.syncedLyrics || found?.plainLyrics || ""].join("\n");
    const language = detectLanguage(allText);

    if (!found) {
      this.state = { status: "none" };
    } else {
      const synced = Boolean(found.syncedLyrics);
      const lines = synced
        ? parseLrc(found.syncedLyrics)
        : (found.plainLyrics || "").split(/\r?\n/).map((text) => ({ time: null, text: text.trim() }));
      const needsRoman = lines.some((l) => NON_LATIN.test(l.text));
      this.state = {
        status: "ready",
        lyrics: { language, synced, instrumental: Boolean(found.instrumental), lines, romanizing: needsRoman },
      };
    }
    this.onChange();

    // Romanize title/artist and lyrics in the background.
    try {
      const [title, artist] = await Promise.all([
        romanize(item.name, language),
        romanize(item.artists?.map((a) => a.name).join(", ") ?? "", language),
      ]);
      if (!stillCurrent()) return;
      this.titleRoman = title;
      this.artistRoman = artist;
      this.onChange();

      const lyrics = this.state.lyrics;
      if (lyrics?.romanizing) {
        const todo = lyrics.lines.filter((l) => NON_LATIN.test(l.text));
        if (language === "ja" || todo.some((l) => KANA.test(l.text))) {
          // One background batch for the whole song.
          const romaji = await japaneseBatchToRomaji(todo.map((l) => l.text));
          if (!stillCurrent()) return;
          todo.forEach((line, i) => { line.roman = romaji[i]; });
        } else {
          for (const line of todo) {
            line.roman = await romanize(line.text, language);
            if (!stillCurrent()) return;
          }
        }
        lyrics.romanizing = false;
        this.onChange();
      }
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
