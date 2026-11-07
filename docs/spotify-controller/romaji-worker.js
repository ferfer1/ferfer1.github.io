// Background worker that converts Japanese to romaji.
// Loading the ~12 MB dictionary and analysing text is heavy, so it runs here,
// off the page's main thread, to keep the controls and glasses display responsive.
importScripts("vendor/kuroshiro.min.js", "vendor/kuroshiro-analyzer-kuromoji.min.js");

let ready = null;

function init(dictPath) {
  ready ??= (async () => {
    const Kuroshiro = self.Kuroshiro.default || self.Kuroshiro;
    const Analyzer = self.KuromojiAnalyzer.default || self.KuromojiAnalyzer;
    const k = new Kuroshiro();
    await k.init(new Analyzer({ dictPath }));
    return k;
  })();
  ready.catch(() => { ready = null; }); // allow a retry
  return ready;
}

// Message in:  { id, texts: string[], dictPath }
// Message out: { id, out: string[] }  or  { id, error }
self.onmessage = async ({ data: { id, texts, dictPath } }) => {
  try {
    const k = await init(dictPath);
    const out = [];
    for (const text of texts) {
      out.push(await k.convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" }));
    }
    self.postMessage({ id, out });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
