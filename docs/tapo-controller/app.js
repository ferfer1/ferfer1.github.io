// Phone / PC page: every Tapo device with an on/off switch; lights also get brightness,
// white temperature and colour presets.
import {
  readLinkSettings, bridgeUrl, bridgeKey, isConfigured, saveSettings, settingsWarning,
  getDevices, setDevice, setAll, rescan, COLORS, WHITES, stateText,
} from "./tapo.js";

const POLL_MS = 4000;
const $ = (id) => document.getElementById(id);

let devices = [];
let busy = 0;          // while > 0 (a change is being sent / a slider dragged), skip polling
let pollTimer;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("warn", isError);
}

// ---------- Device list ----------
function render() {
  const list = $("devices");
  if (!devices.length) {
    list.innerHTML = '<li class="empty">No devices yet. Add them in the SmartThings app, then tap "Refresh" below.</li>';
    return;
  }
  // Re-use existing rows so sliders don't jump while you drag them.
  const rows = new Map([...list.querySelectorAll(".device")].map((li) => [li.dataset.id, li]));
  const ordered = devices.map((d) => {
    const li = rows.get(d.id) || makeRow(d);
    fillRow(li, d);
    return li;
  });
  list.replaceChildren(...ordered);
}

function makeRow(d) {
  const li = $("device-template").content.firstElementChild.cloneNode(true);
  li.dataset.id = d.id;

  li.querySelector(".switch").onclick = () => change(d.id, { on: !find(d.id).on });

  const bright = li.querySelector(".brightness input");
  bright.oninput = () => { li.querySelector(".device-state").textContent = `On ${bright.value}%`; };
  bright.onchange = () => change(d.id, { brightness: Number(bright.value) });

  const temp = li.querySelector(".temp input");
  temp.onchange = () => change(d.id, { colorTemp: Number(temp.value) });

  const swatches = li.querySelector(".swatches");
  for (const w of d.canTemp ? WHITES : []) swatches.append(swatch(w.name, kelvinCss(w.colorTemp), () => change(d.id, { colorTemp: w.colorTemp })));
  for (const c of d.canColor ? COLORS : []) swatches.append(swatch(c.name, `hsl(${c.hue} ${c.saturation}% 50%)`, () => change(d.id, { hue: c.hue, saturation: c.saturation })));
  return li;
}

function swatch(name, color, onclick) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.title = name;
  b.setAttribute("aria-label", name);
  b.style.background = color;
  b.onclick = onclick;
  return b;
}

function fillRow(li, d) {
  li.classList.toggle("on", d.on && d.online);
  li.classList.toggle("offline", !d.online);
  li.querySelector(".icon").textContent = d.kind === "light" ? "💡" : "🔌";
  li.querySelector(".device-name").textContent = d.name;
  li.querySelector(".device-state").textContent = d.model ? `${stateText(d)} · ${d.model}` : stateText(d);
  const sw = li.querySelector(".switch");
  sw.setAttribute("aria-checked", String(d.on));
  sw.setAttribute("aria-label", `${d.name} power`);
  sw.disabled = !d.online;

  const lightBox = li.querySelector(".light-controls");
  lightBox.hidden = d.kind !== "light" || !d.online;
  const bright = li.querySelector(".brightness");
  bright.hidden = !d.canDim;
  if (document.activeElement !== bright.firstElementChild && d.brightness != null) bright.querySelector("input").value = d.brightness;
  const temp = li.querySelector(".temp");
  temp.hidden = !d.canTemp;
  if (d.canTemp) {
    const input = temp.querySelector("input");
    [input.min, input.max] = d.tempRange;
    if (document.activeElement !== input && d.colorTemp) input.value = d.colorTemp;
  }
}

const find = (id) => devices.find((d) => d.id === id);

/** Rough on-screen colour for a white temperature. */
function kelvinCss(k) {
  const t = (k - 2500) / 4000; // 0 = warm, 1 = cool
  return `rgb(255 ${Math.round(190 + 60 * t)} ${Math.round(120 + 135 * t)})`;
}

// ---------- Actions ----------
async function change(id, what) {
  const before = find(id);
  if (!before) return;
  busy++;
  // Show the change immediately; the bridge's answer confirms it.
  Object.assign(before, what.on !== undefined ? { on: what.on } : { on: true }, what);
  render();
  try {
    Object.assign(before, await setDevice(id, what));
    setStatus(`${before.name}: ${stateText(before)}`);
  } catch (e) {
    setStatus(`${before.name}: ${e.message}`, true);
  } finally {
    busy--;
    render();
  }
}

async function all(on) {
  busy++;
  setStatus(on ? "Turning everything on..." : "Turning everything off...");
  try {
    const r = await setAll(on);
    devices = r.devices;
    setStatus(r.failed ? `${r.failed} device(s) didn't respond` : on ? "Everything on" : "Everything off", Boolean(r.failed));
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    busy--;
    render();
  }
}

async function scan() {
  busy++;
  setStatus("Refreshing...");
  try {
    const r = await rescan();
    devices = r.devices;
    setStatus(`Found ${r.found} device(s)` + (r.wrongPassword ? `; ${r.wrongPassword} rejected your Tapo login` : ""), Boolean(r.wrongPassword));
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    busy--;
    render();
  }
}

async function poll() {
  if (busy || !isConfigured()) return;
  try {
    const r = await getDevices();
    if (busy) return;
    devices = r.devices;
    $("devices-section").hidden = false;
    const on = devices.filter((d) => d.on && d.online).length;
    setStatus(r.scanning ? "Looking for devices..." : `${devices.length} device(s), ${on} on`);
    render();
  } catch (e) {
    setStatus(e.message, true);
    if (/key/i.test(e.message)) $("settings").open = true;
  }
}

// ---------- Settings ----------
function showSettings() {
  $("bridge-url").value = bridgeUrl();
  $("bridge-key").value = bridgeKey();
  $("settings-warning").textContent = settingsWarning();
  $("settings").open = !isConfigured();
  if (!isConfigured()) setStatus("Not connected yet. Open the link shown at the end of setup (or fill in the settings below).");
}

function init() {
  readLinkSettings();
  showSettings();
  $("save").onclick = () => {
    saveSettings($("bridge-url").value, $("bridge-key").value);
    showSettings();
    $("settings").open = false;
    poll();
  };
  $("all-on").onclick = () => all(true);
  $("all-off").onclick = () => all(false);
  $("rescan").onclick = scan;

  poll();
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
}

init();
