// Shared Spotify login + playback helpers used by both /spotify-controller/ and /spotify-controller-glasses/.
// Uses Authorization Code + PKCE, so it runs entirely in the browser (works on GitHub Pages).
import { CLIENT_ID } from "./config.js";

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",   // add songs found by voice search
  "playlist-modify-private",
].join(" ");
const API = "https://api.spotify.com/v1";
export const REWIND_MS = 10000;

const store = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  del: (k) => localStorage.removeItem(k),
};

// The page's own address is used as the redirect URI, e.g.
//   https://<user>.github.io/spotify-controller/          (main page)
//   https://<user>.github.io/spotify-controller-glasses/  (glasses page)
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
  if (data.scope) store.set("granted_scope", data.scope);
}

// True if the saved login includes every permission this version of the app needs.
// (Logins from before playlists were added lack the playlist permissions → log in again.)
function hasAllScopes() {
  const granted = new Set((store.get("granted_scope") || "").split(" "));
  return SCOPES.split(" ").every((s) => granted.has(s));
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

export const isLoggedIn = () => Boolean(store.get("refresh_token")) && hasAllScopes();

async function getAccessToken() {
  if (Date.now() < Number(store.get("expires_at"))) return store.get("access_token");
  const refresh = store.get("refresh_token");
  if (!refresh) throw new Error("Not logged in");
  await requestToken({ grant_type: "refresh_token", refresh_token: refresh });
  return store.get("access_token");
}

export function logout() {
  ["access_token", "refresh_token", "expires_at", "granted_scope"].forEach(store.del);
}

// ---------- API ----------
// `messages` overrides the error text for specific status codes, e.g. { 403: "..." }.
async function spotify(method, path, body, messages = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) { logout(); throw new Error("Spotify session expired. Please log in again."); }
  if (res.status === 204) return null;
  if (!res.ok) {
    if (messages[res.status]) {
      const err = new Error(messages[res.status]);
      err.status = res.status;
      throw err;
    }
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
  /** Start playing a playlist (or album) from the beginning. */
  playContext: (uri) => spotify("PUT", "/me/player/play", { context_uri: uri }),
};

// ---------- Playlists ----------
let playlistCache = null;

/**
 * All playlists the user created or follows: [{ name, uri, image }].
 * Cached after the first load; pass { reload: true } to fetch again.
 */
export async function getPlaylists({ reload = false } = {}) {
  if (playlistCache && !reload) return playlistCache;
  const all = [];
  let path = "/me/playlists?limit=50";
  // Follow Spotify's paging, capped at 500 playlists.
  while (path && all.length < 500) {
    const page = await spotify("GET", path);
    for (const p of page?.items ?? []) {
      if (!p?.uri) continue; // Spotify sometimes returns null entries
      all.push({
        name: p.name || "Untitled playlist",
        uri: p.uri,
        id: p.id || p.uri.split(":").pop(),
        image: p.images?.at(-1)?.url || "",
        ownerId: p.owner?.id ?? null,
        collaborative: Boolean(p.collaborative),
      });
    }
    path = page?.next ? page.next.replace(API, "") : null;
  }
  playlistCache = all;
  return all;
}

// ---------- Search & adding songs ----------
let meCache = null;
/** The logged-in Spotify user ({ id, display_name, ... }). */
export async function getMe() {
  meCache ??= await spotify("GET", "/me");
  return meCache;
}

/** Search Spotify for tracks: [{ id, uri, name, artist, image }]. */
export async function searchTracks(query, limit = 5) {
  const data = await spotify("GET", `/search?${new URLSearchParams({ q: query, type: "track", limit })}`);
  return (data?.tracks?.items ?? []).filter(Boolean).map((t) => ({
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists?.map((a) => a.name).join(", ") ?? "",
    image: t.album?.images?.at(-1)?.url || "",
  }));
}

/** Playlists the user can add songs to (ones they own, or collaborative ones). */
export async function editablePlaylists() {
  const [me, all] = await Promise.all([getMe(), getPlaylists()]);
  return all.filter((p) => p.ownerId === me.id || p.collaborative);
}

/**
 * The playlist currently playing, if the user can add songs to it: { id, name } or null.
 * (You can't add to albums, or to playlists someone else owns.)
 */
export async function currentEditablePlaylist(playbackState) {
  const ctx = playbackState?.context;
  if (ctx?.type !== "playlist" || !ctx.uri) return null;
  const id = ctx.uri.split(":").pop();
  try {
    const [me, info] = await Promise.all([
      getMe(),
      spotify("GET", `/playlists/${id}?fields=${encodeURIComponent("id,name,owner(id),collaborative")}`),
    ]);
    const canEdit = info?.owner?.id === me.id || info?.collaborative;
    return canEdit ? { id, name: info.name || "your playlist" } : null;
  } catch {
    return null;
  }
}

/** Add a track to a playlist. */
export async function addTrackToPlaylist(playlistId, trackUri) {
  const messages = {
    403: "You can only add songs to playlists you own or collaborate on.",
    404: "notfound",
  };
  try {
    return await spotify("POST", `/playlists/${playlistId}/items`, { uris: [trackUri] }, messages);
  } catch (e) {
    // Older name of the same endpoint.
    if (e.status === 404) {
      return spotify("POST", `/playlists/${playlistId}/tracks`, { uris: [trackUri] }, {
        403: messages[403], 404: "That playlist wasn't found.",
      });
    }
    throw e;
  }
}

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
  /** The smallest cover image that is at least `minSize` px wide (saves bandwidth for the glasses). */
  artUrlAtLeast(minSize) {
    const item = this.state?.item;
    const images = item?.album?.images || item?.images || [];
    const bigEnough = images.filter((i) => (i.width ?? minSize) >= minSize);
    const pick = bigEnough.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] || images[0];
    return pick?.url || "";
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
