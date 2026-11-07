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
//   │  Play / Pause                │  tap presses the highlighted button,
//   │  Skip                        │  double-tap exits.
//   └──────────────────────────────┘
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
  getPlayback, runAction, PlaybackState, fmtTime,
} from "../spotify.js";

const MENU = [
  { label: "Previous", action: "previous", done: "Previous track" },
  { label: "Rewind 10s", action: "rewind", done: "Rewound 10s" },
  { label: "Play / Pause", action: "toggle" },
  { label: "Skip", action: "next", done: "Skipped" },
];

const POLL_MS = 3000;
const RENDER_MS = 1000;
const BRIDGE_TIMEOUT_MS = 4000;

const INFO = { id: 1, name: "info" };
const LIST = { id: 2, name: "menu" };

const $ = (id) => document.getElementById(id);
const playback = new PlaybackState();

let bridge = null;     // null when opened in a normal browser
let pageReady = false;
let flash = "";        // short status message shown on the 4th line
let flashTimer;

// ---------- Text for the glasses ----------
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).trimEnd() + "..." : s);

function progressBar(progress, duration, width = 16) {
  const filled = duration ? Math.round((progress / duration) * width) : 0;
  return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function infoText() {
  if (!isLoggedIn()) {
    return "Spotify Controller\nNot connected.\nOpen your phone to log in.\n" + flash;
  }
  if (!playback.state?.item) {
    return "Nothing playing\nStart Spotify on any device.\n\n" + flash;
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

function setFlash(text, ms = 2000) {
  flash = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = ""; render(); }, ms);
  render();
}

// ---------- Glasses page ----------
function pageLayout() {
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
        itemCount: MENU.length,
        itemWidth: 0, // auto-fill width
        isItemSelectBorderEn: 1, // draw a box around the highlighted button
        itemName: MENU.map((m) => m.label),
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

async function rebuildPage() {
  pageReady = await bridge.rebuildPageContainer(new RebuildPageContainer(pageLayout()));
  lastSent = infoText();
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

// Tap events: CLICK_EVENT is 0, which often arrives as "undefined", so a present
// envelope with no eventType counts as a click.
const eventTypeOf = (envelope) => (envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : null);

function handleGlassesEvent(event) {
  const listType = eventTypeOf(event.listEvent);
  const textType = eventTypeOf(event.textEvent);
  const sysType = eventTypeOf(event.sysEvent);

  // Double-tap anywhere always exits (shows the system "exit?" prompt).
  if ([listType, textType, sysType].includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    bridge.shutDownPageContainer(1);
    return;
  }

  // Tap on a list item → press that button.
  if (event.listEvent && listType === OsEventTypeList.CLICK_EVENT) {
    const { currentSelectItemName: name, currentSelectItemIndex: index } = event.listEvent;
    let i = MENU.findIndex((m) => m.label === name);
    if (i < 0) i = index ?? 0; // index 0 is sometimes omitted
    if (MENU[i]) press(MENU[i]);
    return;
  }

  // Back from the exit prompt ("No") → redraw our page.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT && pageReady) {
    rebuildPage();
    return;
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    stopTimers();
  }
}

// ---------- Actions ----------
let lastPress = { action: "", at: 0 };

async function press(item) {
  // The glasses can send the same event twice within ~100ms; ignore repeats.
  const now = Date.now();
  if (item.action === lastPress.action && now - lastPress.at < 400) return;
  lastPress = { action: item.action, at: now };

  if (!isLoggedIn()) return setFlash("Log in on your phone first", 3000);

  const pending = runAction(item.action, playback);
  setFlash(item.done ?? (playback.isPlaying ? "Playing" : "Paused"));
  try {
    await pending;
  } catch (e) {
    setFlash(e.message, 4000);
  }
  setTimeout(refresh, 500); // let Spotify catch up, then sync
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
  const ul = $("preview-menu");
  if (!ul.children.length) {
    MENU.forEach((m, i) => {
      const li = document.createElement("li");
      li.textContent = m.label;
      li.onclick = () => { previewIndex = i; renderPreview(); press(m); };
      ul.appendChild(li);
    });
  }
  [...ul.children].forEach((li, i) => li.classList.toggle("selected", i === previewIndex));
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

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowUp") previewIndex = Math.max(0, previewIndex - 1);
    else if (e.key === "ArrowDown") previewIndex = Math.min(MENU.length - 1, previewIndex + 1);
    else if (e.key === "Enter") press(MENU[previewIndex]);
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
