// Shared Spotify login + playback helpers used by both the main page and /glasses/.
// Uses Authorization Code + PKCE, so it runs entirely in the browser (works on GitHub Pages).
import { CLIENT_ID } from "./config.js";

const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
const API = "https://api.spotify.com/v1";
export const REWIND_MS = 10000;

const store = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  del: (k) => localStorage.removeItem(k),
};

// The page's own address is used as the redirect URI, e.g.
//   https://<user>.github.io/<repo>/          (main page)
//   https://<user>.github.io/<repo>/glasses/  (glasses page)
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

// ---------- Client ID ----------
export const getClientId = () => CLIENT_ID || store.get("client_id") || "";
export const clientIdIsHardcoded = () => Boolean(CLIENT_ID);
export const setClientId = (id) => store.set("client_id", id.trim());
export const clearClientId = () => store.del("client_id");

// ---------- PKCE ----------
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- Auth ----------
export async function login() {
  const verifier = randomString(64);
  const state = randomString(16);
  store.set("pkce_verifier", verifier);
  store.set("oauth_state", state);

  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(verifier),
    state,
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function requestToken(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: getClientId(), ...body }),
  });
  if (!res.ok) throw new Error(`Spotify login failed (${res.status})`);
  const data = await res.json();
  store.set("access_token", data.access_token);
  store.set("expires_at", String(Date.now() + data.expires_in * 1000 - 60000));
  if (data.refresh_token) store.set("refresh_token", data.refresh_token);
}

/** If the URL contains a Spotify login response, finish logging in. Returns true if it did. */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return false;
  history.replaceState(null, "", redirectUri());

  if (params.get("error")) throw new Error(`Spotify login was cancelled or failed: ${params.get("error")}`);
  if (params.get("state") !== store.get("oauth_state")) throw new Error("Login state mismatch. Please try again.");

  await requestToken({
    grant_type: "authorization_code",
    code: params.get("code"),
    redirect_uri: redirectUri(),
    code_verifier: store.get("pkce_verifier"),
  });
  store.del("pkce_verifier");
  store.del("oauth_state");
  return true;
}

export const isLoggedIn = () => Boolean(store.get("refresh_token"));

async function getAccessToken() {
  if (Date.now() < Number(store.get("expires_at"))) return store.get("access_token");
  const refresh = store.get("refresh_token");
  if (!refresh) throw new Error("Not logged in");
  await requestToken({ grant_type: "refresh_token", refresh_token: refresh });
  return store.get("access_token");
}

export function logout() {
  ["access_token", "refresh_token", "expires_at"].forEach(store.del);
}

// ---------- API ----------
async function spotify(method, path) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 401) { logout(); throw new Error("Spotify session expired. Please log in again."); }
  if (res.status === 204) return null;
  if (!res.ok) {
    if (res.status === 403) throw new Error("Spotify Premium is required to control playback.");
    if (res.status === 404) throw new Error("No active device. Start Spotify somewhere first.");
    let msg = `Spotify error (${res.status})`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Current playback state, or null if nothing is playing anywhere. */
export const getPlayback = () => spotify("GET", "/me/player?additional_types=track,episode");

export const controls = {
  play: () => spotify("PUT", "/me/player/play"),
  pause: () => spotify("PUT", "/me/player/pause"),
  next: () => spotify("POST", "/me/player/next"),
  previous: () => spotify("POST", "/me/player/previous"),
  seek: (ms) => spotify("PUT", `/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`),
};

// ---------- Playback helpers ----------
/** Tracks the last known playback state and interpolates progress between polls. */
export class PlaybackState {
  constructor() { this.state = null; this.fetchedAt = 0; }

  set(state) { this.state = state; this.fetchedAt = Date.now(); }

  progress() {
    const s = this.state;
    if (!s) return 0;
    const p = s.progress_ms + (s.is_playing ? Date.now() - this.fetchedAt : 0);
    return Math.min(p, s.item?.duration_ms ?? p);
  }

  /** Optimistically update local state so the UI responds instantly. */
  patch(changes) {
    if (!this.state) return;
    this.state.progress_ms = this.progress();
    this.fetchedAt = Date.now();
    Object.assign(this.state, changes);
  }

  get title() { return this.state?.item?.name ?? ""; }
  get artist() {
    const item = this.state?.item;
    return item?.artists?.map((a) => a.name).join(", ") || item?.show?.name || "";
  }
  get duration() { return this.state?.item?.duration_ms ?? 0; }
  get isPlaying() { return Boolean(this.state?.is_playing); }
  get device() { return this.state?.device?.name ?? ""; }
  get artUrl() {
    const item = this.state?.item;
    return item?.album?.images?.[0]?.url || item?.images?.[0]?.url || "";
  }
}

/** Runs a control action against the current state: "previous" | "rewind" | "toggle" | "next". */
export async function runAction(action, playback) {
  switch (action) {
    case "previous":
      return controls.previous();
    case "next":
      return controls.next();
    case "rewind": {
      const pos = Math.max(0, playback.progress() - REWIND_MS);
      playback.patch({ progress_ms: pos });
      return controls.seek(pos);
    }
    case "toggle": {
      const wasPlaying = playback.isPlaying;
      playback.patch({ is_playing: !wasPlaying });
      return wasPlaying ? controls.pause() : controls.play();
    }
  }
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
