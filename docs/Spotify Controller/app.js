// Main Spotify Controller page (phone / PC browser).
import {
  redirectUri, getClientId, setClientId, clearClientId, clientIdIsHardcoded,
  login, handleRedirect, isLoggedIn, logout,
  getPlayback, runAction, PlaybackState, fmtTime,
} from "./spotify.js";

const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);
const playback = new PlaybackState();

function render() {
  const hasTrack = Boolean(playback.state?.item);

  $("title").textContent = hasTrack ? playback.title : "Nothing playing";
  $("artist").textContent = hasTrack ? playback.artist : "Open Spotify on any device and play something.";
  $("device").textContent = playback.device ? `Playing on ${playback.device}` : "";

  if (playback.artUrl) $("art").src = playback.artUrl; else $("art").removeAttribute("src");

  const duration = playback.duration;
  const progress = playback.progress();
  $("elapsed").textContent = fmtTime(progress);
  $("duration").textContent = fmtTime(duration);
  $("bar-fill").style.width = duration ? `${(progress / duration) * 100}%` : "0";

  $("play-pause").innerHTML = playback.isPlaying ? "&#10074;&#10074;" : "&#9654;";
  ["prev", "rewind", "play-pause", "next"].forEach((id) => ($(id).disabled = !playback.state));
}

let msgTimer;
function showMessage(text) {
  $("message").textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => ($("message").textContent = ""), 4000);
}

async function refresh() {
  try {
    playback.set(await getPlayback());
    render();
  } catch (e) {
    showMessage(e.message);
    if (!isLoggedIn()) location.reload();
  }
}

async function act(action) {
  const pending = runAction(action, playback);
  render();
  try { await pending; } catch (e) { showMessage(e.message); }
  setTimeout(refresh, 400); // let Spotify catch up, then sync
}

function wireControls() {
  $("play-pause").onclick = () => act("toggle");
  $("next").onclick = () => act("next");
  $("prev").onclick = () => act("previous");
  $("rewind").onclick = () => act("rewind");
  $("logout").onclick = () => { logout(); location.reload(); };

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); act("toggle"); }
    if (e.code === "ArrowRight") act("next");
    if (e.code === "ArrowLeft") act("rewind");
  });
}

function show(section) {
  ["setup", "login", "player"].forEach((id) => ($(id).hidden = id !== section));
}

async function init() {
  $("redirect-uri").textContent = redirectUri();
  $("save-client").onclick = () => {
    const id = $("client-id").value.trim();
    if (id) { setClientId(id); location.reload(); }
  };
  $("login-btn").onclick = login;
  $("reset-client").hidden = clientIdIsHardcoded();
  $("reset-client").onclick = () => { clearClientId(); logout(); location.reload(); };

  if (!getClientId()) return show("setup");

  try { await handleRedirect(); }
  catch (e) { show("login"); alert(e.message); return; }

  if (!isLoggedIn()) return show("login");

  show("player");
  wireControls();
  render();
  await refresh();
  setInterval(refresh, POLL_MS);
  setInterval(() => playback.isPlaying && render(), 500);
}

init();
