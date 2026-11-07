// Main Spotify Controller page (phone / PC browser).
import {
  redirectUri, getClientId, setClientId, clearClientId, clientIdIsHardcoded,
  login, handleRedirect, isLoggedIn, logout,
  getPlayback, runAction, PlaybackState, fmtTime,
  getPlaylists, controls,
  editablePlaylists, currentEditablePlaylist, addTrackToPlaylist,
} from "./spotify.js";
import { LyricsTracker, lyricsEnabled, setLyricsEnabled, mountRomajiTools, renderLyricsHelp } from "./lyrics.js";
import {
  MAX_LISTEN_MS, getOpenAIKey, mountVoiceSettings, startBrowserRecording,
  browserSpeechAvailable, startBrowserSpeech, transcribe, findSongs,
} from "./voice.js";

const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);
const playback = new PlaybackState();
const lyrics = new LyricsTracker(() => renderLyrics(true));

// ---------- Lyrics ----------
let lyricsShownKey = "";

function lyricElement(line, isCurrent) {
  const div = document.createElement("div");
  div.className = "lyric" + (isCurrent ? " current" : "");
  div.append(line.text || "…");
  if (line.roman) {
    const roman = document.createElement("span");
    roman.className = "roman";
    roman.textContent = line.roman;
    div.append(roman);
  }
  return div;
}

function lyricsNote(text) {
  const div = document.createElement("div");
  div.className = "lyrics-note";
  div.textContent = text;
  return div;
}

/** Redraw the lyrics panel (only when the visible content actually changes). */
function renderLyrics(force = false) {
  const on = lyricsEnabled();
  $("lyrics-toggle").textContent = on ? "On" : "Off";
  $("lyrics-toggle").setAttribute("aria-checked", String(on));
  const box = $("lyrics");
  box.hidden = !on;
  $("lyrics-help").hidden = !on;
  if (!on) return;
  renderLyricsHelp($("lyrics-help"), lyrics, playback.state?.item);

  const { status, lyrics: data } = lyrics.state;
  const index = lyrics.lineIndexAt(playback.progress());
  const key = `${lyrics.key}|${status}|${index}|${data?.romanizing}`;
  if (!force && key === lyricsShownKey) return;
  lyricsShownKey = key;

  const notes = {
    idle: playback.state?.item ? "No lyrics for this item." : "Nothing playing.",
    loading: "Loading lyrics…",
    none: "No lyrics found for this song.",
    error: "Couldn't load lyrics.",
  };
  if (status !== "ready") return box.replaceChildren(lyricsNote(notes[status]));
  if (data.instrumental && !data.lines.length) return box.replaceChildren(lyricsNote("Instrumental"));

  const children = [];
  if (data.romanizing) children.push(lyricsNote("Adding romanization…"));

  if (!data.synced) {
    // Unsynced lyrics: show them all and let the user scroll.
    children.push(lyricsNote("These lyrics aren't time-synced."));
    data.lines.forEach((line) => children.push(lyricElement(line, false)));
    return box.replaceChildren(...children);
  }

  // Synced: show the previous line, the current line (highlighted) and the next few.
  const from = Math.max(0, index - 1);
  const to = Math.min(data.lines.length, Math.max(index, 0) + 4);
  for (let i = from; i < to; i++) children.push(lyricElement(data.lines[i], i === index));
  box.replaceChildren(...children);
}

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

  lyrics.update(playback.state?.item); // starts loading lyrics when the song changes
  renderLyrics();
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

// ---------- Playlists ----------
let playlists = [];

function renderPlaylists() {
  const query = $("playlist-search").value.trim().toLowerCase();
  const ul = $("playlist-list");
  ul.replaceChildren();

  const shown = playlists.filter((p) => p.name.toLowerCase().includes(query));
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = playlists.length ? "No matches." : "No playlists found.";
    ul.appendChild(li);
    return;
  }

  for (const p of shown) {
    const li = document.createElement("li");
    const art = document.createElement(p.image ? "img" : "div");
    if (p.image) { art.src = p.image; art.alt = ""; art.loading = "lazy"; } else art.className = "no-art";
    const name = document.createElement("span");
    name.textContent = p.name;
    li.append(art, name);
    li.title = `Play ${p.name}`;
    li.onclick = () => playPlaylist(p);
    ul.appendChild(li);
  }
}

async function playPlaylist(p) {
  try {
    await controls.playContext(p.uri);
    showMessage(`Playing ${p.name}`);
  } catch (e) {
    showMessage(e.message);
  }
  setTimeout(refresh, 600);
}

async function togglePlaylists() {
  const panel = $("playlists");
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;

  $("playlist-list").innerHTML = '<li class="empty">Loading…</li>';
  try {
    playlists = await getPlaylists();
    renderPlaylists();
    $("playlist-search").focus();
  } catch (e) {
    $("playlist-list").innerHTML = "";
    showMessage(e.message);
  }
}

// ---------- Voice search: listen → find song → add to playlist ----------
let voiceRun = 0;        // bumps on cancel/restart so stale results are ignored
let recording = null;    // { kind: "openai" | "speech", rec }
let listenTimer;

const voiceStatus = (text) => { $("voice-status").textContent = text; };

function showPickList(items) {
  $("voice-results").replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    const art = document.createElement(item.image ? "img" : "div");
    if (item.image) { art.src = item.image; art.alt = ""; } else art.className = "no-art";
    const text = document.createElement("div");
    text.className = "text";
    const name = document.createElement("span");
    name.textContent = item.label;
    text.append(name);
    if (item.sub) {
      const sub = document.createElement("small");
      sub.textContent = item.sub;
      text.append(sub);
    }
    li.append(art, text);
    li.onclick = item.onPick;
    return li;
  }));
}

function setListening(on) {
  $("voice-btn").classList.toggle("listening", on);
  $("voice-btn").textContent = on ? "■ Stop & search" : "🎤 Find a song by voice";
}

async function onMicClick() {
  if (recording) return stopAndSearch(); // second tap = done talking

  voiceRun++;
  $("voice-panel").hidden = false;
  showPickList([]);
  try {
    if (getOpenAIKey()) recording = { kind: "openai", rec: await startBrowserRecording() };
    else if (browserSpeechAvailable()) recording = { kind: "speech", rec: startBrowserSpeech() };
    else {
      voiceStatus("Add your OpenAI key in Voice search settings below.");
      $("voice-settings").querySelector("details").open = true;
      return;
    }
  } catch (e) {
    return voiceStatus(e.message);
  }
  setListening(true);
  voiceStatus(`Listening… sing or say the song (up to ${MAX_LISTEN_MS / 1000}s). Tap again when done.`);
  listenTimer = setTimeout(stopAndSearch, MAX_LISTEN_MS);
}

async function stopAndSearch() {
  clearTimeout(listenTimer);
  const current = recording;
  recording = null;
  setListening(false);
  if (!current) return;
  const run = voiceRun;

  voiceStatus("Working out what you said…");
  try {
    let text;
    if (current.kind === "openai") {
      const { blob, filename } = await current.rec.stop();
      text = await transcribe(blob, filename);
    } else {
      text = (await current.rec.stop()).trim();
    }
    if (run !== voiceRun) return;
    if (!text) return voiceStatus("Didn't catch that. Try again a little closer to the mic.");

    voiceStatus(`Heard: “${text}”. Searching…`);
    const [songs, target] = await Promise.all([findSongs(text), currentEditablePlaylist(playback.state)]);
    if (run !== voiceRun) return;
    if (!songs.length) return voiceStatus(`Heard: “${text}”. No matching songs found.`);

    voiceStatus(`Heard: “${text}”. Tap the right song to add it to ${target ? target.name : "a playlist"}:`);
    showPickList(songs.map((s) => ({
      label: s.name, sub: s.artist, image: s.image, onPick: () => chooseSong(s, target),
    })));
  } catch (e) {
    if (run === voiceRun) voiceStatus(e.message);
  }
}

async function chooseSong(song, target) {
  if (target) return addSong(song, target);
  // Not playing from a playlist you can edit: pick one of your playlists.
  voiceStatus("Loading your playlists…");
  showPickList([]);
  try {
    const lists = await editablePlaylists();
    if (!lists.length) return voiceStatus("You don't have any playlists you can add songs to.");
    voiceStatus(`Add “${song.name}” to which playlist?`);
    showPickList(lists.map((p) => ({ label: p.name, image: p.image, onPick: () => addSong(song, p) })));
  } catch (e) {
    voiceStatus(e.message);
  }
}

async function addSong(song, playlist) {
  voiceStatus("Adding…");
  showPickList([]);
  try {
    await addTrackToPlaylist(playlist.id, song.uri);
    voiceStatus(`Added “${song.name}” to ${playlist.name} ✓`);
  } catch (e) {
    voiceStatus(e.message);
  }
}

async function closeVoice() {
  voiceRun++;
  clearTimeout(listenTimer);
  const current = recording;
  recording = null;
  setListening(false);
  $("voice-panel").hidden = true;
  if (current) { try { await current.rec.stop(); } catch {} }
}

function wireControls() {
  mountVoiceSettings($("voice-settings"));
  mountRomajiTools($("romaji-tools"), () => playback.state);
  $("voice-btn").onclick = onMicClick;
  $("voice-cancel").onclick = closeVoice;
  $("lyrics-toggle").onclick = () => { setLyricsEnabled(!lyricsEnabled()); renderLyrics(true); };
  $("playlists-toggle").onclick = togglePlaylists;
  $("playlist-search").oninput = renderPlaylists;

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
  setInterval(() => playback.isPlaying && render(), 250); // 250ms so lyric lines change on time
}

init();
