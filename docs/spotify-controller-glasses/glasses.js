// Spotify controller for Even Realities G2 glasses (Even Hub).
//
// Glasses layout (576x288):
//   ┌──────────────────────────────┐
//   │ Song title                   │  text container "info"
//   │ Artist                       │
//   │ 1:23 [=====-------] 3:45     │
//   │ Playing                      │
//   ├──────────────────────────────┤
//   │ [Previous]                   │  list container "menu":
//   │  Rewind 10s                  │  scroll moves the highlight (firmware),
//   │  Play / Pause                │  tap presses the highlighted item.
//   │  Skip                        │
//   │  Playlists                   │
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
  OsEventTypeList,
} from "./vendor/even_hub_sdk.js";
import {
  redirectUri, getClientId, setClientId, login, handleRedirect, isLoggedIn, logout,
  getPlayback, runAction, PlaybackState, fmtTime, getPlaylists, controls,
} from "../spotify-controller/spotify.js";

const CONTROLS = [
  { label: "Previous", action: "previous", done: "Previous track" },
  { label: "Rewind 10s", action: "rewind", done: "Rewound 10s" },
  { label: "Play / Pause", action: "toggle" },
  { label: "Skip", action: "next", done: "Skipped" },
  { label: "Playlists", open: "playlists" },
];

const PLAYLISTS_PER_PAGE = 18; // + "< Back" + "More..." = 20, the glasses' list limit
const POLL_MS = 3000;
const RENDER_MS = 1000;
const BRIDGE_TIMEOUT_MS = 4000;

const INFO = { id: 1, name: "info" };
const LIST = { id: 2, name: "menu" };

const $ = (id) => document.getElementById(id);
const playback = new PlaybackState();

let bridge = null;      // set when running inside the Even app
let pageReady = false;  // true once the glasses page has been drawn
let screen = "controls";
let playlists = [];
let playlistOffset = 0;
let flash = "";         // short status message shown on the info area
let flashTimer;

// ---------- Text helpers ----------
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).trimEnd() + "..." : s);

function progressBar(progress, duration, width = 16) {
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
  return CONTROLS.map((c) => ({ label: c.label, run: () => pressControl(c) }));
}

function infoText() {
  if (!isLoggedIn()) {
    return "Spotify Controller\nNot connected.\nOpen your phone to log in.\n" + flash;
  }

  if (screen === "playlists") {
    const from = playlistOffset + 1;
    const to = Math.min(playlistOffset + PLAYLISTS_PER_PAGE, playlists.length);
    return [
      `Playlists (${from}-${to} of ${playlists.length})`,
      "Scroll to pick, tap to play",
      "Double-tap to go back",
      flash || (playback.title ? `Now: ${clip(playback.title, 30)}` : ""),
    ].join("\n");
  }

  if (!playback.state?.item) {
    return "Nothing playing\nStart Spotify on any device,\nor pick a Playlist below.\n" + flash;
  }
  const p = playback.progress();
  const d = playback.duration;
  const status = flash || (playback.isPlaying ? "Playing" : "Paused") +
    (playback.device ? ` on ${clip(playback.device, 22)}` : "");
  return [
    clip(playback.title, 32),
    clip(playback.artist, 36),
    `${fmtTime(p)} ${progressBar(p, d)} ${fmtTime(d)}`,
    status,
  ].join("\n");
}

// ---------- Glasses page ----------
function pageLayout() {
  const items = currentItems();
  return {
    containerTotalNum: 2,
    textObject: [new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 120,
      borderWidth: 0, borderColor: 5, paddingLength: 4,
      containerID: INFO.id, containerName: INFO.name,
      content: infoText(),
      isEventCapture: 0,
    })],
    listObject: [new ListContainerProperty({
      xPosition: 0, yPosition: 124, width: 576, height: 164,
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
  lastSent = infoText();
  $("bridge-status").textContent = pageReady
    ? "Connected to glasses ✓"
    : `Glasses not detected (code ${result}), so showing a preview only. ` +
      "To use your glasses, open this page from the Even app's developer QR code.";
}

// Redraw the whole page (needed whenever the list items change).
async function rebuildPage() {
  if (!bridge || !pageReady) return;
  lastSent = infoText();
  await bridge.rebuildPageContainer(new RebuildPageContainer(pageLayout()));
}

// Send text updates one at a time (Bluetooth is slow) and only when something changed.
let lastSent = "";
let sending = false;
async function pushInfo() {
  if (!bridge || !pageReady || sending) return;
  const text = infoText();
  if (text === lastSent) return;
  sending = true;
  try {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: INFO.id, containerName: INFO.name, content: text,
    }));
    lastSent = text;
  } finally {
    sending = false;
  }
  if (infoText() !== lastSent) pushInfo(); // something changed while sending
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
  else setScreen("controls");
}

function activate(index) {
  const items = currentItems();
  const item = items[index];
  if (!item || isRepeat(`${screen}:${item.label}`)) return;
  item.run();
}

function handleGlassesEvent(event) {
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
  if (!isLoggedIn()) return setFlash("Log in on your phone first", 3000);
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

function render() {
  renderPreview();
  pushInfo();
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
}

init();
