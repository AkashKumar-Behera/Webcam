/* LIVE PARTY v5.0 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, onChildAdded, remove, onDisconnect }
  from "https://www.gstatic.com/firebasejs/11.5.0/firebase-database.js";

const firebaseConfig = { apiKey: "AIzaSyBGnFw13ko0b4KAs7plpFmHlg0GohowElA", authDomain: "webrtc-cd5af.firebaseapp.com", databaseURL: "https://webrtc-cd5af-default-rtdb.asia-southeast1.firebasedatabase.app", projectId: "webrtc-cd5af" };
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const servers = {
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "turn:82.25.104.130:3478", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:3478?transport=tcp", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349?transport=tcp", username: "akash", credential: "hostinger_vps_123" }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle"
};

const cfAppId = 'e6be1e8812248470630854d4277238af';
const cfAppSecret = '3f671947386a7bf692d8326e509e3797be3c37c295337c98a6414d563c0bfeb3';

class RealtimeApp {
  constructor(appId, basePath = 'https://rtc.live.cloudflare.com/v1') { this.prefixPath = `${basePath}/apps/${appId}`; }
  async sendRequest(url, body, method = 'POST') {
    const res = await fetch(url, { method, mode: 'cors', headers: { 'content-type': 'application/json', Authorization: `Bearer ${cfAppSecret}` }, body: JSON.stringify(body) });
    return await res.json();
  }
  checkErrors(result, tracksCount = 0) {
    if (result.errorCode) throw new Error(result.errorDescription);
    for (let i = 0; i < tracksCount; i++) if (result.tracks[i].errorCode) throw new Error(`tracks[${i}]: ${result.tracks[i].errorDescription}`);
  }
  async newSession(offerSDP) {
    const res = await this.sendRequest(`${this.prefixPath}/sessions/new`, { sessionDescription: { type: 'offer', sdp: offerSDP } });
    this.checkErrors(res); this.sessionId = res.sessionId; return res;
  }
  async newTracks(trackObjects, offerSDP = null) {
    const body = { tracks: trackObjects };
    if (offerSDP) body.sessionDescription = { type: 'offer', sdp: offerSDP };
    const res = await this.sendRequest(`${this.prefixPath}/sessions/${this.sessionId}/tracks/new`, body);
    this.checkErrors(res, trackObjects.length); return res;
  }
  async sendAnswerSDP(answer) {
    const res = await this.sendRequest(`${this.prefixPath}/sessions/${this.sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp: answer } }, 'PUT');
    this.checkErrors(res);
  }
}

const RES_MAP = { 
  "2160p": { width: 3840, height: 2160 }, 
  "1440p": { width: 2560, height: 1440 }, 
  "1080p": { width: 1920, height: 1080 }, 
  "720p": { width: 1280, height: 720 }, 
  "480p": { width: 854, height: 480 }, 
  "360p": { width: 640, height: 360 }, 
  "240p": { width: 426, height: 240 }, 
  "144p": { width: 256, height: 144 } 
};

/* STATE */
let localStream = null, roomId = "", isHost = false, myName = "", sessionType = "party";
let screenPcMap = {}, viewerPc = null;
let connectedViewers = {}, pendingViewers = {};
let statsInterval = null, timerInterval = null, startTime = 0, prevBytesStat = 0;
let firebaseUnsubs = [], bgAudioSet = false, iceRestartCount = 0;
let audioCtx = null, movieNode = null, duckingActive = false;
let myVoiceStream = null, voicePcs = {}, silenceLoop = null;
let cfApp = null, myCfSessionId = null, myCfTrackNames = {};
let movieGainNode = null; // Removed redundant 'audioContext' let, using global 'audioCtx'
const MAX_ICE_RESTARTS = 3;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); logStatus("WakeLock active"); } } catch (_) { }
}

function gestureUnlock() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  g.gain.value = 0; osc.connect(g); g.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.1);

  const bg = document.getElementById("bgAudio"), sl = document.getElementById("silenceLoop");
  if (bg) { bg.play().catch(() => { }); bg.pause(); }
  if (sl) { sl.play().catch(() => { }); sl.pause(); }
  requestWakeLock();
  logStatus("Audio & WakeLock unlocked.");
}

function logIce(pc, label) { pc.onicegatheringstatechange = () => console.log(`[ICE ${label}] gather:${pc.iceGatheringState}`); pc.oniceconnectionstatechange = () => console.log(`[ICE ${label}] ice:${pc.iceConnectionState}`); }
function logCandidate(c, label) { if (!c) return; const t = c.candidate?.match(/typ (\w+)/)?.[1] || '?'; console.log(`[ICE ${label}] ${t}|${c.candidate?.substring(0, 60)}`); }

/* HELPERS */
function playProceduralSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    if (type === "join") { osc.type = "sine"; osc.frequency.setValueAtTime(440, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.2); gain.gain.setValueAtTime(0.1, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5); }
    else { osc.type = "sine"; osc.frequency.setValueAtTime(880, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2); gain.gain.setValueAtTime(0.1, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5); }
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch (_) { }
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function startSilenceLoop() {
  if (silenceLoop) return;
  try {
    const audio = document.getElementById("silenceLoop");
    if (!audio) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain(); gain.gain.value = 0.0001;
    osc.connect(gain); gain.connect(dest);
    osc.start();
    audio.srcObject = dest.stream;
    audio.play().then(() => { silenceLoop = { audio, osc, ctx }; }).catch(() => { });
  } catch (e) { }
}
function stopSilenceLoop() {
  if (silenceLoop) {
    try { silenceLoop.osc.stop(); silenceLoop.ctx.close(); silenceLoop.audio.pause(); silenceLoop.audio.srcObject = null; } catch (e) { }
    silenceLoop = null;
  }
}
function nameToHsl(n) { let h = 0; for (const c of String(n)) h = c.charCodeAt(0) + ((h << 5) - h); return `hsl(${Math.abs(h) % 360},65%,48%)`; }

function logStatus(msg) {
  console.log(`[STATUS] ${msg}`);
  const log = document.getElementById("connLog");
  if (log) {
    const el = document.createElement("div");
    el.textContent = `[${new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}] ${msg}`;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
    if (log.children.length > 50) log.children[0].remove();
  }
}

function mungerPreferH264(sdp) {
  const lines = sdp.split("\r\n"); let videoIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith("m=video ")) { videoIdx = i; break; } }
  if (videoIdx === -1) return sdp;
  const mLine = lines[videoIdx].split(" "); const payloads = mLine.slice(3);
  let h264Payloads = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("a=rtpmap:") && lines[i].toLowerCase().includes("h264")) {
      const p = lines[i].split(":")[1].split(" ")[0]; if (payloads.includes(p)) h264Payloads.push(p);
    }
  }
  if (!h264Payloads.length) return sdp;
  const others = payloads.filter(p => !h264Payloads.includes(p));
  mLine.splice(3, mLine.length - 3, ...h264Payloads, ...others);
  lines[videoIdx] = mLine.join(" "); return lines.join("\r\n");
}

/* MIC MANAGEMENT */
let micMeterInterval = null;
async function refreshAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = document.getElementById("micSelect");
    if (!micSelect) return;
    const prev = micSelect.value; micSelect.innerHTML = "";
    devices.filter(d => d.kind === "audioinput").forEach(d => {
      const opt = document.createElement("option"); opt.value = d.deviceId; opt.textContent = d.label || `Mic ${micSelect.length + 1}`;
      micSelect.appendChild(opt);
    });
    if (prev && [...micSelect.options].some(o => o.value === prev)) micSelect.value = prev;
  } catch (_) { }
}

function getMicConstraints() {
  const devId = document.getElementById("micSelect")?.value;
  const echo = document.getElementById("micEcho")?.checked ?? true;
  const noise = document.getElementById("micNoise")?.checked ?? true;
  const agc = document.getElementById("micAGC")?.checked ?? true;
  const con = { audio: { echoCancellation: echo, noiseSuppression: noise, autoGainControl: agc } };
  if (devId) con.audio.deviceId = { exact: devId };
  return con;
}

window.refreshMicMeter = async () => {
  if (micMeterInterval) { clearInterval(micMeterInterval); micMeterInterval = null; }
  const fill = document.getElementById("micMeterFill"); if (fill) fill.style.width = "0%";
  try {
    const stream = await navigator.mediaDevices.getUserMedia(getMicConstraints());
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyzer = ctx.createAnalyser(); analyzer.fftSize = 256;
    source.connect(analyzer);
    const data = new Uint8Array(analyzer.frequencyBinCount);
    micMeterInterval = setInterval(() => {
      analyzer.getByteFrequencyData(data);
      const vol = data.reduce((a, b) => a + b, 0) / data.length;
      if (fill) fill.style.width = Math.min(100, vol * 2) + "%";
    }, 100);
    // Cleanup after 5s or when tab changes
    setTimeout(() => { clearInterval(micMeterInterval); stream.getTracks().forEach(t => t.stop()); ctx.close(); if (fill) fill.style.width = "0%"; }, 5000);
  } catch (_) { }
};
// Trigger device list on load WITHOUT requesting permission immediately
navigator.mediaDevices.addEventListener("devicechange", refreshAudioDevices);
refreshAudioDevices(); // Only enumerates, doesn't prompt

/* STABILITY HELPERS */
function mungerPreferOpus(sdp) {
  const lines = sdp.split("\r\n");
  let audioIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith("m=audio ")) { audioIdx = i; break; } }
  if (audioIdx === -1) return sdp;
  // ULTRA-FIDELITY: 510kbps Stereo (Max Opus Specs) for original-quality music and movies
  let newSdp = sdp.replace(/a=fmtp:(\d+) (.*)/g, (m, p1, p2) => {
    if (sdp.includes("a=rtpmap:" + p1 + " opus/48000")) {
      return `a=fmtp:${p1} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000`;
    }
    return m;
  });
  return newSdp;
}

function mungerPreferVP9(sdp) {
  const lines = sdp.split("\r\n");
  let videoIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith("m=video ")) { videoIdx = i; break; } }
  if (videoIdx === -1) return sdp;
  const mLine = lines[videoIdx].split(" ");
  const payloads = mLine.slice(3);
  let vp9Payloads = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("a=rtpmap:") && lines[i].toLowerCase().includes("vp9")) {
      const p = lines[i].split(":")[1].split(" ")[0];
      if (payloads.includes(p)) vp9Payloads.push(p);
    }
  }
  if (!vp9Payloads.length) return sdp;
  const otherPayloads = payloads.filter(p => !vp9Payloads.includes(p));
  mLine.splice(3, mLine.length - 3, ...vp9Payloads, ...otherPayloads);
  lines[videoIdx] = mLine.join(" ");
  return lines.join("\r\n");
}

/* UI */
const scrollChat = () => { const c = document.getElementById("chatMessages"); if (c) { requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; setTimeout(() => { c.scrollTop = c.scrollHeight; }, 100); }); } };
function showToast(msg) { const t = document.getElementById("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 3500); }

function addSystemMsg(text) { const c = document.getElementById("chatMessages"); if (!c) return; const el = document.createElement("div"); el.className = "chat-system"; el.textContent = text; c.appendChild(el); scrollChat(); }

function addFloatingChatMsg(sender, text) {
  const overlay = document.getElementById("fullscreenChatOverlay"); if (!overlay) return;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
  const el = document.createElement("div"); el.className = "fs-chat-msg";
  el.innerHTML = `<b>${esc(sender)}</b> ${esc(text)}`; overlay.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

window.shareRoom = () => { const r = document.getElementById("roomId")?.value.trim() || roomId; if (!r) return showToast("⚠️ Start a session first"); const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(r)}`; if (navigator.share) { navigator.share({ title: "Join my Watch Party! 🍿", url }).catch(() => { }); } else { navigator.clipboard?.writeText(url).then(() => showToast("🔗 Link copied!")).catch(() => showToast(url)); } };

function updateConnStatus(state) { const dot = document.getElementById("connDot"), label = document.getElementById("connLabel"); if (!dot || !label) return; dot.classList.remove("connected", "connecting", "live"); if (state === "connected") { dot.classList.add("connected"); label.textContent = "CONNECTED"; } else if (state === "connecting") { dot.classList.add("connecting"); label.textContent = "CONNECTING..."; } else { label.textContent = "DISCONNECTED"; } }

function changeActionBtns(mode) { const c = document.getElementById("actionBtns"); if (!c) return; if (mode === "session") { c.innerHTML = `<button class="btn-action end" onclick="leaveCall()"><span class="material-symbols-outlined">stop_circle</span> Leave Session</button>`; } else { c.innerHTML = `<button class="btn-action host" onclick="confirmHost()"><span class="material-symbols-outlined">cast</span> Start Host Session</button><button class="btn-action join" onclick="confirmJoin()"><span class="material-symbols-outlined">login</span> Join Watch Party</button>`; } }

/* PEOPLE TAB */
function renderPeopleTab() {
  const c = document.getElementById("peopleList"); if (!c) return;
  let html = "";
  const pending = Object.entries(pendingViewers);
  if (isHost && pending.length > 0) { html += `<div class="ppl-section">⏳ Waiting to Join</div>`; for (const [vid, d] of pending) { const col = nameToHsl(d.name); html += `<div class="ppl-item pending-item"><div class="ppl-av" style="background:${col}">${d.name[0].toUpperCase()}</div><div class="ppl-name">${esc(d.name)}</div><div class="ppl-btns"><button class="pa-btn approve" onclick="approveViewer('${vid}','${esc(d.name)}')"><span class="material-symbols-outlined">check</span></button><button class="pa-btn deny" onclick="denyViewer('${vid}','${esc(d.name)}')"><span class="material-symbols-outlined">close</span></button></div></div>`; } }

  html += `<div class="ppl-section">👥 In Session</div>`;
  
  // Show Host info (Prefetched or from Firebase)
  get(ref(db, `rooms/${roomId}/host`)).then(s => {
    const h = s.val();
    if (h && h.name !== myName) {
      const col = nameToHsl(h.name);
      const hostHtml = `<div class="ppl-item"><div class="ppl-av" style="background:${col}">${h.name[0].toUpperCase()}</div><div class="ppl-name">${esc(h.name)} <span class="role-badge">HOST</span></div></div>`;
      if (!c.innerHTML.includes(h.name)) c.innerHTML = hostHtml + c.innerHTML;
    }
  });

  // Show "You"
  const colMe = nameToHsl(myName || "User");
  html += `<div class="ppl-item"><div class="ppl-av" style="background:${colMe}">${(myName || "U")[0].toUpperCase()}</div><div class="ppl-name">${esc(myName || "User")} <span class="role-badge">${isHost ? "HOST" : "YOU"}</span></div></div>`;

  const connectedArr = Object.entries(connectedViewers);
  for (const [vid, p] of connectedArr) {
    if (p.name === myName) continue;
    const col = nameToHsl(p.name);
    html += `<div class="ppl-item"><div class="ppl-av" style="background:${col}">${p.name[0].toUpperCase()}</div><div class="ppl-name">${esc(p.name)}</div>${isHost ? `<button class="pa-btn kick" onclick="kickViewer('${vid}','${esc(p.name)}')"><span class="material-symbols-outlined">person_remove</span></button>` : ""}</div>`;
  }

  if (!html) html = `<div class="ppl-empty"><span class="material-symbols-outlined">group</span><p>No one yet</p></div>`;
  c.innerHTML = html;
  const badge = document.getElementById("peopleBadge"); if (badge) { badge.textContent = pending.length; badge.style.display = pending.length > 0 ? "flex" : "none"; }
}

window.approveViewer = async (vid, name) => { await set(ref(db, `rooms/${roomId}/waitroom/${vid}/status`), "approved"); delete pendingViewers[vid]; renderPeopleTab(); };
window.denyViewer = async (vid, name) => { await set(ref(db, `rooms/${roomId}/waitroom/${vid}/status`), "denied"); setTimeout(() => remove(ref(db, `rooms/${roomId}/waitroom/${vid}`)), 3000); delete pendingViewers[vid]; renderPeopleTab(); showToast(`✗ ${name} declined`); };
window.kickViewer = async (vid, name) => { await set(ref(db, `rooms/${roomId}/viewers/${vid}/kicked`), true); setTimeout(() => remove(ref(db, `rooms/${roomId}/viewers/${vid}`)), 2000); try { screenPcMap[vid]?.close(); } catch (_) { } delete screenPcMap[vid]; delete connectedViewers[vid]; renderPeopleTab(); showToast(`👢 ${name} removed`); };
window.muteAllViewers = async () => { if (!isHost || !roomId) return; await set(ref(db, `rooms/${roomId}/muteAll`), Date.now()); showToast("🤫 Muted all viewers"); };
window.applyBitrateNow = () => { logStatus("Bitrate dynamically managed by Cloudflare SFU."); };

window.pushHostSettings = () => {
  if (!isHost || !roomId) return;
  const sRes = document.getElementById("scrResS")?.value || "1080p";
  const sFps = document.getElementById("scrFpsS")?.value || "30";
  const sBit = document.getElementById("bitrateSliderS")?.value || "4";
  const sDel = document.getElementById("streamDelaySlider")?.value || "0.05";
  set(ref(db, `rooms/${roomId}/settings`), { quality: sRes, fps: sFps, bitrate: sBit, delay: sDel, type: sessionType });
};

window.setMode = (m) => {
  sessionType = m;
  document.getElementById("modalMode").value = m;
  document.getElementById("modeParty").style.background = m === 'party' ? 'var(--accent-dim)' : 'var(--surface)';
  document.getElementById("modeParty").style.borderColor = m === 'party' ? 'var(--accent)' : 'var(--glass-border)';
  document.getElementById("modeBroadcast").style.background = m === 'broadcast' ? 'var(--accent-dim)' : 'var(--surface)';
  document.getElementById("modeBroadcast").style.borderColor = m === 'broadcast' ? 'var(--accent)' : 'var(--glass-border)';
  document.getElementById("micOptionHost").style.display = m === 'broadcast' ? 'none' : 'flex';
};

window.replaceScreenShareBtn = async () => {
  if (!isHost || !roomId) return;
  const resStr = document.getElementById("scrResS")?.value || "1080p", fpsStr = document.getElementById("scrFpsS")?.value || "30";
  const { width, height } = RES_MAP[resStr] || RES_MAP["1080p"], fps = parseInt(fpsStr) || 30;
  const con = { video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } }, audio: { channelCount: 2, sampleRate: 48000, autoGainControl: false, echoCancellation: false, noiseSuppression: false } };
  let newStream;
  try { newStream = await navigator.mediaDevices.getDisplayMedia(con); }
  catch { con.audio = true; try { newStream = await navigator.mediaDevices.getDisplayMedia(con); } catch { con.audio = false; newStream = await navigator.mediaDevices.getDisplayMedia(con); } }

  if (!newStream) return;
  const vt = newStream.getVideoTracks()[0]; if (vt && "contentHint" in vt) vt.contentHint = "detail";

  // Stop old tracks
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); }
  localStream = newStream;
  const video = document.getElementById("remoteVideo"); video.srcObject = localStream;
  vt.onended = () => leaveCall();

  // Replace tracks in all active peer connections
  Object.values(screenPcMap).forEach(pc => {
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
      const kind = track.kind;
      const sender = senders.find(s => s.track && s.track.kind === kind);
      if (sender) { 
        sender.replaceTrack(track); 
      } else {
        pc.addTransceiver(track, { direction: 'sendonly' });
      }
    });
  });

  // Update Firebase host metadata with STABLE NAMES (already movie-v/movie-a)
  set(ref(db, `rooms/${roomId}/host`), {
    name: myName,
    created: Date.now(),
    cfSessionId: cfApp.sessionId,
    cfTrackVideo: "movie-v",
    cfTrackAudio: "movie-a",
    role: 'host'
  });
  showToast("🔄 Quality updated & audio stabilized");
};

/* CAPTURE */
async function captureScreen() {
  const resStr = document.getElementById("scrRes")?.value || "1080p", fpsStr = document.getElementById("scrFps")?.value || "30";
  const { width, height } = RES_MAP[resStr] || RES_MAP["1080p"], fps = parseInt(fpsStr) || 30;
  const con = { video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } }, audio: { channelCount: 2, sampleRate: 48000, autoGainControl: false, echoCancellation: false, noiseSuppression: false } };

  try { localStream = await navigator.mediaDevices.getDisplayMedia(con); }
  catch { con.audio = true; try { localStream = await navigator.mediaDevices.getDisplayMedia(con); } catch { con.audio = false; localStream = await navigator.mediaDevices.getDisplayMedia(con); } }

  // Mix Mic if enabled (only if not in broadcast mode)
  if (document.getElementById("modalHostMic")?.checked && sessionType !== 'broadcast') {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia(getMicConstraints());
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();

      const existingAudioTracks = localStream.getAudioTracks();
      if (existingAudioTracks.length > 0) {
        const source1 = ctx.createMediaStreamSource(new MediaStream([existingAudioTracks[0]]));
        source1.connect(dest);
      }
      const source2 = ctx.createMediaStreamSource(micStream);
      source2.connect(dest);

      const mixedTrack = dest.stream.getAudioTracks()[0];
      // Do NOT stop existing tracks since source1 needs them flowing!
      existingAudioTracks.forEach(t => localStream.removeTrack(t));
      localStream.addTrack(mixedTrack);
      localStream._micStream = micStream; // store to stop later
    } catch (e) { console.warn("Mic capture failed", e); }
  }

  const vt = localStream.getVideoTracks()[0]; if (vt && "contentHint" in vt) vt.contentHint = "detail";
  const video = document.getElementById("remoteVideo"); video.srcObject = localStream; video.muted = true;
  vt.onended = () => leaveCall(); return localStream;
}

/* OPTIMIZE SENDER */
async function optimizeHostSender(pc, vid = null) {
  let mbps = parseFloat(document.getElementById("bitrateSlider")?.value || "4");
  const fps = parseInt(document.getElementById("scrFps")?.value || "30") || 30;

  for (const s of pc.getSenders()) {
    if (!s.track) continue;
    const p = s.getParameters();
    if (s.track.kind === "video") {
      if (!p.encodings?.length || p.encodings.length < 3) continue;

      // High Layer (Layer 2)
      p.encodings[2].maxBitrate = mbps * 1_000_000;
      p.encodings[2].maxFramerate = fps;
      p.encodings[2].networkPriority = "high";
      p.encodings[2].priority = "high";

      // Mid Layer (Layer 1)
      p.encodings[1].maxBitrate = Math.min(1000000, mbps * 500000);
      p.encodings[1].scaleResolutionDownBy = 2.0;

      // Low Layer (Layer 0) - starting from 144p
      p.encodings[0].maxBitrate = 150_000;
      p.encodings[0].scaleResolutionDownBy = 4.0;

      p.degradationPreference = "maintain-resolution"; // YouTube style sharp text
    } else if (s.track.kind === "audio") {
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].networkPriority = "high";
      p.encodings[0].priority = "high"; // Audio priority over video
    }
    try { await s.setParameters(p); } catch (_) { }
  }
}

/* HOST */
window.confirmHost = async () => {
  gestureUnlock();
  roomId = document.getElementById("roomId").value.trim(); myName = document.getElementById("userName").value.trim() || "Host";
  if (!roomId) { roomId = Math.random().toString(36).substr(2, 8).toUpperCase(); document.getElementById("roomId").value = roomId; }
  sessionType = document.getElementById("modalMode")?.value || "party";
  logStatus(`Host session starting (${sessionType} mode)...`);
  try { await captureScreen(); } catch { logStatus("Capture canceled"); return showToast("⚠️ Screen share cancelled"); }
  isHost = true;
  logStatus("Screen captured successfully");
  window._myVid = "host";
  startSilenceLoop();
  document.getElementById("noSignal").classList.add("hidden");
  document.getElementById("liveBadge").style.display = "flex";
  document.getElementById("sourceTag").style.display = ""; document.getElementById("sourceTag").textContent = "HOSTING";
  updateConnStatus("connected"); changeActionBtns("session");
  document.getElementById("hostOnlySettings")?.style.removeProperty("display");
  document.getElementById("lowDataGroup") && (document.getElementById("lowDataGroup").style.display = "none");
  if (sessionType === "broadcast") {
    document.getElementById("micBtnMain").style.display = "none";
    document.getElementById("micBtnChat").style.display = "none";
  }
  window.switchTab("chat"); renderPeopleTab();

  cfApp = new RealtimeApp(cfAppId);
  const pc = new RTCPeerConnection(servers);
  screenPcMap["host_cf"] = pc; // Keep reference to cleanup later

  pc.ontrack = e => {
    const track = e.track;
    if (track.kind === "audio") {
      logStatus(`Host received Voice track: ${track.id}`);
      const au = document.createElement("audio");
      au.id = `voice_${track.id}`;
      au.autoplay = true;
      au.srcObject = new MediaStream([track]);
      document.body.appendChild(au);
      track.onended = () => { if (au.parentNode) au.parentNode.removeChild(au); };
      track.onmute = () => { if (au.parentNode) au.parentNode.removeChild(au); };
    }
  };

  let localTransceivers = [];
  if (localStream) {
    localStream.getTracks().forEach(track => {
      localTransceivers.push(pc.addTransceiver(track, { direction: "sendonly" }));
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  const newSessionResult = await cfApp.newSession(pc.localDescription.sdp);
  await pc.setRemoteDescription(new RTCSessionDescription(newSessionResult.sessionDescription));

  await new Promise((resolve, reject) => {
    pc.addEventListener('iceconnectionstatechange', ev => {
      if (pc.iceConnectionState === 'connected') resolve();
    });
    setTimeout(resolve, 5000); // safety fallback
  });

  logStatus("Cloudflare SFU Host Session Created.");
  myCfSessionId = cfApp.sessionId;

  let trackObjects = localTransceivers.map(t => { 
    const isVid = t.sender.track.kind === 'video';
    return { location: 'local', mid: t.mid, trackName: isVid ? "movie-v" : "movie-a" }; 
  });

  await pc.setLocalDescription(await pc.createOffer());
  const newLocalTracksResult = await cfApp.newTracks(trackObjects, pc.localDescription.sdp);
  await pc.setRemoteDescription(new RTCSessionDescription(newLocalTracksResult.sessionDescription));
  logStatus("Tracks published to Cloudflare SFU.");

  const roomRef = ref(db, `rooms/${roomId}`);
  logStatus(`Registering host in room: ${roomId}`);
  await set(ref(db, `rooms/${roomId}/host`), {
    name: myName,
    created: Date.now(),
    cfSessionId: myCfSessionId,
    cfTrackVideo: "movie-v",
    cfTrackAudio: "movie-a",
    role: 'host'
  }).catch(e => logStatus(`Firebase Error: ${e.message}`));
  onDisconnect(roomRef).remove();

  // Waitroom UI
  const unsubW = onChildAdded(ref(db, `rooms/${roomId}/waitroom`), snap => {
    const vid = snap.key, data = snap.val(); if (!data || !vid || data.status) return;
    logStatus(`Approval request from: ${data.name || "Viewer"}`);
    pendingViewers[vid] = { name: data.name || "Viewer" }; renderPeopleTab(); showToast(`🔔 ${data.name} wants to join`); window.switchTab("people");
  });

  // Voice Pull Listener
  const unsubVoice = onChildAdded(ref(db, `rooms/${roomId}/voice`), async snap => {
    if (sessionType === 'broadcast') return;
    const peerVid = snap.key; if (peerVid === window._myVid || !snap.val()) return;
    pullVoiceTracks(snap.val().cfSessionId, snap.val().trackName, pc);
  });

  firebaseUnsubs.push(unsubW, unsubVoice);

  const unsubV = onChildAdded(ref(db, `rooms/${roomId}/viewers`), async snap => {
    const vid = snap.key; if (!vid) return;
    const ts = snap.val()?.requestedAt || 0;
    if (ts < Date.now() - 3600000) return;
    logStatus(`Viewer ${vid.substring(0, 6)} confirmed entry`);
    get(ref(db, `rooms/${roomId}/viewers/${vid}/ready`)).then(s => { const n = s.val()?.name || "Viewer"; connectedViewers[vid] = { name: n }; renderPeopleTab(); addSystemMsg(`👋 ${n} joined`); playProceduralSound("join"); });
  }); firebaseUnsubs.push(unsubV);

  startHostStats(); startChatListener(); startReactionListener();
  window.pushHostSettings();
  showToast("🎬 Live! Room: " + roomId);
};


/* VIEWER */
window.confirmJoin = async () => {
  gestureUnlock();
  roomId = document.getElementById("roomId").value.trim(); myName = document.getElementById("userName").value.trim() || "Viewer";
  if (!roomId) return showToast("⚠️ Enter Room Code");
  logStatus(`Joining room: ${roomId}`);
  if (myName) localStorage.setItem("watchparty_name", myName);
  isHost = false; bgAudioSet = false; updateConnStatus("connecting");

  // Mobile Gesture Unlock
  const v = document.getElementById("remoteVideo"); if (v) { v.play().catch(() => { }); }

  document.getElementById("hostOnlySettings") && (document.getElementById("hostOnlySettings").style.display = "none");
  document.getElementById("lowDataGroup") && (document.getElementById("lowDataGroup").style.display = "flex");
  const myVid = "v_" + Math.random().toString(36).substr(2, 9);
  window._myVid = myVid;
  logStatus(`Waitroom ID: ${myVid}`);
  await set(ref(db, `rooms/${roomId}/waitroom/${myVid}`), { name: myName, requestedAt: Date.now() }).catch(e => logStatus(`Waitroom Write Error: ${e.message}`));
  onDisconnect(ref(db, `rooms/${roomId}/waitroom/${myVid}`)).remove();
  const ns = document.getElementById("noSignal"); ns.classList.remove("hidden");
  ns.querySelector("h3").textContent = "Waiting for host..."; ns.querySelector("p").textContent = "Host will let you in shortly";
  logStatus("Sent join request, waiting for approval...");
  const unsubS = onValue(ref(db, `rooms/${roomId}/waitroom/${myVid}/status`), async ss => {
    const status = ss.val(); if (!status) return; unsubS();
    if (status === "approved") { logStatus("Request Approved!"); ns.classList.add("hidden"); await proceedJoin(myVid, myName); }
    else { logStatus("Request Declined."); showToast("❌ Host declined your request"); updateConnStatus("disconnected"); changeActionBtns("init"); ns.querySelector("h3").textContent = "Waiting for Screen Share"; ns.querySelector("p").textContent = "Connect to join or host a session"; }
  }); firebaseUnsubs.push(unsubS);
};

async function proceedJoin(myVid, userName) {
  try {
    logStatus("Starting connection sequence...");
    onDisconnect(ref(db, `rooms/${roomId}/viewers/${myVid}`)).remove();
    startSilenceLoop();
    await set(ref(db, `rooms/${roomId}/viewers/${myVid}/ready`), { name: userName });

    logStatus("Fetching host metadata...");
    const hostSnap = await get(ref(db, `rooms/${roomId}/host`));
    const hostData = hostSnap.val();
    if (!hostData || !hostData.cfSessionId) {
      logStatus("Host not running Cloudflare SFU. Aborting.");
      showToast("❌ Host not broadcasting");
      return leaveCall();
    }
    logStatus(`Host found with CF Session: ${hostData.cfSessionId.substring(0, 6)}...`);
    sessionType = (await get(ref(db, `rooms/${roomId}/settings/type`))).val() || "party";
    logStatus(`Session Mode: ${sessionType}`);
    if (sessionType === "broadcast") {
      document.getElementById("micBtnMain").style.display = "none";
      document.getElementById("micBtnChat").style.display = "none";
    }
    const unsubType = onValue(ref(db, `rooms/${roomId}/settings/type`), s => { if (s.val()) sessionType = s.val(); });
    firebaseUnsubs.push(unsubType);

    cfApp = new RealtimeApp(cfAppId);
    const pc = new RTCPeerConnection(servers); viewerPc = pc;
    const video = document.getElementById("remoteVideo"), remoteStream = new MediaStream();
    video.srcObject = remoteStream; video.muted = true; // Use bgAudio sink
    const hostAudID = "movie-a"; // Always use stable name for audio

    let currentDelayHint = 0.05;

    pc.ontrack = e => {
      const track = e.track;
      logStatus(`Received track: ${track.kind} (ID: ${track.id})`);
      
      // Volume/Audio Control Setup (already unlocked by gesture)
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();

      if (!movieGainNode) {
        movieGainNode = audioCtx.createGain();
        movieGainNode.gain.value = window._movieVol || 1.0;
        movieGainNode.connect(audioCtx.destination);
        window.updateGain = (v) => { if (movieGainNode) movieGainNode.gain.setValueAtTime(v, audioCtx.currentTime); };
      }

      if (e.receiver) {
        if (track.kind === "audio") { try { e.receiver.playoutDelayHint = 0; } catch (_) { } }
        else {
          try { e.receiver.playoutDelayHint = currentDelayHint; } catch (_) { }
          if ("contentHint" in track) track.contentHint = "detail";
          const unsubDel = onValue(ref(db, `rooms/${roomId}/settings/delay`), s => {
            if (s.val()) {
              currentDelayHint = parseFloat(s.val());
              try { e.receiver.playoutDelayHint = currentDelayHint; } catch (_) { }
            }
          }); firebaseUnsubs.push(unsubDel);
        }
      }
      if (!remoteStream.getTracks().find(t => t.id === track.id)) remoteStream.addTrack(track);

      video.play().catch(() => {
        logStatus("Autoplay blocked. User interaction required.");
      });

      // IDENTIFY: Movie Audio vs Viewer Voice
      // hostAudID should match track.id (or track.id starts with it if browser prepends)
      const isMovieAud = track.kind === "audio" && (track.id === hostAudID || (hostAudID && track.id.includes(hostAudID)));

      if (isMovieAud && !bgAudioSet) {
        bgAudioSet = true;
        const bg = document.getElementById("bgAudio");
        bg.srcObject = new MediaStream([track]);
        
        // Connect to Web Audio for volume control
        const source = audioCtx.createMediaStreamSource(bg.srcObject);
        source.connect(movieGainNode);
        
        bg.play().then(() => {
          logStatus("Movie audio started (via Web Audio)");
          if ("mediaSession" in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title: `Room: ${roomId}`, artist: "Live Party", album: "Watch Party", artwork: [{ src: "https://cdn-icons-png.flaticon.com/512/3163/3163478.png", sizes: "512x512", type: "image/png" }] });
            const playP = () => { bg.play(); if (audioCtx.state === 'suspended') audioCtx.resume(); };
            navigator.mediaSession.setActionHandler('play', playP);
            navigator.mediaSession.setActionHandler('pause', () => bg.pause());
          }
        }).catch(e => logStatus(`Audio play error trace: ${e.message}`));
      } else if (track.kind === "audio" && !isMovieAud && sessionType !== 'broadcast') {
        // Only play if it's NOT our own voice track (precautionary)
        const auId = `voice_${track.id}`;
        if (document.getElementById(auId)) return;

        const au = document.createElement("audio");
        au.id = auId;
        au.autoplay = true;
        au.srcObject = new MediaStream([track]);
        document.body.appendChild(au);
        track.onended = () => { if (au.parentNode) au.parentNode.removeChild(au); };
        track.onmute = () => { if (au.parentNode) au.parentNode.removeChild(au); };
      }
    };

    pc.onconnectionstatechange = () => {
      logStatus(`[Viewer] ${pc.connectionState}`);
      if (pc.connectionState === "connected") { updateConnStatus("connected"); document.getElementById("noSignal").classList.add("hidden"); document.getElementById("sourceTag").style.display = ""; document.getElementById("sourceTag").textContent = "WATCHING"; changeActionBtns("session"); window.switchTab("chat"); renderPeopleTab(); showToast("🎬 Connected!"); }
      if (pc.connectionState === "disconnected") { updateConnStatus("connecting"); showToast("⚡ Reconnecting..."); cfApp?.renegotiate().catch(() => { }); }
      if (pc.connectionState === "failed") { logStatus("Connection Failed definitively."); updateConnStatus("disconnected"); leaveCall(); }
    };

    onValue(ref(db, `rooms/${roomId}/viewers/${myVid}/kicked`), s => { if (s.val()) { showToast("⛔ Removed by host"); leaveCall(); } });
    onValue(ref(db, `rooms/${roomId}/muteAll`), s => { if (s.val() && myVoiceStream) { toggleVoiceChat(); showToast("🤫 Host muted microphones"); } });

    let trackObjects = [];
    if (hostData.cfTrackVideo) trackObjects.push({ location: 'remote', sessionId: hostData.cfSessionId, trackName: hostData.cfTrackVideo });
    if (hostData.cfTrackAudio) trackObjects.push({ location: 'remote', sessionId: hostData.cfSessionId, trackName: hostData.cfTrackAudio });

    if (trackObjects.length === 0) {
      logStatus("Host sent no tracks!"); return;
    }

    // Explicit transceivers to ensure SDP has media sections
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });

    logStatus("Creating cloudflare viewer session...");
    await pc.setLocalDescription(await pc.createOffer());
    const newSessionResult = await cfApp.newSession(pc.localDescription.sdp);
    logStatus("Setting Session Remote Description...");
    await pc.setRemoteDescription(new RTCSessionDescription(newSessionResult.sessionDescription));

    logStatus(`Requesting ${trackObjects.length} tracks from Host`);
    const newRemoteTracksResult = await cfApp.newTracks(trackObjects);
    if (newRemoteTracksResult.requiresImmediateRenegotiation) {
      switch (newRemoteTracksResult.sessionDescription.type) {
        case 'offer':
          logStatus("Applying incoming Offer from CF");
          await pc.setRemoteDescription(new RTCSessionDescription(newRemoteTracksResult.sessionDescription));
          await pc.setLocalDescription(await pc.createAnswer());
          await cfApp.sendAnswerSDP(pc.localDescription.sdp);
          logStatus("Answer sent for incoming tracks.");
          break;
        default: throw new Error("Expected offer SDP from Cloudflare");
      }
    }

    const unsubPV = onChildAdded(ref(db, `rooms/${roomId}/viewers`), s => {
      const vid = s.key; if (!vid) return;
      // Allow self addition to pass so I appear in my own People list
      get(ref(db, `rooms/${roomId}/viewers/${vid}/ready`)).then(sn => { const n = sn.val()?.name || "Viewer"; if (!connectedViewers[vid]) { connectedViewers[vid] = { name: n }; renderPeopleTab(); playProceduralSound("join"); } });
    });
    const unsubPR = onChildAdded(ref(db, `rooms/${roomId}/viewers`), () => renderPeopleTab());
    const unsubPD = onValue(ref(db, `rooms/${roomId}/viewers`), snap => {
      const current = snap.val() || {};
      Object.keys(connectedViewers).forEach(vid => { if (!current[vid] && vid !== myVid) { const name = connectedViewers[vid].name; delete connectedViewers[vid]; renderPeopleTab(); addSystemMsg(`🚪 ${name} left`); playProceduralSound("leave"); } });
    });
    firebaseUnsubs.push(unsubPV, unsubPR, unsubPD);

    // Voice Pull Listener
    const unsubVoice = onChildAdded(ref(db, `rooms/${roomId}/voice`), async snap => {
      const peerVid = snap.key; if (peerVid === window._myVid || !snap.val()) return;
      pullVoiceTracks(snap.val().cfSessionId, snap.val().trackName, pc);
    }); firebaseUnsubs.push(unsubVoice);

    startChatListener(); startReactionListener();

  } catch (err) {
    logStatus(`Viewer Crash: ${err.message}`);
    console.error(err);
    showToast("❌ Connection error");
    updateConnStatus("disconnected");
    leaveCall();
  }
}

/* LEAVE */
/* LEAVE */
window.leaveCall = async () => {
  stopStats(); stopSilenceLoop(); firebaseUnsubs.forEach(u => { try { u(); } catch (_) { } }); firebaseUnsubs = [];
  Object.values(screenPcMap).forEach(pc => { try { pc.close(); } catch (_) { } }); screenPcMap = {};
  if (viewerPc) { try { viewerPc.close(); } catch (_) { } viewerPc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (myVoiceStream) { myVoiceStream.getTracks().forEach(t => t.stop()); myVoiceStream = null; }
  const bg = document.getElementById("bgAudio"); if (bg) { bg.srcObject = null; bg.pause(); }
  if (isHost && roomId) remove(ref(db, `rooms/${roomId}`));
  const ns = document.getElementById("noSignal"); ns.classList.remove("hidden"); ns.querySelector("h3").textContent = "Waiting for Screen Share"; ns.querySelector("p").textContent = "Connect to join or host a session";
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("liveBadge").style.display = "none";
  ["sourceTag", "qualityTag"].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = "none"; });
  document.getElementById("hostOnlySettings") && (document.getElementById("hostOnlySettings").style.display = "none");
  updateConnStatus("disconnected"); changeActionBtns("init");
  document.getElementById("chatMessages").innerHTML = `<div style="text-align:center;color:var(--text-muted);margin-top:30px;font-size:11px;">💬 Messages visible to everyone</div>`;
  connectedViewers = {}; pendingViewers = {}; renderPeopleTab();
  roomId = ""; isHost = false; bgAudioSet = false; myName = ""; showToast("👋 Disconnected");
};

/* CHAT */
window.sendChat = () => { const inp = document.getElementById("chatInput"), msg = inp?.value.trim(); if (!msg || !roomId) return; const name = document.getElementById("userName")?.value.trim() || (isHost ? "Host" : "Viewer"); push(ref(db, `rooms/${roomId}/chat`), { sender: name, text: msg, time: Date.now() }); inp.value = ""; };

window.handleChatImageUpload = (input) => {
  if (!input.files || !input.files[0] || !roomId) return;
  const file = input.files[0];
  if (file.size > 2000000) { showToast("⚠️ Image too large (Max 2MB)"); input.value = ""; return; } // basic guard
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if (w > 400) { h = h * (400 / w); w = 400; } // aggressive resize for firebase
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const b64 = canvas.toDataURL("image/jpeg", 0.7);
      const name = document.getElementById("userName")?.value.trim() || (isHost ? "Host" : "Viewer");
      push(ref(db, `rooms/${roomId}/chat`), { sender: name, text: null, image: b64, time: Date.now() });
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = "";
};

function startChatListener() {
  if (!roomId) return; const ts = Date.now(); const myN = document.getElementById("userName")?.value.trim() || (isHost ? "Host" : "Viewer");
  const unsub = onChildAdded(ref(db, `rooms/${roomId}/chat`), snap => {
    const d = snap.val(); if (!d || d.time < ts - 1000) return;
    const msgId = `chat_${snap.key}`; if (document.getElementById(msgId)) return;
    const wrap = document.createElement("div"); wrap.className = "chat-msg"; wrap.id = msgId;
    const isMe = d.sender === myN, time = new Date(d.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const col = nameToHsl(d.sender), init = d.sender[0]?.toUpperCase() || "?";

    let contentHtml = "";
    if (d.image) contentHtml = `<img src="${d.image}" onclick="window.fullScreenImg(this.src)" style="cursor:pointer;" />`;
    else contentHtml = esc(d.text);

    wrap.innerHTML = `
      <div class="chat-msg-header"><div class="chat-av" style="background:${col}">${init}</div><span class="chat-sender" style="color:${isMe ? "var(--accent)" : "var(--cyan)"}">${isMe ? "You" : esc(d.sender)}</span><span class="chat-time">${time}</span></div>
      <div class="chat-bubble ${isMe ? "me" : "other"}">${contentHtml}</div>
    `;
    const c = document.getElementById("chatMessages"); if (c) { c.appendChild(wrap); scrollChat(); }
    if (!document.getElementById("contentChat")?.classList.contains("active")) {
      const badge = document.getElementById("chatBadge"); if (badge) { badge.style.display = "inline-flex"; }
      try { new Audio("https://actions.google.com/sounds/v1/water/water_drop.ogg").play(); } catch (e) { }
    }
    if (d.text) addFloatingChatMsg(isMe ? "You" : d.sender, d.text);
  }); firebaseUnsubs.push(unsub);
}

window.fullScreenImg = (src) => {
  const overlay = document.createElement('div');
  overlay.className = 'fs-img-overlay';
  overlay.innerHTML = `<img src="${src}" />`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
};

/* REACTIONS */
window.sendReaction = emoji => { if (!roomId) return showToast("⚠️ Connect first"); push(ref(db, `rooms/${roomId}/reactions`), { emoji, time: Date.now() + Math.random() }); triggerEmojiUI(emoji); };
function startReactionListener() { if (!roomId) return; const ts = Date.now(); const u = onChildAdded(ref(db, `rooms/${roomId}/reactions`), snap => { const d = snap.val(); if (!d || d.time < ts) return; triggerEmojiUI(d.emoji); }); firebaseUnsubs.push(u); }
function triggerEmojiUI(emoji) { const ov = document.getElementById("emojiOverlay"); if (!ov) return; const el = document.createElement("div"); el.className = "emoji-float"; el.textContent = emoji; el.style.left = (15 + Math.random() * 70) + "%"; ov.appendChild(el); el.addEventListener("animationend", () => el.remove(), { once: true }); }

/* STATS — Viewer (inbound) */
let cumulativeBytes = 0;
/* STATS — Viewer (inbound) */
function startStats(pc) {
  if (!pc) return; startTime = Date.now(); prevBytesStat = 0; cumulativeBytes = 0;
  const iv = isMobile ? 3000 : 2000;
  statsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let inb = null, pair = null, codecId = null, jitter = 0;
      stats.forEach(r => {
        if (r.type === "inbound-rtp" && r.kind === "video") { inb = r; codecId = r.codecId; jitter = r.jitter || 0; }
        if (r.type === "candidate-pair" && r.state === "succeeded" && !pair) pair = r;
      });
      let codecName = "Auto";
      if (codecId) {
        const codecStat = stats.get(codecId);
        if (codecStat) codecName = codecStat.mimeType.split('/')[1] || "Auto";
      }

      if (inb) {
        const b = inb.bytesReceived || 0; cumulativeBytes = b;
        const br = ((b - prevBytesStat) * 8 / (iv / 1000) / 1_000_000).toFixed(1); prevBytesStat = b;
        const e = id => document.getElementById(id);
        if (e("statBitrate")) e("statBitrate").innerHTML = `${br}<span class="stat-unit"> Mbps</span>`;
        if (e("barBitrate")) e("barBitrate").style.width = Math.min(br / 12 * 100, 100) + "%";
        if (e("statFps")) e("statFps").textContent = Math.round(inb.framesPerSecond || 0);
        if (e("statRes")) e("statRes").textContent = `${inb.frameWidth || 0}×${inb.frameHeight || 0}`;
        if (e("statCodec")) e("statCodec").textContent = codecName;
        const lossNum = ((inb.packetsLost || 0) / Math.max(inb.packetsReceived || 1, 1) * 100); const loss = lossNum.toFixed(1);
        if (e("statLoss")) e("statLoss").textContent = `${loss}%`;
        const tag = e("qualityTag"); if (tag) { tag.style.display = ""; const h = inb.frameHeight || 0; tag.textContent = h >= 1080 ? "1080p" : h >= 720 ? "720p" : `${h}p`; }
        if (!pair && document.getElementById("statRtt")) document.getElementById("statRtt").innerHTML = `~${Math.round(jitter * 1000)}<span class="stat-unit"> ms</span>`;
      }
      if (pair && document.getElementById("statRtt")) document.getElementById("statRtt").innerHTML = `${Math.round((pair.currentRoundTripTime || 0) * 1000)}<span class="stat-unit"> ms</span>`;
    } catch (_) { }
  }, iv);
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mbs = (cumulativeBytes / 1_000_000).toFixed(1);
    const bt = mbs > 1000 ? `${(mbs / 1000).toFixed(2)} GB` : `${mbs} MB`;
    const el = document.getElementById("statDuration");
    if (el) el.innerHTML = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} <span style="font-size:10px;color:rgba(6,182,212,0.8);margin-left:6px;font-weight:bold;">⤓ ${bt}</span>`;
  }, 1000);
}

/* STATS — Host (outbound) */
function startHostStats() {
  startTime = Date.now(); prevBytesStat = 0; cumulativeBytes = 0; const iv = 2000;
  statsInterval = setInterval(async () => { const pcs = Object.values(screenPcMap).filter(p => p.connectionState === "connected"); if (!pcs.length) return; try { const pc = pcs[0]; const stats = await pc.getStats(); let out = null, rin = null, pair = null, codecId = null; stats.forEach(r => { if (r.type === "outbound-rtp" && r.kind === "video") { out = r; codecId = r.codecId; } if (r.type === "remote-inbound-rtp" && r.kind === "video") rin = r; if (r.type === "candidate-pair" && r.state === "succeeded" && !pair) pair = r; }); let codecName = "Auto"; if (codecId) { const cStat = stats.get(codecId); if (cStat) codecName = cStat.mimeType.split('/')[1] || "Auto"; } if (out) { const b = out.bytesSent || 0; cumulativeBytes = b; const br = ((b - prevBytesStat) * 8 / (iv / 1000) / 1_000_000).toFixed(1); prevBytesStat = b; const e = id => document.getElementById(id); if (e("statBitrate")) e("statBitrate").innerHTML = `${br}<span class="stat-unit"> Mbps</span>`; if (e("barBitrate")) e("barBitrate").style.width = Math.min(br / 12 * 100, 100) + "%"; if (e("statFps")) e("statFps").textContent = Math.round(out.framesPerSecond || 0); if (e("statRes")) e("statRes").textContent = `${out.frameWidth || 0}×${out.frameHeight || 0}`; const qlr = out.qualityLimitationReason; if (e("statCodec")) e("statCodec").textContent = qlr && qlr !== "none" ? `⚠️ ${qlr} (Codec: ${codecName})` : codecName; if (rin) { const loss = ((rin.packetsLost || 0) / Math.max(out.packetsSent || 1, 1) * 100).toFixed(1); if (e("statLoss")) e("statLoss").textContent = `${loss}%`; } const tag = e("qualityTag"); if (tag) { tag.style.display = ""; const h = out.frameHeight || 0; tag.textContent = h >= 1080 ? "1080p" : h >= 720 ? "720p" : `${h}p`; } } if (pair && document.getElementById("statRtt")) document.getElementById("statRtt").innerHTML = `${Math.round((pair.currentRoundTripTime || 0) * 1000)}<span class="stat-unit"> ms</span>`; } catch (_) { } }, iv);
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mbs = (cumulativeBytes / 1_000_000).toFixed(1);
    const bt = mbs > 1000 ? `${(mbs / 1000).toFixed(2)} GB` : `${mbs} MB`;
    const el = document.getElementById("statDuration");
    if (el) el.innerHTML = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} <span style="font-size:10px;color:rgba(16,185,129,0.8);margin-left:6px;font-weight:bold;">↑ ${bt}</span>`;
  }, 1000);
}

function stopStats() { clearInterval(statsInterval); clearInterval(timerInterval); }
window.generateRoom = () => { const c = Math.random().toString(36).substr(2, 6).toUpperCase(); const el = document.getElementById("roomId"); if (el) el.value = c; showToast("🎲 Room code generated"); };

let voiceNegotiationMutex = false;
async function pullVoiceTracks(sessionId, trackName, pc) {
  if (!cfApp || !pc) return;
  while (voiceNegotiationMutex) await new Promise(r => setTimeout(r, 100)); // basic queue
  voiceNegotiationMutex = true;
  try {
    logStatus(`Pulling voice track ${trackName}...`);
    const newRemoteTracksResult = await cfApp.newTracks([{ location: "remote", sessionId, trackName }]);
    if (newRemoteTracksResult.requiresImmediateRenegotiation) {
      switch (newRemoteTracksResult.sessionDescription.type) {
        case 'offer':
          await pc.setRemoteDescription(new RTCSessionDescription(newRemoteTracksResult.sessionDescription));
          await pc.setLocalDescription(await pc.createAnswer());
          await cfApp.sendAnswerSDP(pc.localDescription.sdp);
          break;
      }
    }
  } catch (e) { logStatus(`Voice Pull error: ${e.message}`); }
  finally { voiceNegotiationMutex = false; }
}

/* VOICE CHAT (CLOUDFLARE SFU) */
window.toggleVoiceChat = async () => {
  if (!roomId) return showToast("⚠️ Join a room first");
  const micBtnMain = document.getElementById("micBtnMain"), micBtnChat = document.getElementById("micBtnChat");
  const micIconMain = document.getElementById("micIconMain"), micIconChat = document.getElementById("micIconChat");

  if (myVoiceStream) {
    myVoiceStream.getTracks().forEach(t => t.stop()); myVoiceStream = null;
    if (micBtnMain) { micBtnMain.style.background = "var(--red)"; micIconMain.textContent = "mic_off"; }
    if (micIconChat) { micIconChat.textContent = "mic_off"; micIconChat.style.color = "var(--red)"; }
    showToast("🔇 Mic OFF");
    remove(ref(db, `rooms/${roomId}/voice/${window._myVid || "host"}`));
    return;
  }

  try {
    myVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true }); // getMicConstraints normally, simplify for tests
    if (micBtnMain) { micBtnMain.style.background = "var(--accent)"; micIconMain.textContent = "mic"; }
    if (micIconChat) { micIconChat.textContent = "mic"; micIconChat.style.color = "var(--accent)"; }
    showToast("🎤 Mic ON");

    // 1. Identify active session
    const myVid = isHost ? "host" : (window._myVid || "v_" + Math.random().toString(36).substr(2, 5));
    window._myVid = myVid;

    const pc = isHost ? screenPcMap["host_cf"] : viewerPc;
    if (!pc || !cfApp) {
      showToast("⚠️ Cloudflare connection not ready for Voice.");
      return;
    }

    // 2. Publish to SFU
    logStatus("Publishing Voice track to Cloudflare SFU...");
    const audioTrack = myVoiceStream.getAudioTracks()[0];
    const trans = pc.addTransceiver(audioTrack, { direction: "sendonly" });

    await pc.setLocalDescription(await pc.createOffer());
    const publishRes = await cfApp.newTracks([{ location: "local", mid: trans.mid, trackName: audioTrack.id }], pc.localDescription.sdp);
    await pc.setRemoteDescription(new RTCSessionDescription(publishRes.sessionDescription));
    logStatus("Voice Track successfully published via Edge.");

    // 3. Announce track ID universally so others can pull it
    set(ref(db, `rooms/${roomId}/voice/${myVid}`), {
      name: myName, active: true, ts: Date.now(),
      cfSessionId: cfApp.sessionId, trackName: audioTrack.id
    });
    onDisconnect(ref(db, `rooms/${roomId}/voice/${myVid}`)).remove();

    // The listener for pulling others' voice tracks should be in join flows!

  } catch (e) { console.error(e); logStatus(`Voice Chat Error: ${e.message}`); showToast("❌ Mic Access or Network Denied"); }
};

/* PiP — auto on visibility change */
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) return;
  const video = document.getElementById("remoteVideo");
  if (!video?.srcObject) return;
  if (document.pictureInPictureEnabled && !document.pictureInPictureElement) { try { await video.requestPictureInPicture(); } catch (_) { } }
});
document.getElementById("remoteVideo")?.addEventListener("enterpictureinpicture", () => { const v = document.getElementById("remoteVideo"), a = document.getElementById("bgAudio"); if (v) v.muted = false; if (a) a.muted = true; });
document.getElementById("remoteVideo")?.addEventListener("leavepictureinpicture", () => { const v = document.getElementById("remoteVideo"), a = document.getElementById("bgAudio"); if (v) v.muted = true; if (a) a.muted = false; });

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { }));