// Tapo controller for Even Realities G2 glasses (Even Hub).
//
// Glasses layout (576x288):
//   ┌──────────────────────────────┐
//   │ Tapo · 2 of 5 on             │  "header" text (status / short messages)
//   ├──────────────────────────────┤
//   │ > Desk lamp          On 80%  │  "list" text box, drawn by this app (6 rows,
//   │   Kettle                Off  │  scrolls with the highlight). It receives the
//   │   Living room           On   │  swipes and taps.
//   │   ...                        │
//   ├──────────────────────────────┤
//   │ Tap: on/off  Hold: more  3/7 │  "footer" text (hints)
//   └──────────────────────────────┘
//
// Screens:
//   devices – every plug/light, then "All off" / "All on". Tap toggles. Double-tap exits.
//   light   – one light: power, brighter/dimmer, whites, colours. Double-tap goes back.
// Tap-and-hold menu: Light settings, All off, All on, Refresh.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
  MenuContainerProperty,
  MenuItemProperty,
} from "./vendor/even_hub_sdk.js";
import { getTextWidth, pxTruncate } from "./vendor/g2_font_measure.js";
import {
  store, readLinkSettings, bridgeUrl, bridgeKey, isConfigured, saveSettings, settingsWarning,
  getDevices, setDevice, setAll, rescan, COLORS, WHITES, stateText,
} from "../tapo-controller/tapo.js";

const POLL_MS = 4000;
const BRIDGE_TIMEOUT_MS = 4000;
const BRIGHTNESS_STEP = 20;

// ---------- Layout ----------
const LINE_PX = 27;
const ROWS = 6;
const BORDER = 1;
const PADDING = 4;
const HEADER = { id: 1, name: "header" };
const LIST = { id: 2, name: "list" };
const FOOTER = { id: 3, name: "footer" };
const HEADER_H = 40;
const LIST_Y = HEADER_H + 4;
const LIST_H = ROWS * LINE_PX + 2 * (BORDER + PADDING) + 4;
const FOOTER_Y = LIST_Y + LIST_H + 4;
const ROW_PX = 576 - 2 * (BORDER + PADDING) - 6; // usable text width in the list (a little spare so it never wraps)

const HOLD_MENU = [
  { id: 1, label: "Light settings", run: () => openLightFromList() },
  { id: 2, label: "All off", run: () => all(false) },
  { id: 3, label: "All on", run: () => all(true) },
  { id: 4, label: "Refresh", run: () => doRescan() },
];

// ---------- Settings (changed on the phone screen) ----------
const swipeReversed = () => store.get("swipe_reversed") === "1";
const tapOpensLight = () => store.get("tap_light") === "open";

const $ = (id) => document.getElementById(id);

let bridge = null;
let pageReady = false;
let devices = [];
let screen = "devices";
let lightId = null;     // the light shown on the "light" screen
let selected = 0;
let top = 0;            // first visible row
let busy = 0;
let connected = false;
let error = "";
let flash = "";
let flashTimer;

function setFlash(text, ms = 2500) {
  flash = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = ""; render(); }, ms);
  render();
}

const find = (id) => devices.find((d) => d.id === id);

// ---------- What each screen shows ----------
/** Menu items for the current screen: [{ label, right?, run, key }]. */
function currentItems() {
  if (!isConfigured() || (!connected && !devices.length)) {
    return [{ label: "Try again", key: "retry", run: () => { setFlash("Connecting..."); poll(); } }];
  }

  if (screen === "light") {
    const d = find(lightId);
    if (!d) { screen = "devices"; return currentItems(); }
    const items = [
      { label: "< Back", key: "back", run: () => setScreen("devices") },
      { label: d.on ? "Turn off" : "Turn on", key: "power", run: () => change(d, { on: !d.on }) },
    ];
    if (d.canDim) {
      items.push(
        { label: "Brighter", right: `+${BRIGHTNESS_STEP}%`, key: "up", run: () => change(d, { brightness: Math.min(100, (d.on ? d.brightness ?? 50 : 0) + BRIGHTNESS_STEP) }) },
        { label: "Dimmer", right: `-${BRIGHTNESS_STEP}%`, key: "down", run: () => change(d, { brightness: Math.max(1, (d.brightness ?? 50) - BRIGHTNESS_STEP) }) },
        { label: "Full brightness", key: "full", run: () => change(d, { brightness: 100 }) },
        { label: "Night light", right: "5%", key: "night", run: () => change(d, { brightness: 5 }) },
      );
    }
    if (d.canTemp) for (const w of WHITES) items.push({ label: w.name, key: w.name, run: () => change(d, { colorTemp: w.colorTemp }) });
    if (d.canColor) for (const c of COLORS) items.push({ label: c.name, key: c.name, run: () => change(d, { hue: c.hue, saturation: c.saturation }) });
    return items;
  }

  const items = devices.map((d) => ({
    label: d.name,
    right: stateText(d),
    key: d.id,
    device: d,
    run: () => {
      if (!d.online) return setFlash(`${d.name} isn't answering`);
      if (d.kind === "light" && tapOpensLight()) return openLight(d);
      change(d, { on: !d.on });
    },
  }));
  if (devices.length) {
    items.push({ label: "All off", key: "all-off", run: () => all(false) });
    items.push({ label: "All on", key: "all-on", run: () => all(true) });
  } else {
    items.push({ label: "Refresh", key: "rescan", run: () => doRescan() });
  }
  return items;
}

function headerText() {
  if (flash) return clipPx(flash, 560);
  if (!isConfigured()) return "Tapo · not set up";
  if (error && !devices.length) return clipPx(`Tapo · ${error}`, 560);
  if (screen === "light") {
    const d = find(lightId);
    return d ? clipPx(`${d.name} · ${stateText(d)}`, 560) : "Tapo";
  }
  const on = devices.filter((d) => d.on && d.online).length;
  return `Tapo · ${on} of ${devices.length} on` + (error ? " · offline?" : "");
}

function footerText() {
  const items = currentItems();
  const pos = items.length > ROWS ? `   ${selected + 1}/${items.length}` : "";
  if (!isConfigured()) return "Not connected yet. Scan the setup\nQR code again (see Connection settings).";
  if (!connected && !devices.length) return "Can't reach the Tapo service.\nTap: try again   Double-tap: exit";
  if (screen === "light") return `Tap: apply   Double-tap: back${pos}\nHold: all off / refresh`;
  const item = items[selected];
  const tap = item?.device?.kind === "light" && tapOpensLight() ? "settings" : "on/off";
  const hold = item?.device?.kind === "light" ? "light settings" : "more";
  return `Swipe: move   Tap: ${tap}${pos}\nHold: ${hold}   Double-tap: exit`;
}

/** The list box: ROWS lines, "> " on the highlighted one, state right-aligned. */
function listText() {
  const items = currentItems();
  selected = Math.max(0, Math.min(selected, items.length - 1));
  if (selected < top) top = selected;
  if (selected >= top + ROWS) top = selected - ROWS + 1;
  top = Math.max(0, Math.min(top, Math.max(0, items.length - ROWS)));

  const markPx = getTextWidth("> ");
  const blank = spaces(markPx); // same width as "> " so names line up
  const lines = items.slice(top, top + ROWS).map((item, i) => {
    const mark = top + i === selected ? "> " : blank;
    const right = item.right || "";
    const rightPx = right ? getTextWidth(right) : 0;
    const name = pxTruncate(item.label, ROW_PX - markPx - rightPx - (right ? 20 : 0));
    if (!right) return mark + name;
    const gap = ROW_PX - getTextWidth(mark + name) - rightPx;
    return mark + name + spaces(gap) + right;
  });
  return lines.join("\n") || " ";
}

const clipPx = (s, px) => pxTruncate(s, px);
function spaces(px) {
  return " ".repeat(Math.max(1, Math.floor(px / getTextWidth(" "))));
}

// ---------- Glasses page ----------
function holdMenu() {
  return new MenuContainerProperty({
    menuItems: HOLD_MENU.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
  });
}

function pageLayout() {
  const text = (box, y, h, content, extra = {}) => new TextContainerProperty({
    xPosition: 0, yPosition: y, width: 576, height: h,
    borderWidth: 0, borderColor: 5, paddingLength: PADDING,
    containerID: box.id, containerName: box.name, content, isEventCapture: 0, ...extra,
  });
  return {
    containerTotalNum: 3,
    textObject: [
      text(HEADER, 0, HEADER_H, headerText()),
      text(LIST, LIST_Y, LIST_H, listText(), { borderWidth: BORDER, borderColor: 8, borderRadius: 6, isEventCapture: 1 }),
      text(FOOTER, FOOTER_Y, 288 - FOOTER_Y, footerText()),
    ],
    menuObject: holdMenu(),
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
  $("bridge-status").textContent = pageReady
    ? "Connected to glasses ✓"
    : `Glasses not detected (code ${result}), so showing a preview only. ` +
      "To use your glasses, open this page from the Even app's developer QR code.";
}

async function rebuildPage() {
  if (!bridge || !pageReady) return;
  markTextsSent();
  await bridge.rebuildPageContainer(new RebuildPageContainer(pageLayout()));
}

// Send text updates one at a time per box (Bluetooth is slow), only when something changed.
const texts = {
  header: { box: HEADER, make: headerText, last: "", sending: false },
  list: { box: LIST, make: listText, last: "", sending: false },
  footer: { box: FOOTER, make: footerText, last: "", sending: false },
};
function markTextsSent() { for (const t of Object.values(texts)) t.last = t.make(); }

async function pushText(t) {
  if (!bridge || !pageReady || t.sending) return;
  const text = t.make();
  if (text === t.last) return;
  t.sending = true;
  try {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: t.box.id, containerName: t.box.name, content: text }));
    t.last = text;
  } catch (e) {
    console.warn("Text update failed:", e);
  } finally {
    t.sending = false;
  }
  if (t.make() !== t.last) pushText(t); // something changed while sending
}

function render() {
  renderPreview();
  pushText(texts.list);
  pushText(texts.header);
  pushText(texts.footer);
}

// ---------- Navigation ----------
function setScreen(next) {
  if (screen === "light" && next === "devices") {
    // Back on the list with the same light highlighted.
    selected = Math.max(0, devices.findIndex((d) => d.id === lightId));
  } else {
    selected = next === "light" ? 1 : 0; // light screen starts on "Turn on/off"
    top = 0;
  }
  screen = next;
  render();
}

function openLight(d) {
  lightId = d.id;
  setScreen("light");
}

function openLightFromList() {
  if (screen === "light") return;
  const d = currentItems()[selected]?.device;
  if (d?.kind === "light" && d.online) return openLight(d);
  const firstLight = devices.find((x) => x.kind === "light" && x.online);
  if (firstLight) return openLight(firstLight);
  setFlash("No lights found");
}

function moveSelection(step) {
  const n = currentItems().length;
  if (!n) return;
  selected = (((selected + step) % n) + n) % n;
  render();
}

// ---------- Glasses input ----------
// CLICK_EVENT is 0, which often arrives as "undefined", so a present envelope
// with no eventType counts as a click.
const eventTypeOf = (envelope) => (envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : null);

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
  if (screen === "light") setScreen("devices");
  else bridge?.shutDownPageContainer(1); // system "exit?" prompt
}

function activate(index) {
  const item = currentItems()[index];
  if (!item || isRepeat(`${screen}:${item.key}`)) return;
  item.run();
}

function handleGlassesEvent(event) {
  if (event.menuItemClickEvent) {
    const id = Number(event.menuItemClickEvent.itemID);
    const m = HOLD_MENU.find((x) => x.id === id);
    if (m && !isRepeat(`menu:${id}`)) m.run();
    return;
  }

  const textType = eventTypeOf(event.textEvent);
  const sysType = eventTypeOf(event.sysEvent);

  if ([textType, sysType].includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    goBackOrExit();
    return;
  }

  // Swipes on the list box arrive as "scroll" events: swipe up = SCROLL_TOP, down = SCROLL_BOTTOM.
  const scroll = textType === OsEventTypeList.SCROLL_TOP_EVENT ? -1
    : textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ? 1 : 0;
  if (scroll) {
    if (isRepeat(`swipe${scroll}`, 150)) return;
    moveSelection(swipeReversed() ? -scroll : scroll);
    return;
  }

  // A tap: on hardware it comes from the text box; the simulator sends it as a system event.
  if (textType === OsEventTypeList.CLICK_EVENT || sysType === OsEventTypeList.CLICK_EVENT) {
    activate(selected);
    return;
  }

  // Back from the system exit prompt ("No") → redraw our page.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    rebuildPage();
    poll();
    return;
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    clearInterval(pollTimer);
  }
}

// ---------- Actions ----------
async function change(d, what) {
  busy++;
  const before = { ...d };
  // Show it straight away; undo if the bridge says no.
  Object.assign(d, { on: what.on ?? true }, what);
  setFlash(`${d.name}: ${stateText(d)}`);
  try {
    Object.assign(d, await setDevice(d.id, what));
    setFlash(`${d.name}: ${stateText(d)}`);
  } catch (e) {
    Object.assign(d, before);
    setFlash(e.message, 4000);
  } finally {
    busy--;
  }
}

async function all(on) {
  busy++;
  setFlash(on ? "Turning everything on..." : "Turning everything off...", 10000);
  try {
    const r = await setAll(on);
    devices = r.devices;
    setFlash(r.failed ? `${r.failed} device(s) didn't respond` : on ? "Everything on" : "Everything off");
  } catch (e) {
    setFlash(e.message, 4000);
  } finally {
    busy--;
  }
}

async function doRescan() {
  busy++;
  setFlash("Refreshing...", 60000);
  try {
    const r = await rescan();
    devices = r.devices;
    connected = true;
    setFlash(`Found ${r.found} device(s)` + (r.wrongPassword ? " (some rejected the login)" : ""), 4000);
  } catch (e) {
    setFlash(e.message, 4000);
  } finally {
    busy--;
  }
}

async function poll() {
  if (busy || !isConfigured()) return render();
  try {
    const r = await getDevices();
    if (busy) return;
    devices = r.devices;
    connected = true;
    error = "";
    $("status").textContent = `Connected · ${devices.length} device(s)`;
  } catch (e) {
    connected = false;
    error = /key/i.test(e.message) ? "wrong key" : "offline";
    $("status").textContent = e.message;
  }
  render();
}

// ---------- Phone screen / browser preview ----------
function renderPreview() {
  $("preview-header").textContent = headerText();
  $("preview-list").textContent = listText();
  $("preview-footer").textContent = footerText();
}

function showPhoneSettings() {
  $("tap-toggle").classList.toggle("on", !tapOpensLight());
  $("tap-open").classList.toggle("on", tapOpensLight());
  $("swipe-direction").textContent = swipeReversed() ? "Reversed" : "Normal";
  $("bridge-url").value = bridgeUrl();
  $("bridge-key").value = bridgeKey();
  $("settings-warning").textContent = settingsWarning();
  $("settings").open = !isConfigured();
}

let pollTimer;

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
  readLinkSettings();
  showPhoneSettings();

  $("save").onclick = () => {
    saveSettings($("bridge-url").value, $("bridge-key").value);
    showPhoneSettings();
    $("settings").open = false;
    poll();
  };
  $("tap-toggle").onclick = () => { store.set("tap_light", "toggle"); showPhoneSettings(); render(); };
  $("tap-open").onclick = () => { store.set("tap_light", "open"); showPhoneSettings(); render(); };
  $("swipe-direction").onclick = () => { store.set("swipe_reversed", swipeReversed() ? "0" : "1"); showPhoneSettings(); };

  // Preview buttons and keyboard stand-ins: arrows = swipe, Enter = tap, Esc = double-tap.
  const press = (key) => {
    if (key === "up") moveSelection(-1);
    else if (key === "down") moveSelection(1);
    else if (key === "tap") activate(selected);
    else if (key === "back" && screen === "light") setScreen("devices");
  };
  document.querySelectorAll(".preview-buttons button").forEach((b) => { b.onclick = () => press(b.dataset.key); });
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const key = { ArrowUp: "up", ArrowLeft: "up", ArrowDown: "down", ArrowRight: "down", Enter: "tap", Escape: "back" }[e.key];
    if (!key) return;
    e.preventDefault();
    press(key);
  });

  render();
  bridge = await connectBridge();
  if (bridge) {
    await createPage(); // draw immediately so the glasses never show a blank screen
    if (pageReady) bridge.onEvenHubEvent(handleGlassesEvent);
  } else {
    $("bridge-status").textContent =
      "Not running inside the Even app. This is a preview; open it from the Even app to use it on your glasses.";
  }

  await poll();
  pollTimer = setInterval(poll, POLL_MS);
}

init();
