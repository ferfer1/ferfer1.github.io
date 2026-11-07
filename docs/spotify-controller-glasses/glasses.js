// Spotify controller for Even Realities G2 glasses (Even Hub).
//
// Glasses layout (576x288):
//   ┌───────┬──────────────────────┐
//   │ album │ Song title           │  image container "art" (120x120, 16 greens)
//   │  art  │ Artist               │  + text container "info"
//   │       │ 1:23 [====---] 3:45  │
//   │       │ Playing              │
//   ├───────┴──────────────────────┤
//   │ > current lyric line         │  text container "lyrics" (2 lines, romanized;
//   │   next lyric line            │  hidden when lyrics are turned off)
//   ├──────────────────────────────┤
//   │ [Previous]                   │  list container "menu":
//   │  Rewind 10s                  │  scroll moves the highlight (firmware),
//   │  Play / Pause                │  tap presses the highlighted item.
//   │  Skip / Playlists / Lyrics   │
//   └──────────────────────────────┘
//
// Screens:
//   controls  – the buttons above. Double-tap exits the app.
//   playlists – "< Back", up to 18 playlists, "More...". Tap plays; double-tap goes back.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  AudioInputSource,
} from "./vendor/even_hub_sdk.js";
import { ART_SIZE, getArt, drawGreenPreview } from "./art.js";
import {
  redirectUri, getClientId, setClientId, login, handleRedirect, isLoggedIn, logout,
  getPlayback, runAction, PlaybackState, fmtTime, getPlaylists, controls,
  editablePlaylists, currentEditablePlaylist, addTrackToPlaylist,
} from "../spotify-controller/spotify.js";
import { LyricsTracker, lyricsEnabled, setLyricsEnabled } from "../spotify-controller/lyrics.js";
import {
  MAX_LISTEN_MS, getOpenAIKey, mountVoiceSettings, startBrowserRecording,
  pcmToWav, transcribe, findSongs,
} from "../spotify-controller/voice.js";

const CONTROLS = [
  { label: "Previous", action: "previous", done: "Previous track" },
  { label: "Rewind 10s", action: "rewind", done: "Rewound 10s" },
  { label: "Play / Pause", action: "toggle" },
  { label: "Skip", action: "next", done: "Skipped" },
  { label: "Playlists", open: "playlists" },
  { label: () => `Lyrics: ${lyricsEnabled() ? "On" : "Off"}`, key: "lyrics", toggleLyrics: true },
  { label: "Find a song (mic)", key: "voice", voice: true },
];

// Voice-search screens; double-tap on any of them cancels back to the controls.
const VOICE_SCREENS = ["listening", "searching", "results", "pickPlaylist"];

const PLAYLISTS_PER_PAGE = 18; // + "< Back" + "More..." = 20, the glasses' list limit
const POLL_MS = 3000;
const RENDER_MS = 1000;
const BRIDGE_TIMEOUT_MS = 4000;
const LYRICS_TICK_MS = 250;  // how often to check whether the lyric line changed
const LYRIC_WIDTH = 40;      // characters per lyric line (full 576px width)

const INFO = { id: 1, name: "info" };
const LIST = { id: 2, name: "menu" };
const ART = { id: 3, name: "art" };
const LYRICS = { id: 4, name: "lyrics" };
const TEXT_X = ART_SIZE + 8; // info text sits to the right of the album art

const $ = (id) => document.getElementById(id);
const playback = new PlaybackState();
const lyrics = new LyricsTracker(() => render());

let bridge = null;      // set when running inside the Even app
let pageReady = false;  // true once the glasses page has been drawn
let screen = "controls";
let playlists = [];
let playlistOffset = 0;
let flash = "";         // short status message shown on the info area
let flashTimer;

// ---------- Text helpers ----------
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).trimEnd() + "..." : s);

function progressBar(progress, duration, width = 10) {
  const filled = duration ? Math.round((progress / duration) * width) : 0;
  return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function setFlash(text, ms = 2000) {
  flash = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = ""; render(); }, ms);
  render();
}

// ---------- What each screen shows ----------
/** The list items for the current screen: [{ label, run }]. */
function currentItems() {
  if (screen === "listening") {
    return [
      { label: "Done, search now", run: () => finishListening() },
      { label: "Cancel", run: () => cancelVoice() },
    ];
  }
  if (screen === "searching") return [{ label: "Cancel", run: () => cancelVoice() }];
  if (screen === "results") {
    return [
      { label: "< Cancel", run: () => cancelVoice() },
      ...voice.songs.map((s) => ({ label: clip(`${s.name} - ${s.artist}`, 44), run: () => chooseSong(s) })),
    ];
  }
  if (screen === "pickPlaylist") {
    return [
      { label: "< Cancel", run: () => cancelVoice() },
      ...voice.playlists.slice(0, 19).map((p) => ({ label: clip(p.name, 40), run: () => addSong(p) })),
    ];
  }
  if (screen === "playlists") {
    const page = playlists.slice(playlistOffset, playlistOffset + PLAYLISTS_PER_PAGE);
    const items = [{ label: "< Back", run: () => setScreen("controls") }];
    page.forEach((p) => items.push({ label: clip(p.name, 40), run: () => playPlaylist(p) }));
    if (playlists.length > PLAYLISTS_PER_PAGE) {
      const atEnd = playlistOffset + PLAYLISTS_PER_PAGE >= playlists.length;
      items.push({
        label: atEnd ? "Back to start" : "More...",
        run: () => {
          playlistOffset = atEnd ? 0 : playlistOffset + PLAYLISTS_PER_PAGE;
          setScreen("playlists");
        },
      });
    }
    return items;
  }
  return CONTROLS.map((c) => ({
    label: typeof c.label === "function" ? c.label() : c.label,
    key: c.key,
    run: () => pressControl(c),
  }));
}

// Song title/artist in Latin letters when available (the glasses' font may lack e.g. Japanese).
const shownTitle = () => lyrics.titleRoman || playback.title;
const shownArtist = () => lyrics.artistRoman || playback.artist;

/** Split text into lines of at most `width` characters, breaking at spaces. */
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) { // very long "words" (e.g. unspaced text)
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** The two lyric lines: "> current line" and "  next line" (a long current line uses both). */
function lyricsText() {
  if (!isLoggedIn() || !playback.state?.item) return " ";
  const { status, lyrics: data } = lyrics.state;
  if (status === "loading") return "Loading lyrics...";
  if (status === "none") return "No lyrics found for this song.";
  if (status === "error") return "Couldn't load lyrics.";
  if (status !== "ready") return " ";
  if (data.instrumental && !data.lines.length) return "(Instrumental)";
  if (!data.synced) return "Lyrics for this song aren't time-synced.";
  if (data.romanizing) return "Converting lyrics to Latin letters...";

  const show = (line) => (line ? (line.roman ?? line.text) : "");
  const i = lyrics.lineIndexAt(playback.progress());
  const current = (i >= 0 && show(data.lines[i])) || "...";
  const next = show(data.lines[i + 1]);

  const width = LYRIC_WIDTH - 2;
  const currentLines = wrap(current, width);
  if (currentLines.length >= 2) {
    return `> ${currentLines[0]}\n  ${clip(currentLines.slice(1).join(" "), width)}`;
  }
  return `> ${currentLines[0]}\n  ${clip(next, width)}`;
}

function infoText() {
  // The text area is ~448px wide (beside the album art), so lines are kept short.
  if (!isLoggedIn()) {
    return "Spotify Controller\nNot connected.\nOpen your phone\nto log in. " + flash;
  }

  if (screen === "listening") {
    const left = Math.max(0, Math.ceil((voice.listenUntil - Date.now()) / 1000));
    return `Listening... ${left}s\nSing or say the song\nTap "Done" when finished\n${clip(flash, 28)}`;
  }
  if (screen === "searching") {
    return `Searching...\n${clip(voice.heard ? `Heard: ${voice.heard}` : "Working out what you said", 28)}\n\n${clip(flash, 28)}`;
  }
  if (screen === "results") {
    return [
      clip(`Heard: ${voice.heard}`, 28),
      "Tap the right song",
      clip(`to add to ${voice.target ? voice.target.name : "a playlist"}`, 28),
      clip(flash, 28),
    ].join("\n");
  }
  if (screen === "pickPlaylist") {
    return [clip(`Add: ${voice.song?.name ?? ""}`, 28), "Pick a playlist", "Double-tap: cancel", clip(flash, 28)].join("\n");
  }

  if (screen === "playlists") {
    const from = playlistOffset + 1;
    const to = Math.min(playlistOffset + PLAYLISTS_PER_PAGE, playlists.length);
    return [
      `Playlists (${from}-${to} of ${playlists.length})`,
      "Scroll, tap to play",
      "Double-tap: back",
      clip(flash || (playback.title ? `Now: ${shownTitle()}` : ""), 28),
    ].join("\n");
  }

  if (!playback.state?.item) {
    return "Nothing playing\nStart Spotify, or\npick a Playlist below.\n" + clip(flash, 28);
  }
  const p = playback.progress();
  const d = playback.duration;
  const status = flash || (playback.isPlaying ? "Playing" : "Paused") +
    (playback.device ? ` on ${playback.device}` : "");
  return [
    clip(shownTitle(), 28),
    clip(shownArtist(), 30),
    `${fmtTime(p)} ${progressBar(p, d)} ${fmtTime(d)}`,
    clip(status, 28),
  ].join("\n");
}

// ---------- Glasses page ----------
function pageLayout() {
  const items = currentItems();
  const showLyrics = lyricsEnabled();
  const listY = showLyrics ? 186 : 124; // lyrics take 2 lines (62px) above the list

  const textObject = [new TextContainerProperty({
    xPosition: TEXT_X, yPosition: 0, width: 576 - TEXT_X, height: 120,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: INFO.id, containerName: INFO.name,
    content: infoText(),
    isEventCapture: 0,
  })];
  if (showLyrics) {
    textObject.push(new TextContainerProperty({
      xPosition: 0, yPosition: 122, width: 576, height: 62,
      borderWidth: 0, borderColor: 5, paddingLength: 4,
      containerID: LYRICS.id, containerName: LYRICS.name,
      content: lyricsText(),
      isEventCapture: 0,
    }));
  }

  return {
    containerTotalNum: 2 + textObject.length,
    imageObject: [new ImageContainerProperty({
      xPosition: 0, yPosition: 0, width: ART_SIZE, height: ART_SIZE,
      containerID: ART.id, containerName: ART.name,
    })],
    textObject,
    listObject: [new ListContainerProperty({
      xPosition: 0, yPosition: listY, width: 576, height: 288 - listY,
      borderWidth: 0, borderColor: 5, paddingLength: 4,
      containerID: LIST.id, containerName: LIST.name,
      isEventCapture: 1, // the list receives scroll + tap
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 0, // auto-fill width
        isItemSelectBorderEn: 1, // draw a box around the highlighted item
        itemName: items.map((i) => i.label),
      }),
    })],
  };
}

async function createPage() {
  let result;
  try {
    result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(pageLayout()));
  } catch (e) {
    result = e?.message ?? "unknown";
  }
  pageReady = result === 0;
  markTextsSent();
  if (pageReady) pushArt({ resend: true }); // image containers start empty
  $("bridge-status").textContent = pageReady
    ? "Connected to glasses ✓"
    : `Glasses not detected (code ${result}), so showing a preview only. ` +
      "To use your glasses, open this page from the Even app's developer QR code.";
}

// Redraw the whole page (needed whenever the list items change).
async function rebuildPage() {
  if (!bridge || !pageReady) return;
  markTextsSent();
  await bridge.rebuildPageContainer(new RebuildPageContainer(pageLayout()));
  pushArt({ resend: true }); // a full redraw clears the image
}

// ---------- Album art ----------
// Images go over Bluetooth slowly (~0.1-1s), so only send when the cover changes,
// one at a time, and always finish on the latest cover.
let artWanted = "";       // cover URL that should be showing ("" = blank)
let artDraw = 0;          // bumps on every page (re)draw, which clears the image
let artOnGlasses = null;  // "<draw>|<url>" last sent to the glasses
let artSending = false;

function currentArtUrl() {
  return isLoggedIn() && playback.state?.item ? playback.artUrlAtLeast(ART_SIZE) : "";
}

async function syncArt() {
  const url = currentArtUrl();
  if (url === artWanted) return;
  artWanted = url;
  const { gray } = await getArt(url);
  if (artWanted === url) drawGreenPreview($("preview-art"), gray);
  pushArt();
}

async function pushArt({ resend = false } = {}) {
  if (resend) artDraw++;
  if (!bridge || !pageReady || artSending) return;
  artSending = true;
  try {
    while (artOnGlasses !== `${artDraw}|${artWanted}`) {
      const key = `${artDraw}|${artWanted}`;
      const { png } = await getArt(artWanted);
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: ART.id, containerName: ART.name, imageData: png,
      }));
      if (result !== "success") console.warn("Album art not shown on glasses:", result);
      artOnGlasses = key; // don't retry in a loop; the next song change or redraw tries again
    }
  } catch (e) {
    console.warn("Album art error:", e);
  } finally {
    artSending = false;
  }
}

// Send text updates one at a time per box (Bluetooth is slow), only when something changed.
const texts = {
  info: { box: INFO, make: infoText, last: "", sending: false, shown: () => true },
  lyrics: { box: LYRICS, make: lyricsText, last: "", sending: false, shown: lyricsEnabled },
};

// After a (re)draw, the boxes already contain the current text.
function markTextsSent() {
  for (const t of Object.values(texts)) t.last = t.make();
}

async function pushText(t) {
  if (!bridge || !pageReady || t.sending || !t.shown()) return;
  const text = t.make();
  if (text === t.last) return;
  t.sending = true;
  try {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: t.box.id, containerName: t.box.name, content: text,
    }));
    t.last = text;
  } finally {
    t.sending = false;
  }
  if (t.make() !== t.last) pushText(t); // something changed while sending
}

function setScreen(next) {
  screen = next;
  previewIndex = 0;
  rebuildPage();
  render();
}

// ---------- Glasses input ----------
// CLICK_EVENT is 0, which often arrives as "undefined", so a present envelope
// with no eventType counts as a click.
const eventTypeOf = (envelope) => (envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : null);

// Figure out which list item was tapped. The index is sometimes missing for item 0,
// so fall back to matching the item's name.
function tappedIndex(items, { currentSelectItemName: name, currentSelectItemIndex: index }) {
  if (index != null && items[index] && (name == null || items[index].label === name)) return index;
  if (name != null) {
    const i = items.findIndex((it) => it.label === name);
    if (i >= 0) return i;
  }
  return index ?? 0;
}

// The glasses can deliver the same event twice within ~100ms; ignore quick repeats.
let lastInput = { key: "", at: 0 };
function isRepeat(key, ms = 500) {
  const now = Date.now();
  const repeat = key === lastInput.key && now - lastInput.at < ms;
  lastInput = { key, at: now };
  return repeat;
}

function goBackOrExit() {
  if (isRepeat("double-tap", 800)) return;
  if (screen === "controls") bridge?.shutDownPageContainer(1); // system "exit?" prompt
  else if (VOICE_SCREENS.includes(screen)) cancelVoice();
  else setScreen("controls");
}

function activate(index) {
  const items = currentItems();
  const item = items[index];
  if (!item || isRepeat(`${screen}:${item.key ?? item.label}`)) return;
  item.run();
}

function handleGlassesEvent(event) {
  // Microphone audio from the glasses (only while listening).
  if (event.audioEvent) {
    const pcm = event.audioEvent.audioPcm;
    if (voice.recordingGlasses && pcm?.length) voice.pcm.push(pcm instanceof Uint8Array ? pcm : Uint8Array.from(pcm));
    return;
  }

  const listType = eventTypeOf(event.listEvent);
  const textType = eventTypeOf(event.textEvent);
  const sysType = eventTypeOf(event.sysEvent);

  if ([listType, textType, sysType].includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    goBackOrExit();
    return;
  }

  if (event.listEvent && listType === OsEventTypeList.CLICK_EVENT) {
    activate(tappedIndex(currentItems(), event.listEvent));
    return;
  }

  // Back from the system exit prompt ("No") → redraw our page.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    rebuildPage();
    return;
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    stopTimers();
  }
}

// ---------- Actions ----------
async function pressControl(control) {
  if (control.toggleLyrics) return toggleLyrics();
  if (!isLoggedIn()) return setFlash("Log in on your phone first", 3000);
  if (control.voice) return startVoice();
  if (control.open === "playlists") return openPlaylists();

  const pending = runAction(control.action, playback);
  setFlash(control.done ?? (playback.isPlaying ? "Playing" : "Paused"));
  try {
    await pending;
  } catch (e) {
    setFlash(e.message, 4000);
  }
  setTimeout(refresh, 500); // let Spotify catch up, then sync
}

// ---------- Voice search: listen → find song → add to playlist ----------
const voice = {
  run: 0,                 // bumps on cancel so stale results are ignored
  recordingGlasses: false,
  pcm: [],                // raw audio chunks from the glasses mic
  browserRec: null,       // fallback recorder when previewing in a normal browser
  listenUntil: 0,
  timer: null,
  heard: "",
  songs: [],
  target: null,           // playlist currently playing, if you can add to it
  song: null,
  playlists: [],
};

async function startVoice() {
  if (!getOpenAIKey()) return setFlash("Add OpenAI key on phone", 4000);
  voice.run++;
  Object.assign(voice, { pcm: [], heard: "", songs: [], target: null, song: null, playlists: [] });

  try {
    if (bridge && pageReady) {
      voice.recordingGlasses = true;
      const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
      if (!ok) { voice.recordingGlasses = false; return setFlash("Couldn't turn on the mic", 4000); }
    } else {
      voice.browserRec = await startBrowserRecording(); // preview in a normal browser
    }
  } catch (e) {
    voice.recordingGlasses = false;
    return setFlash(e.message, 4000);
  }

  voice.listenUntil = Date.now() + MAX_LISTEN_MS;
  clearTimeout(voice.timer);
  voice.timer = setTimeout(finishListening, MAX_LISTEN_MS);
  setScreen("listening");
}

/** Stop the microphone and return the recording as { blob, filename } (or null). */
async function stopMic() {
  clearTimeout(voice.timer);
  if (voice.recordingGlasses) {
    voice.recordingGlasses = false;
    try { await bridge.audioControl(false); } catch {}
    const bytes = voice.pcm.reduce((n, c) => n + c.length, 0);
    return bytes > 16000 ? { blob: pcmToWav(voice.pcm), filename: "voice.wav" } : null; // < 0.5s = nothing heard
  }
  if (voice.browserRec) {
    const rec = voice.browserRec;
    voice.browserRec = null;
    return rec.stop();
  }
  return null;
}

async function finishListening() {
  if (screen !== "listening") return;
  const run = voice.run;
  setScreen("searching");
  try {
    const audio = await stopMic();
    if (!audio) return backWithFlash("Didn't hear anything");
    voice.heard = await transcribe(audio.blob, audio.filename);
    if (run !== voice.run) return;
    if (!voice.heard) return backWithFlash("Didn't catch that");
    render();

    const [songs, target] = await Promise.all([findSongs(voice.heard), currentEditablePlaylist(playback.state)]);
    if (run !== voice.run) return;
    if (!songs.length) return backWithFlash("No matching songs found");
    voice.songs = songs;
    voice.target = target;
    setScreen("results");
  } catch (e) {
    if (run === voice.run) backWithFlash(e.message);
  }
}

async function chooseSong(song) {
  voice.song = song;
  if (voice.target) return addSong(voice.target);
  // Not playing from a playlist you can edit: pick one of yours.
  const run = voice.run;
  setFlash("Loading playlists...", 8000);
  try {
    voice.playlists = await editablePlaylists();
  } catch (e) {
    return backWithFlash(e.message);
  }
  if (run !== voice.run) return;
  if (!voice.playlists.length) return backWithFlash("No playlists you can add to");
  flash = "";
  setScreen("pickPlaylist");
}

async function addSong(playlist) {
  const song = voice.song;
  setScreen("controls");
  setFlash("Adding...", 8000);
  try {
    await addTrackToPlaylist(playlist.id, song.uri);
    setFlash(`Added to ${playlist.name}`, 4000);
  } catch (e) {
    setFlash(e.message, 5000);
  }
}

function backWithFlash(text) {
  setScreen("controls");
  setFlash(text, 4000);
}

async function cancelVoice() {
  voice.run++;
  await stopMic();
  setScreen("controls");
  setFlash("Cancelled");
}

function toggleLyrics() {
  setLyricsEnabled(!lyricsEnabled());
  rebuildPage(); // the layout changes (lyrics box shown/hidden) and so does the item label
  setFlash(lyricsEnabled() ? "Lyrics on" : "Lyrics off");
}

async function openPlaylists() {
  setFlash("Loading playlists...", 10000);
  try {
    playlists = await getPlaylists();
  } catch (e) {
    return setFlash(e.message, 4000);
  }
  if (!playlists.length) return setFlash("No playlists found", 3000);
  flash = "";
  playlistOffset = 0;
  setScreen("playlists");
}

async function playPlaylist(p) {
  setScreen("controls");
  setFlash(`Starting ${clip(p.name, 26)}`, 4000);
  try {
    await controls.playContext(p.uri);
    setFlash(`Playing ${clip(p.name, 27)}`, 3000);
  } catch (e) {
    setFlash(e.message, 4000);
  }
  setTimeout(refresh, 600);
}

async function refresh() {
  if (!isLoggedIn()) return render();
  try {
    playback.set(await getPlayback());
  } catch (e) {
    setFlash(e.message, 4000);
    if (!isLoggedIn()) showSections();
  }
  render();
}

// ---------- Phone screen / browser preview ----------
let previewIndex = 0;

function renderPreview() {
  $("preview-info").textContent = infoText();
  renderPreviewLyrics();
  const items = currentItems();
  previewIndex = Math.min(previewIndex, items.length - 1);
  const ul = $("preview-menu");
  ul.replaceChildren(...items.map((item, i) => {
    const li = document.createElement("li");
    li.textContent = item.label;
    li.classList.toggle("selected", i === previewIndex);
    li.onclick = () => { previewIndex = i; activate(i); };
    return li;
  }));
}

function renderPreviewLyrics() {
  $("preview-lyrics").hidden = !lyricsEnabled();
  $("preview-lyrics").textContent = lyricsText();
}

function render() {
  lyrics.update(isLoggedIn() ? playback.state?.item : null); // starts loading lyrics on song change
  renderPreview();
  pushText(texts.info);
  pushText(texts.lyrics);
  syncArt();
}

// Lyrics change more often than once a second, so check them on their own faster timer.
function tickLyrics() {
  if (screen === "listening") { renderPreview(); pushText(texts.info); } // countdown
  if (!lyricsEnabled() || !playback.isPlaying) return;
  renderPreviewLyrics();
  pushText(texts.lyrics);
}

function showSections() {
  const needsId = !getClientId();
  $("setup").hidden = !needsId;
  $("login").hidden = needsId || isLoggedIn();
  $("preview").hidden = needsId || !isLoggedIn();
}

let timers = [];
function stopTimers() { timers.forEach(clearInterval); timers = []; }

// ---------- Boot ----------
async function connectBridge() {
  try {
    return await Promise.race([
      waitForEvenAppBridge(),
      new Promise((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

async function init() {
  $("redirect-uri").textContent = redirectUri();
  $("save-client").onclick = () => {
    const id = $("client-id").value.trim();
    if (id) { setClientId(id); location.reload(); }
  };
  $("login-btn").onclick = login;
  $("logout").onclick = () => { logout(); location.reload(); };
  mountVoiceSettings($("voice-settings"));

  // Keyboard stand-ins for the glasses: ↑/↓ scroll, Enter = tap, Esc = double-tap.
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const last = currentItems().length - 1;
    if (e.key === "ArrowUp") previewIndex = Math.max(0, previewIndex - 1);
    else if (e.key === "ArrowDown") previewIndex = Math.min(last, previewIndex + 1);
    else if (e.key === "Enter") activate(previewIndex);
    else if (e.key === "Escape") { if (screen !== "controls") setScreen("controls"); }
    else return;
    e.preventDefault();
    renderPreview();
  });

  if (getClientId()) {
    try { await handleRedirect(); } catch (e) { alert(e.message); }
  }
  showSections();
  render();

  bridge = await connectBridge();
  if (bridge) {
    await createPage(); // draw immediately so the glasses never show a blank screen
    if (pageReady) bridge.onEvenHubEvent(handleGlassesEvent);
  } else {
    $("bridge-status").textContent =
      "Not running inside the Even app. This is a preview; open it from the Even app to use it on your glasses.";
  }

  await refresh();
  timers.push(setInterval(refresh, POLL_MS));
  timers.push(setInterval(() => playback.isPlaying && render(), RENDER_MS));
  timers.push(setInterval(tickLyrics, LYRICS_TICK_MS));
}

init();
