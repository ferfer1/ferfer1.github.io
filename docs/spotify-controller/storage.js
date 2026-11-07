// All of this app's small saved settings live in localStorage under a "spotify:" prefix,
// so other apps on the same site (ferfer1.github.io) can't clash with them.
// (The large saved romaji lives in IndexedDB instead; see lyrics.js.)

const PREFIX = "spotify:";

export const store = {
  get: (key) => localStorage.getItem(PREFIX + key),
  set: (key, value) => localStorage.setItem(PREFIX + key, value),
  del: (key) => localStorage.removeItem(PREFIX + key),
};

// One-time move of settings saved by older versions (which used unprefixed names),
// so nobody has to log in or re-enter keys after updating.
const OLD_KEYS = [
  "client_id", "access_token", "refresh_token", "expires_at", "granted_scope",
  "pkce_verifier", "oauth_state",
  "lyrics_on", "openai_key", "genius_token", "menu_trim",
];
for (const key of OLD_KEYS) {
  try {
    const old = localStorage.getItem(key);
    if (old === null) continue;
    if (store.get(key) === null) store.set(key, old);
    localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to move
  }
}
