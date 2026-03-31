/* ═══════════════════════════════════════════════════════
   LIVE PARTY — WATCH TOGETHER v3.1
   Architecture:
   • PC #1: Screen Share (1-to-Many, Host → Viewers, HD audio)
   • PC #2: Face Cam Mesh (All-to-All, video only, no audio)
   • Chat + Emoji: Firebase Realtime Database
   ═══════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, onChildAdded, remove }
  from "https://www.gstatic.com/firebasejs/11.5.0/firebase-database.js";

/* ── FIREBASE ── */
const firebaseConfig = {
  apiKey: "AIzaSyC9DF_8rB0VGJkh0JmI4veH-bCPjVsqP1E",
  authDomain: "webrtc-d0526.firebaseapp.com",
  databaseURL: "https://webrtc-d0526-default-rtdb.firebaseio.com",
  projectId: "webrtc-d0526",
  storageBucket: "webrtc-d0526.firebasestorage.app",
  messagingSenderId: "1086279997400",
  appId: "1:1086279997400:web:7a0c2e0e42b0bb777a91ff"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ── ICE / TURN ── */
const servers = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ]
};

const RES_MAP = {
  "4k":    { width: 3840, height: 2160 },
  "2k":    { width: 2560, height: 1440 },
  "1080p": { width: 1920, height: 1080 },
  "720p":  { width: 1280, height: 720 },
  "480p":  { width: 854,  height: 480 },
  "360p":  { width: 640,  height: 360 }
};

/* ── STATE ── */
let localStream = null;      // host screen share
let localCamStream = null;   // face cam (video only)
let roomId = "";
let isHost = false;
let isStreaming = false;
let camEnabled = true;

// Face cam mesh
let myPeerId = null;
let camPcMap = {};     // peerId → { pc, peerName }
let camStreams = {};    // peerId → MediaStream
let pinnedPeer = null;

// Screen share (host side)
let screenPcMap = {};  // viewerId → RTCPeerConnection
// Screen share (viewer side)
let viewerPc = null;

// Stats
let statsInterval = null;
let timerInterval = null;
let startTime = 0;
let prevBytesReceived = 0;
let chatListenerStarted = false;

/* ═══════════════════════════════════════════════
   TOAST UTIL
   ═══════════════════════════════════════════════ */
function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
}

/* ═══════════════════════════════════════════════
   CONNECTION STATUS
   ═══════════════════════════════════════════════ */
function updateConnStatus(state) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  if (!dot || !label) return;
  dot.className = "dot";
  if (state === "connected") {
    dot.classList.add("connected");
    label.textContent = "CONNECTED";
  } else if (state === "connecting") {
    dot.classList.add("connecting");
    label.textContent = "CONNECTING...";
  } else {
    label.textContent = "DISCONNECTED";
  }
}

/* ═══════════════════════════════════════════════
   CAPTURE SCREEN (Host only)
   ═══════════════════════════════════════════════ */
async function captureScreen() {
  const res = document.getElementById("scrRes")?.value || "1080p";
  const { width, height } = RES_MAP[res] || RES_MAP["1080p"];

  localStream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
    audio: {
      channelCount: 2, sampleRate: 48000,
      autoGainControl: false, echoCancellation: false, noiseSuppression: false
    }
  });

  const video = document.getElementById("remoteVideo");
  video.srcObject = localStream;
  video.muted = true;

  // BG audio for mobile lock screen
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length > 0) {
    const bgAudio = document.getElementById("bgAudio");
    bgAudio.srcObject = new MediaStream(audioTracks);
    bgAudio.play().catch(() => {});
  }

  // Detect screen share stop
  localStream.getVideoTracks()[0].onended = () => window.leaveCall();
  return localStream;
}

/* ═══════════════════════════════════════════════
   CAPTURE FACE CAM (Video only, no mic)
   ═══════════════════════════════════════════════ */
async function captureFaceCam() {
  const qual = document.getElementById("camQuality")?.value || "480p";
  const { width, height } = RES_MAP[qual] || RES_MAP["480p"];
  try {
    localCamStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 24 }, facingMode: "user" }
    });
  } catch (e) {
    console.warn("Camera not available:", e.message);
    localCamStream = new MediaStream();
    showToast("📷 Camera not available");
  }
  return localCamStream;
}

/* ═══════════════════════════════════════════════
   SCREEN SHARE PEER (PC #1) — Host side
   ═══════════════════════════════════════════════ */
function createHostScreenPC(viewerId) {
  const pc = new RTCPeerConnection(servers);
  screenPcMap[viewerId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      const mbps = parseFloat(document.getElementById("bitrateSlider")?.value || "4");
      applyBitratePerPC(pc, mbps);
    }
    if (["failed", "closed"].includes(pc.connectionState)) {
      delete screenPcMap[viewerId];
    }
  };

  return pc;
}

async function applyBitratePerPC(pc, mbps) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = mbps * 1_000_000;
    try { await sender.setParameters(params); } catch (_) {}
  }
}

/* ═══════════════════════════════════════════════
   FACE CAM MESH (PC #2) — All-to-All, VIDEO ONLY
   ═══════════════════════════════════════════════ */
function getPairKey(a, b) { return [a, b].sort().join("__"); }

async function createCamConnection(peerId, peerName, isOfferer) {
  const pairKey = getPairKey(myPeerId, peerId);
  const pc = new RTCPeerConnection(servers);
  camPcMap[peerId] = { pc, peerName };

  // Add only VIDEO tracks
  if (localCamStream) {
    localCamStream.getVideoTracks().forEach(t => pc.addTrack(t, localCamStream));
  }

  // Receive remote video
  const remoteStream = new MediaStream();
  camStreams[peerId] = remoteStream;

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });
    addRemoteCamTile(peerId, peerName, remoteStream);
  };

  // ICE candidates
  const myIcePath = isOfferer
    ? `rooms/${roomId}/camLinks/${pairKey}/offerCandidates`
    : `rooms/${roomId}/camLinks/${pairKey}/answerCandidates`;

  pc.onicecandidate = (e) => {
    if (e.candidate) push(ref(db, myIcePath), e.candidate.toJSON());
  };

  pc.oniceconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
      cleanupCamPeer(peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      showToast(`📹 ${peerName} joined`);
    }
  };

  // Signaling
  if (isOfferer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/camLinks/${pairKey}/offer`), {
      type: offer.type, sdp: offer.sdp
    });

    onValue(ref(db, `rooms/${roomId}/camLinks/${pairKey}/answer`), async (snap) => {
      if (!snap.val() || pc.signalingState === "stable") return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(snap.val())); }
      catch (e) { console.warn("[Cam] setRemoteDesc:", e); }
    });

    onChildAdded(ref(db, `rooms/${roomId}/camLinks/${pairKey}/answerCandidates`), async (cs) => {
      try { await pc.addIceCandidate(new RTCIceCandidate(cs.val())); } catch (_) {}
    });
  } else {
    onValue(ref(db, `rooms/${roomId}/camLinks/${pairKey}/offer`), async (snap) => {
      if (!snap.val() || pc.signalingState !== "stable") return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(db, `rooms/${roomId}/camLinks/${pairKey}/answer`), {
          type: answer.type, sdp: answer.sdp
        });
      } catch (e) { console.warn("[Cam] answer:", e); }
    });

    onChildAdded(ref(db, `rooms/${roomId}/camLinks/${pairKey}/offerCandidates`), async (cs) => {
      try { await pc.addIceCandidate(new RTCIceCandidate(cs.val())); } catch (_) {}
    });
  }

  updateCamCount();
}

function cleanupCamPeer(peerId) {
  const entry = camPcMap[peerId];
  if (!entry) return;
  try { entry.pc.close(); } catch (_) {}
  delete camPcMap[peerId];
  delete camStreams[peerId];
  if (pinnedPeer === peerId) pinnedPeer = null;
  const tile = document.getElementById(`cam_${peerId}`);
  if (tile) { tile.style.opacity = '0'; tile.style.transform = 'scale(0.8)'; setTimeout(() => tile.remove(), 300); }
  updateCamCount();
}

/* ═══════════════════════════════════════════════
   CAM TILE UI
   ═══════════════════════════════════════════════ */
function addLocalCamTile() {
  const grid = document.getElementById("camGrid");
  if (!grid || document.getElementById("cam_local")) return;
  const tile = createCamTile("local", "You", localCamStream, true);
  grid.prepend(tile);
  document.getElementById("camPanel").classList.add("active");
  document.getElementById("btnCam").style.display = "flex";
  updateCamCount();
}

function addRemoteCamTile(peerId, name, stream) {
  const grid = document.getElementById("camGrid");
  if (!grid || document.getElementById(`cam_${peerId}`)) return;
  grid.appendChild(createCamTile(peerId, name, stream, false));
  updateCamCount();
}

function createCamTile(id, name, stream, isLocal) {
  const tile = document.createElement("div");
  tile.className = "cam-tile";
  tile.id = `cam_${id}`;
  tile.style.animation = "slideUp 0.35s ease";

  if (stream && stream.getVideoTracks().length > 0) {
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.srcObject = stream;
    if (isLocal) video.style.transform = "scaleX(-1)";
    tile.appendChild(video);
  } else {
    const av = document.createElement("div");
    av.className = "tile-avatar";
    av.textContent = name.charAt(0).toUpperCase();
    tile.appendChild(av);
  }

  const label = document.createElement("span");
  label.className = "tile-label";
  label.textContent = isLocal ? "You" : name;
  tile.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "tile-actions";

  const pinBtn = document.createElement("button");
  pinBtn.className = "tile-action-btn";
  pinBtn.innerHTML = '<span class="material-symbols-outlined">push_pin</span>';
  pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(id); };
  actions.appendChild(pinBtn);

  if (!isLocal) {
    const fsBtn = document.createElement("button");
    fsBtn.className = "tile-action-btn";
    fsBtn.innerHTML = '<span class="material-symbols-outlined">open_in_full</span>';
    fsBtn.onclick = (e) => { e.stopPropagation(); window.openTileFullscreen(id, name, stream); };
    actions.appendChild(fsBtn);
    tile.ondblclick = () => window.openTileFullscreen(id, name, stream);
  }

  tile.appendChild(actions);
  makeDraggable(tile);
  return tile;
}

function togglePin(id) {
  const grid = document.getElementById("camGrid");
  if (pinnedPeer === id) {
    pinnedPeer = null;
    grid.querySelectorAll(".cam-tile").forEach(t => t.classList.remove("pinned"));
    showToast("📌 Unpinned");
  } else {
    pinnedPeer = id;
    grid.querySelectorAll(".cam-tile").forEach(t => t.classList.remove("pinned"));
    const tile = document.getElementById(`cam_${id}`);
    if (tile) { tile.classList.add("pinned"); grid.prepend(tile); }
    showToast("📌 Pinned");
  }
  updateCamCount();
}

function makeDraggable(el) {
  let isDragging = false, startX, startY;
  const start = (e) => {
    if (e.target.closest('.tile-action-btn')) return;
    isDragging = false;
    const t = e.touches?.[0] || e;
    startX = t.clientX; startY = t.clientY;
    const move = (ev) => {
      const p = ev.touches?.[0] || ev;
      const dx = p.clientX - startX, dy = p.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        isDragging = true;
        el.style.position = "relative";
        el.style.left = dx + "px"; el.style.top = dy + "px"; el.style.zIndex = "10";
      }
    };
    const end = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      if (!isDragging) return;
      el.style.transition = "all 0.3s ease";
      el.style.left = "0"; el.style.top = "0"; el.style.zIndex = "";
      setTimeout(() => el.style.transition = "", 300);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
  };
  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: false });
}

function updateCamCount() {
  const grid = document.getElementById("camGrid");
  if (grid) grid.setAttribute("data-count", Math.min(grid.children.length, 5));
}

/* ═══════════════════════════════════════════════
   JOIN CAM MESH (called after host/join)
   ═══════════════════════════════════════════════ */
async function joinCamMesh() {
  await captureFaceCam();
  addLocalCamTile();

  myPeerId = "cp_" + Math.random().toString(36).substr(2, 9);
  const myName = document.getElementById("userName")?.value.trim() || "User_" + Math.floor(Math.random()*1000);

  await set(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`), {
    name: myName, joined: Date.now()
  });

  window.addEventListener("beforeunload", () => {
    remove(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`));
  });

  onChildAdded(ref(db, `rooms/${roomId}/camMembers`), async (snap) => {
    const peerId = snap.key;
    if (peerId === myPeerId || camPcMap[peerId]) return;
    const peerData = snap.val();
    const peerName = peerData?.name || "User";
    const isOfferer = myPeerId < peerId;
    if (isOfferer) {
      await createCamConnection(peerId, peerName, true);
    } else {
      setTimeout(() => createCamConnection(peerId, peerName, false), 500);
    }
  });
}

/* ═══════════════════════════════════════════════
   TOGGLE CAMERA
   ═══════════════════════════════════════════════ */
window.toggleCam = () => {
  if (!localCamStream) return;
  const tracks = localCamStream.getVideoTracks();
  if (!tracks.length) return;
  camEnabled = !camEnabled;
  tracks.forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById("btnCam");
  const icon = btn?.querySelector(".material-symbols-outlined");
  if (camEnabled) { btn?.classList.remove("off"); if (icon) icon.textContent = "videocam"; }
  else { btn?.classList.add("off"); if (icon) icon.textContent = "videocam_off"; }
};

/* ═══════════════════════════════════════════════
   EMOJI REACTIONS
   ═══════════════════════════════════════════════ */
window.sendReaction = (emoji) => {
  if (!roomId) return showToast("⚠️ Connect first");
  const name = document.getElementById("userName")?.value.trim() || "User";
  push(ref(db, `rooms/${roomId}/reactions`), { emoji, sender: name, time: Date.now() });
  showEmojiFloat(emoji);
};

function showEmojiFloat(emoji) {
  const overlay = document.getElementById("emojiOverlay");
  if (!overlay) return;
  const el = document.createElement("div");
  el.className = "emoji-float";
  el.textContent = emoji;
  el.style.left = (25 + Math.random() * 50) + "%";
  overlay.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

function startReactionListener() {
  if (!roomId) return;
  const ts = Date.now();
  onChildAdded(ref(db, `rooms/${roomId}/reactions`), (snap) => {
    const d = snap.val();
    if (!d || d.time < ts) return;
    showEmojiFloat(d.emoji);
  });
}

/* ═══════════════════════════════════════════════
   CHAT
   ═══════════════════════════════════════════════ */
window.sendChat = () => {
  const input = document.getElementById("chatInput");
  const msg = input?.value.trim();
  if (!msg || !roomId) return;
  const name = document.getElementById("userName")?.value.trim() || "User";
  push(ref(db, `rooms/${roomId}/chat`), { sender: name, text: msg, time: Date.now() });
  input.value = "";
};

function startChatListener() {
  if (chatListenerStarted || !roomId) return;
  chatListenerStarted = true;
  const ts = Date.now();
  const myName = document.getElementById("userName")?.value.trim() || "User";

  onChildAdded(ref(db, `rooms/${roomId}/chat`), (snap) => {
    const d = snap.val();
    if (!d) return;
    const container = document.getElementById("chatMessages");
    if (!container) return;
    const isMe = d.sender === myName && d.time >= ts - 2000;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg";
    const hdr = document.createElement("div");
    hdr.className = "chat-msg-header";
    const snd = document.createElement("span");
    snd.className = "chat-sender";
    snd.style.color = isMe ? "var(--accent)" : "var(--cyan)";
    snd.textContent = isMe ? "You" : d.sender;
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = new Date(d.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    hdr.appendChild(snd); hdr.appendChild(time);
    const bub = document.createElement("div");
    bub.className = `chat-bubble ${isMe ? "me" : "other"}`;
    bub.textContent = d.text;
    wrap.appendChild(hdr); wrap.appendChild(bub);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  });
}

/* ═══════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════ */
function startStats(pc) {
  if (!pc) return;
  startTime = Date.now();
  prevBytesReceived = 0;

  statsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let inbound = null, pair = null;
      stats.forEach(r => {
        if (r.type === "inbound-rtp" && r.kind === "video") inbound = r;
        if (r.type === "candidate-pair" && r.nominated) pair = r;
      });
      if (inbound) {
        const bytes = inbound.bytesReceived || 0;
        const bitrate = ((bytes - prevBytesReceived) * 8 / 1_000_000).toFixed(1);
        prevBytesReceived = bytes;
        const el = (id) => document.getElementById(id);
        el("statBitrate").innerHTML = `${bitrate}<span class="stat-unit"> Mbps</span>`;
        el("barBitrate").style.width = Math.min(bitrate / 12 * 100, 100) + "%";
        el("statFps").textContent = Math.round(inbound.framesPerSecond || 0);
        el("statRes").textContent = `${inbound.frameWidth||'—'}×${inbound.frameHeight||'—'}`;
        el("statLoss").textContent = `${((inbound.packetsLost||0)/Math.max(inbound.packetsReceived||1,1)*100).toFixed(1)}%`;
        el("qualitySummary").innerHTML =
          `Res: ${inbound.frameWidth||'—'}×${inbound.frameHeight||'—'}<br>FPS: ${Math.round(inbound.framesPerSecond||0)}<br>Bitrate: ${bitrate} Mbps`;
        const tag = el("qualityTag");
        if (tag) { tag.style.display = ""; tag.textContent = inbound.frameHeight >= 1080 ? "1080p" : inbound.frameHeight >= 720 ? "720p" : `${inbound.frameHeight||'—'}p`; }
      }
      if (pair) {
        const rtt = Math.round((pair.currentRoundTripTime || 0) * 1000);
        document.getElementById("statRtt").innerHTML = `${rtt}<span class="stat-unit"> ms</span>`;
      }
    } catch (_) {}
  }, 1000);

  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    document.getElementById("statDuration").textContent =
      `${Math.floor(s/3600).toString().padStart(2,'0')}:${Math.floor((s%3600)/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
  }, 1000);
}

function stopStats() { clearInterval(statsInterval); clearInterval(timerInterval); }

/* ═══════════════════════════════════════════════
   ROOM CODE GENERATOR
   ═══════════════════════════════════════════════ */
window.generateRoom = () => {
  const code = Math.random().toString(36).substr(2, 8).toUpperCase();
  const el = document.getElementById("roomId");
  if (el) el.value = code;
  showToast("🎲 Room: " + code);
};

/* ═══════════════════════════════════════════════
   HOST (Confirm from popup)
   ═══════════════════════════════════════════════ */
window.confirmHost = async () => {
  roomId = document.getElementById("roomId")?.value.trim();
  if (!roomId) return showToast("⚠️ Enter Room Code");
  const name = document.getElementById("userName")?.value.trim();
  if (!name) return showToast("⚠️ Enter your name");

  window.closeConnectModal();

  try { await captureScreen(); }
  catch (e) { return showToast("⚠️ Screen share cancelled"); }

  isHost = true; isStreaming = true;
  document.getElementById("noSignal")?.classList.add("hidden");
  document.getElementById("liveBadge").style.display = "flex";
  document.getElementById("sourceTag").style.display = "";
  document.getElementById("sourceTag").textContent = "HOST";
  updateConnStatus("connected");

  const btn = document.getElementById("connectBtn");
  btn.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> End';
  btn.classList.add("end");
  btn.onclick = () => window.leaveCall();

  // Save room
  await set(ref(db, `rooms/${roomId}/host`), { name, created: Date.now() });

  // Listen for viewers joining
  onChildAdded(ref(db, `rooms/${roomId}/viewers`), async snap => {
    const viewerId = snap.key;
    if (!viewerId || screenPcMap[viewerId]) return;

    const pc = createHostScreenPC(viewerId);
    const offerCands = ref(db, `rooms/${roomId}/viewers/${viewerId}/offerCandidates`);
    const answerCands = ref(db, `rooms/${roomId}/viewers/${viewerId}/answerCandidates`);

    pc.onicecandidate = e => { if (e.candidate) push(offerCands, e.candidate.toJSON()); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/viewers/${viewerId}/offer`), { type: offer.type, sdp: offer.sdp });

    onValue(ref(db, `rooms/${roomId}/viewers/${viewerId}/answer`), async aSnap => {
      if (!aSnap.val() || pc.remoteDescription) return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(aSnap.val())); } catch (_) {}
    });

    onChildAdded(answerCands, async cSnap => {
      try { await pc.addIceCandidate(new RTCIceCandidate(cSnap.val())); } catch (_) {}
    });
  });

  startChatListener();
  startReactionListener();
  await joinCamMesh();
  showToast("🎬 Live! Room: " + roomId);
};

/* ═══════════════════════════════════════════════
   JOIN (Confirm from popup)
   ═══════════════════════════════════════════════ */
window.confirmJoin = async () => {
  roomId = document.getElementById("roomId")?.value.trim();
  if (!roomId) return showToast("⚠️ Enter Room Code");
  const name = document.getElementById("userName")?.value.trim();
  if (!name) return showToast("⚠️ Enter your name");

  window.closeConnectModal();
  isHost = false;
  updateConnStatus("connecting");
  document.getElementById("noSignal")?.classList.add("hidden");

  const myViewerId = "v_" + Math.random().toString(36).substr(2, 9);

  // Signal ready
  await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/ready`), true);

  const video = document.getElementById("remoteVideo");
  video.muted = false;

  const pc = new RTCPeerConnection(servers);
  viewerPc = pc;
  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });
    // BG audio for mobile
    if (track => track.kind === 'audio') {
      const bgAudio = document.getElementById("bgAudio");
      bgAudio.srcObject = new MediaStream(remoteStream.getAudioTracks());
      bgAudio.play().catch(() => {});
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      updateConnStatus("connected");
      document.getElementById("noSignal")?.classList.add("hidden");
      document.getElementById("liveBadge").style.display = "flex";
      document.getElementById("sourceTag").style.display = "";
      document.getElementById("sourceTag").textContent = "VIEWER";
      const btn = document.getElementById("connectBtn");
      btn.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> End';
      btn.classList.add("end");
      btn.onclick = () => window.leaveCall();
      startStats(pc);
      showToast("🎬 Connected!");
    }
    if (pc.connectionState === "failed") {
      showToast("❌ Connection failed. Try again.");
      updateConnStatus("disconnected");
    }
  };

  const offerCands = ref(db, `rooms/${roomId}/viewers/${myViewerId}/offerCandidates`);
  const answerCands = ref(db, `rooms/${roomId}/viewers/${myViewerId}/answerCandidates`);

  pc.onicecandidate = e => { if (e.candidate) push(answerCands, e.candidate.toJSON()); };

  // Wait for host offer
  onValue(ref(db, `rooms/${roomId}/viewers/${myViewerId}/offer`), async snap => {
    if (!snap.val() || pc.remoteDescription) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));

      // Get any early ICE candidates
      const earlySnap = await get(offerCands);
      if (earlySnap.exists()) {
        for (const c of Object.values(earlySnap.val())) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
        }
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/answer`), { type: answer.type, sdp: answer.sdp });
    } catch (e) { console.error("[Join] Error:", e); }
  });

  // Ongoing ICE candidates
  onChildAdded(offerCands, async cSnap => {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(new RTCIceCandidate(cSnap.val())); } catch (_) {}
    }
  });

  startChatListener();
  startReactionListener();
  await joinCamMesh();
};

/* ═══════════════════════════════════════════════
   LEAVE CALL
   ═══════════════════════════════════════════════ */
window.leaveCall = async () => {
  stopStats();

  // Close screen PCs
  Object.values(screenPcMap).forEach(pc => { try { pc.close(); } catch (_) {} });
  screenPcMap = {};
  if (viewerPc) { try { viewerPc.close(); } catch (_) {} viewerPc = null; }

  // Close cam PCs
  Object.values(camPcMap).forEach(e => { try { e.pc.close(); } catch (_) {} });
  camPcMap = {}; camStreams = {};

  // Stop local streams
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (localCamStream) { localCamStream.getTracks().forEach(t => t.stop()); localCamStream = null; }

  // Firebase cleanup
  if (roomId && myPeerId) remove(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`));

  // Reset UI
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("noSignal")?.classList.remove("hidden");
  document.getElementById("liveBadge").style.display = "none";
  document.getElementById("sourceTag").style.display = "none";
  document.getElementById("qualityTag").style.display = "none";
  updateConnStatus("disconnected");

  const btn = document.getElementById("connectBtn");
  btn.innerHTML = '<span class="material-symbols-outlined">link</span> Connect';
  btn.classList.remove("end");
  btn.onclick = () => window.openConnectModal();

  document.getElementById("camGrid").innerHTML = "";
  document.getElementById("camPanel")?.classList.remove("active");
  document.getElementById("btnCam").style.display = "none";
  pinnedPeer = null;

  isStreaming = false; isHost = false;
  chatListenerStarted = false;
  showToast("👋 Disconnected");
};

/* ═══════════════════════════════════════════════
   MEDIA SESSION
   ═══════════════════════════════════════════════ */
if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Live Party', artist: 'Watch Together', album: 'Stream'
  });
}

/* ═══════════════════════════════════════════════
   SERVICE WORKER
   ═══════════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}