// Talks to the Tapo service: the cloud service (tapo-cloud/, through SmartThings), or the
// optional PC bridge (tapo-bridge/). Both answer the same requests.
// Shared by the phone/PC page and the glasses page.

const PREFIX = "tapo:";
export const store = {
  get: (key) => { try { return localStorage.getItem(PREFIX + key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(PREFIX + key, value); } catch {} },
  del: (key) => { try { localStorage.removeItem(PREFIX + key); } catch {} },
};

/**
 * Links printed by the bridge carry the settings after a "#":  …/#bridge=https://…&key=…
 * Save them and tidy the address bar.
 */
export function readLinkSettings() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("bridge") && !params.has("key")) return;
  if (params.get("bridge")) store.set("bridge", params.get("bridge").replace(/\/+$/, ""));
  if (params.get("key")) store.set("key", params.get("key"));
  history.replaceState(null, "", location.pathname + location.search);
}

const onGitHub = () => /\.github\.io$/i.test(location.hostname);

/** The bridge address. When the page is served by the bridge itself, that's the default. */
export function bridgeUrl() {
  return store.get("bridge") || (onGitHub() || location.protocol === "file:" ? "" : location.origin);
}
export const bridgeKey = () => store.get("key") || "";
export const isConfigured = () => Boolean(bridgeUrl() && bridgeKey());

export function saveSettings(url, key) {
  url = url.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "http://" + url;
  if (url) store.set("bridge", url); else store.del("bridge");
  if (key.trim()) store.set("key", key.trim()); else store.del("key");
}

/** Problems we can spot before even trying (https pages can't call plain http on your network). */
export function settingsWarning() {
  const url = bridgeUrl();
  if (!url) return "";
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
  if (location.protocol === "https:" && url.startsWith("http://") && !local) {
    return "This page is https, so browsers won't let it reach an http:// bridge. " +
      "Use the bridge's https tunnel link, or open the 'At home' link the bridge prints.";
  }
  return "";
}

async function api(path, body) {
  const url = bridgeUrl();
  if (!url) throw new Error("Bridge not set up");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), path === "/api/scan" ? 60000 : 10000);
  let res;
  try {
    res = await fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Bridge-Key": bridgeKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch {
    throw new Error(settingsWarning() || "Can't reach the Tapo service. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Service error ${res.status}`);
  return data;
}

export const ping = () => api("/api/ping");
export const getDevices = () => api("/api/devices");
export const setDevice = (id, change) => api("/api/set", { id, ...change }).then((d) => d.device);
export const setAll = (on) => api("/api/all", { on });
export const rescan = () => api("/api/scan", {});

// ---------- Presets shared by both pages ----------
export const COLORS = [
  { name: "Red", hue: 0, saturation: 100 },
  { name: "Orange", hue: 30, saturation: 100 },
  { name: "Yellow", hue: 55, saturation: 100 },
  { name: "Green", hue: 120, saturation: 100 },
  { name: "Cyan", hue: 180, saturation: 100 },
  { name: "Blue", hue: 230, saturation: 100 },
  { name: "Purple", hue: 275, saturation: 100 },
  { name: "Pink", hue: 320, saturation: 80 },
];
export const WHITES = [
  { name: "Warm white", colorTemp: 2700 },
  { name: "Neutral white", colorTemp: 4000 },
  { name: "Daylight", colorTemp: 6500 },
];

/** Short state for a device: "On 80%", "Off", "Offline". */
export function stateText(d) {
  if (!d.online) return "Offline";
  if (!d.on) return "Off";
  return d.kind === "light" && d.canDim && d.brightness != null ? `On ${d.brightness}%` : "On";
}
