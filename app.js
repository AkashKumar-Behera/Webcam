/* ═══════════════════════════════════════════════════════
   LIVE PARTY — WATCH TOGETHER v3
   Architecture:
   • PC #1: Screen Share (1-to-Many, Host → Viewers, HD audio)
   • PC #2: Face Cam Mesh (All-to-All, video only, no audio)
   • Chat: Firebase Realtime Database
   • Emoji Reactions: Firebase + CSS animations
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

/* ── WEBRTC CONFIG ── */
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
let localStream = null;
let localCamStream = null;
let roomId = "";
let isHost = false;
let isStreaming = false;
let camEnabled = true;

// Face cam mesh
let myPeerId = null;
let camPcMap = {}; // peerId → { pc, peerName }
let camStreams = {}; // peerId → MediaStream
let pinnedPeer = null;

// Stats
let statsInterval = null;
let timerInterval = null;
let startTime = 0;
let prevBytesReceived = 0;

/* ─── TOAST ─── */
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
}

/* ─── UPDATE CONNECTION STATUS ─── */
function updateConnStatus(state) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
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
   CAPTURE SCREEN SHARE (Host Only)
   ═══════════════════════════════════════════════ */
async function captureScreen() {
  const res = document.getElementById("scrRes").value;
  const fps = parseInt(document.getElementById("scrFps").value);
  const { width, height } = RES_MAP[res];

  localStream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
    audio: {
      channelCount: 2,
      sampleRate: 48000,
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false
    }
  });

  const video = document.getElementById("remoteVideo");
  video.srcObject = localStream;
  video.muted = true;

  // Background audio for mobile
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length > 0) {
    const bgAudio = document.getElementById("bgAudio");
    bgAudio.srcObject = new MediaStream(audioTracks);
    bgAudio.play().catch(() => {});
  }

  // Stop detection
  localStream.getVideoTracks()[0].onended = () => window.leaveCall();

  return localStream;
}

/* ═══════════════════════════════════════════════
   CAPTURE FACE CAM (Video Only, No Mic)
   ═══════════════════════════════════════════════ */
async function captureFaceCam() {
  try {
    localCamStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, facingMode: "user" }
    });
    return localCamStream;
  } catch (e) {
    showToast("📷 Camera not available");
    localCamStream = new MediaStream();
    return localCamStream;
  }
}

/* ═══════════════════════════════════════════════
   SCREEN SHARE PEER CONNECTIONS (PC #1)
   1-to-Many: Host → Viewers
   ═══════════════════════════════════════════════ */
let screenPcMap = {}; // viewerId → RTCPeerConnection

function createHostScreenPC(viewerId) {
  const pc = new RTCPeerConnection(servers);
  screenPcMap[viewerId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      const mbps = parseFloat(document.getElementById("bitrateSlider").value);
      applyBitratePerPC(pc, mbps);
    }
  };

  return pc;
}

async function applyBitratePerPC(pcInstance, mbps) {
  for (const sender of pcInstance.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = mbps * 1_000_000;
    try { await sender.setParameters(params); } catch (_) {}
  }
}

async function applyBitrate(mbps) {
  Object.values(screenPcMap).forEach(pc => applyBitratePerPC(pc, mbps));
}

/* ═══════════════════════════════════════════════
   FACE CAM MESH PEER CONNECTIONS (PC #2)
   All-to-All: Everyone ↔ Everyone (VIDEO ONLY)
   ═══════════════════════════════════════════════ */

function getPairKey(id1, id2) {
  return [id1, id2].sort().join("__");
}

async function createCamConnection(peerId, peerName, isOfferer) {
  const pairKey = getPairKey(myPeerId, peerId);
  const pc = new RTCPeerConnection(servers);
  camPcMap[peerId] = { pc, peerName };

  // Add ONLY camera video tracks (NO audio)
  if (localCamStream) {
    localCamStream.getVideoTracks().forEach(track => {
      pc.addTrack(track, localCamStream);
    });
  }

  // Handle incoming remote video
  const remoteStream = new MediaStream();
  camStreams[peerId] = remoteStream;

  pc.ontrack = (e) => {
    e.streams[0].getVideoTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });
    addRemoteCamTile(peerId, peerName, remoteStream);
  };

  // ICE
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
      showToast(`📹 ${peerName} connected`);
    }
  };

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
      } catch (e) { console.warn("[Cam] offer/answer:", e); }
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
  if (entry.pc) try { entry.pc.close(); } catch (_) {}
  delete camPcMap[peerId];
  delete camStreams[peerId];
  if (pinnedPeer === peerId) pinnedPeer = null;

  const tile = document.getElementById(`cam_${peerId}`);
  if (tile) { tile.style.animation = 'fadeOut 0.3s ease'; setTimeout(() => tile.remove(), 300); }
  updateCamCount();
}

/* ═══════════════════════════════════════════════
   FACE CAM TILES (UI)
   ═══════════════════════════════════════════════ */

function addLocalCamTile() {
  const grid = document.getElementById("camGrid");
  const existing = document.getElementById("cam_local");
  if (existing) existing.remove();

  const tile = createCamTile("local", "You", localCamStream, true);
  grid.prepend(tile);

  document.getElementById("camPanel").classList.add("active");
  updateCamCount();
}

function addRemoteCamTile(peerId, name, stream) {
  const grid = document.getElementById("camGrid");
  let tile = document.getElementById(`cam_${peerId}`);
  if (tile) return; // already exists

  tile = createCamTile(peerId, name, stream, false);
  grid.appendChild(tile);
  updateCamCount();
}

function createCamTile(id, name, stream, isLocal) {
  const tile = document.createElement("div");
  tile.className = "cam-tile";
  tile.id = `cam_${id}`;
  tile.style.animation = "slideInUp 0.4s ease";

  if (stream && stream.getVideoTracks().length > 0) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    if (isLocal) video.style.transform = "scaleX(-1)";
    tile.appendChild(video);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "tile-avatar";
    avatar.textContent = name.charAt(0).toUpperCase();
    tile.appendChild(avatar);
  }

  // Name label
  const label = document.createElement("span");
  label.className = "tile-label";
  label.textContent = isLocal ? name + " (You)" : name;
  tile.appendChild(label);

  // Action buttons (pin, fullscreen)
  const actions = document.createElement("div");
  actions.className = "tile-actions";

  const pinBtn = document.createElement("button");
  pinBtn.className = "tile-action-btn";
  pinBtn.title = "Pin";
  pinBtn.innerHTML = '<span class="material-symbols-outlined">push_pin</span>';
  pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(id); };
  actions.appendChild(pinBtn);

  if (!isLocal) {
    const fsBtn = document.createElement("button");
    fsBtn.className = "tile-action-btn";
    fsBtn.title = "Expand";
    fsBtn.innerHTML = '<span class="material-symbols-outlined">open_in_full</span>';
    fsBtn.onclick = (e) => { e.stopPropagation(); window.openTileFullscreen(id, name, stream); };
    actions.appendChild(fsBtn);
  }

  tile.appendChild(actions);

  // Double-click to expand
  if (!isLocal) {
    tile.ondblclick = () => window.openTileFullscreen(id, name, stream);
  }

  // Drag support
  makeDraggable(tile);

  return tile;
}

function togglePin(id) {
  const grid = document.getElementById("camGrid");
  const tiles = grid.querySelectorAll(".cam-tile");

  if (pinnedPeer === id) {
    pinnedPeer = null;
    tiles.forEach(t => t.classList.remove("pinned"));
    showToast("📌 Unpinned");
  } else {
    pinnedPeer = id;
    tiles.forEach(t => t.classList.remove("pinned"));
    const tile = document.getElementById(`cam_${id}`);
    if (tile) {
      tile.classList.add("pinned");
      grid.prepend(tile); // Move to top
    }
    showToast("📌 Pinned");
  }
  updateCamCount();
}

function makeDraggable(el) {
  let isDragging = false;
  let startX, startY, origX, origY;

  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: false });

  function start(e) {
    if (e.target.closest('.tile-action-btn')) return;
    isDragging = false;
    const touch = e.touches?.[0] || e;
    startX = touch.clientX;
    startY = touch.clientY;
    origX = el.offsetLeft;
    origY = el.offsetTop;

    const moveHandler = (ev) => {
      const t = ev.touches?.[0] || ev;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        isDragging = true;
        el.style.position = "relative";
        el.style.left = dx + "px";
        el.style.top = dy + "px";
        el.style.zIndex = "10";
      }
    };

    const endHandler = () => {
      document.removeEventListener("mousemove", moveHandler);
      document.removeEventListener("mouseup", endHandler);
      document.removeEventListener("touchmove", moveHandler);
      document.removeEventListener("touchend", endHandler);
      if (!isDragging) return;
      // Snap back
      el.style.transition = "all 0.3s ease";
      el.style.left = "0";
      el.style.top = "0";
      el.style.zIndex = "";
      setTimeout(() => el.style.transition = "", 300);
    };

    document.addEventListener("mousemove", moveHandler);
    document.addEventListener("mouseup", endHandler);
    document.addEventListener("touchmove", moveHandler, { passive: false });
    document.addEventListener("touchend", endHandler);
  }
}

function updateCamCount() {
  const grid = document.getElementById("camGrid");
  const count = grid.children.length;
  grid.setAttribute("data-count", Math.min(count, 5));
}

/* ═══════════════════════════════════════════════
   FACE CAM MESH JOIN
   ═══════════════════════════════════════════════ */
async function joinCamMesh() {
  await captureFaceCam();
  addLocalCamTile();

  myPeerId = "cp_" + Math.random().toString(36).substr(2, 9);
  const myName = document.getElementById("userName").value.trim() || "User_" + Math.floor(Math.random() * 1000);

  await set(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`), {
    name: myName, joined: Date.now()
  });

  // Remove on disconnect
  window.addEventListener("beforeunload", () => {
    remove(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`));
  });

  // Listen for other members
  onChildAdded(ref(db, `rooms/${roomId}/camMembers`), async (snap) => {
    const peerId = snap.key;
    if (peerId === myPeerId || camPcMap[peerId]) return;

    const peerData = snap.val();
    const peerName = peerData.name || "User";
    const isOfferer = myPeerId < peerId;

    if (isOfferer) {
      await createCamConnection(peerId, peerName, true);
    } else {
      setTimeout(() => createCamConnection(peerId, peerName, false), 500);
    }
  });

  // Show cam toggle button
  document.getElementById("btnCam").style.display = "flex";
  showToast("📹 Face cam active!");
}

/* ═══════════════════════════════════════════════
   TOGGLE CAMERA
   ═══════════════════════════════════════════════ */
window.toggleCam = () => {
  if (!localCamStream) return;
  const tracks = localCamStream.getVideoTracks();
  if (!tracks.length) return showToast("📷 No camera");

  camEnabled = !camEnabled;
  tracks.forEach(t => t.enabled = camEnabled);

  const btn = document.getElementById("btnCam");
  const icon = btn.querySelector(".material-symbols-outlined");
  if (camEnabled) {
    btn.classList.remove("off");
    icon.textContent = "videocam";
  } else {
    btn.classList.add("off");
    icon.textContent = "videocam_off";
  }

  // Update local tile
  const localTile = document.getElementById("cam_local");
  if (localTile) {
    const video = localTile.querySelector("video");
    if (video) video.style.display = camEnabled ? "" : "none";
    let avatar = localTile.querySelector(".tile-avatar");
    if (!camEnabled && !avatar) {
      avatar = document.createElement("div");
      avatar.className = "tile-avatar";
      const name = document.getElementById("userName").value.trim() || "You";
      avatar.textContent = name.charAt(0).toUpperCase();
      localTile.insertBefore(avatar, localTile.firstChild);
    }
    if (avatar) avatar.style.display = camEnabled ? "none" : "";
  }
};

/* ═══════════════════════════════════════════════
   EMOJI REACTIONS — Google Meet Style
   ═══════════════════════════════════════════════ */
window.sendReaction = (emoji) => {
  if (!roomId) return;
  const name = document.getElementById("userName").value.trim() || "User";
  push(ref(db, `rooms/${roomId}/reactions`), {
    emoji, sender: name, time: Date.now()
  });
  // Show locally immediately
  showEmojiFloat(emoji);
};

function showEmojiFloat(emoji) {
  const overlay = document.getElementById("emojiOverlay");
  const el = document.createElement("div");
  el.className = "emoji-float";
  el.textContent = emoji;
  el.style.left = (30 + Math.random() * 40) + "%";
  overlay.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

function startReactionListener() {
  if (!roomId) return;
  const startTs = Date.now();
  onChildAdded(ref(db, `rooms/${roomId}/reactions`), (snap) => {
    const data = snap.val();
    if (!data || data.time < startTs) return; // Skip old
    showEmojiFloat(data.emoji);
  });
}

/* ═══════════════════════════════════════════════
   CHAT — Live Messages
   ═══════════════════════════════════════════════ */
let chatListenerStarted = false;

window.sendChat = () => {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg || !roomId) return;

  const name = document.getElementById("userName").value.trim() || "User";
  push(ref(db, `rooms/${roomId}/chat`), {
    sender: name, text: msg, time: Date.now()
  });
  input.value = "";
};

function startChatListener() {
  if (chatListenerStarted || !roomId) return;
  chatListenerStarted = true;
  const startTs = Date.now();
  const myName = document.getElementById("userName").value.trim() || "User";

  onChildAdded(ref(db, `rooms/${roomId}/chat`), (snap) => {
    const data = snap.val();
    if (!data) return;

    const container = document.getElementById("chatMessages");
    const isMe = data.sender === myName && data.time >= startTs - 2000;

    const wrapper = document.createElement("div");
    wrapper.className = "chat-msg";

    const header = document.createElement("div");
    header.className = "chat-msg-header";
    const sender = document.createElement("span");
    sender.className = "chat-sender";
    sender.style.color = isMe ? "var(--neon-purple)" : "var(--neon-cyan)";
    sender.textContent = isMe ? "You" : data.sender;
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    header.appendChild(sender);
    header.appendChild(time);

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMe ? "me" : "other"}`;
    bubble.textContent = data.text;

    wrapper.appendChild(header);
    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  });
}

/* ═══════════════════════════════════════════════
   STATS — Real-time Stream Statistics
   ═══════════════════════════════════════════════ */
function startStats() {
  const pc = Object.values(screenPcMap)[0];
  if (!pc) return;

  startTime = Date.now();
  prevBytesReceived = 0;

  statsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let inbound = null;
      let candidatePair = null;

      stats.forEach(report => {
        if (report.type === "inbound-rtp" && report.kind === "video") inbound = report;
        if (report.type === "candidate-pair" && report.nominated) candidatePair = report;
      });

      if (inbound) {
        const bytes = inbound.bytesReceived || 0;
        const elapsed = (Date.now() - startTime) / 1000;
        const bitrate = elapsed > 0 ? ((bytes - prevBytesReceived) * 8 / 1000000).toFixed(1) : 0;
        prevBytesReceived = bytes;

        document.getElementById("statBitrate").innerHTML = `${bitrate}<span class="stat-unit"> Mbps</span>`;
        document.getElementById("barBitrate").style.width = Math.min(bitrate / 12 * 100, 100) + "%";
        document.getElementById("statFps").textContent = Math.round(inbound.framesPerSecond || 0);
        document.getElementById("statRes").textContent = `${inbound.frameWidth || '—'}×${inbound.frameHeight || '—'}`;
        document.getElementById("statLoss").textContent = `${((inbound.packetsLost || 0) / Math.max(inbound.packetsReceived || 1, 1) * 100).toFixed(1)}%`;

        // Quality summary
        document.getElementById("qualitySummary").innerHTML =
          `Resolution: ${inbound.frameWidth || '—'}×${inbound.frameHeight || '—'}<br>` +
          `FPS: ${Math.round(inbound.framesPerSecond || 0)}<br>` +
          `Bitrate: ${bitrate} Mbps`;

        // Quality tag
        const tag = document.getElementById("qualityTag");
        tag.style.display = "";
        if (inbound.frameHeight >= 1080) tag.textContent = "1080p";
        else if (inbound.frameHeight >= 720) tag.textContent = "720p";
        else tag.textContent = `${inbound.frameHeight || '—'}p`;
      }

      if (candidatePair) {
        const rtt = Math.round((candidatePair.currentRoundTripTime || 0) * 1000);
        document.getElementById("statRtt").innerHTML = `${rtt}<span class="stat-unit"> ms</span>`;
      }
    } catch (_) {}
  }, 1000);

  // Duration timer
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    document.getElementById("statDuration").textContent = `${h}:${m}:${sec}`;
  }, 1000);
}

function stopStats() { clearInterval(statsInterval); clearInterval(timerInterval); }

/* ═══════════════════════════════════════════════
   ROOM CODE
   ═══════════════════════════════════════════════ */
window.generateRoom = () => {
  const code = Math.random().toString(36).substr(2, 8).toUpperCase();
  document.getElementById("roomId").value = code;
  showToast("🎲 Room: " + code);
};

/* ═══════════════════════════════════════════════
   START STREAM (HOST)
   ═══════════════════════════════════════════════ */
window.startStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return showToast("⚠️ Enter a Room Code first");

  try {
    await captureScreen();
  } catch (e) { return showToast("⚠️ Screen share cancelled"); }

  isHost = true;
  isStreaming = true;

  document.getElementById("noSignal").classList.add("hidden");
  document.getElementById("liveBadge").style.display = "flex";
  document.getElementById("sourceTag").style.display = "";
  document.getElementById("sourceTag").textContent = "HOST";
  updateConnStatus("connected");

  const goLiveBtn = document.getElementById("goLiveBtn");
  goLiveBtn.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> End';
  goLiveBtn.classList.add("end");

  // Save room metadata
  await set(ref(db, `rooms/${roomId}/host`), {
    name: document.getElementById("userName").value.trim() || "Host",
    created: Date.now()
  });

  // Listen for viewers
  onChildAdded(ref(db, `rooms/${roomId}/viewers`), async snap => {
    const viewerId = snap.key;
    if (!viewerId) return;

    const pc = createHostScreenPC(viewerId);
    const offerCandidates = ref(db, `rooms/${roomId}/viewers/${viewerId}/offerCandidates`);
    const answerCandidates = ref(db, `rooms/${roomId}/viewers/${viewerId}/answerCandidates`);

    pc.onicecandidate = e => {
      if (e.candidate) push(offerCandidates, e.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/viewers/${viewerId}/offer`), {
      type: offer.type, sdp: offer.sdp
    });

    onValue(ref(db, `rooms/${roomId}/viewers/${viewerId}/answer`), async ansSnap => {
      if (!ansSnap.val() || pc.remoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(ansSnap.val()));
    });

    onChildAdded(answerCandidates, async candSnap => {
      try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
    });
  });

  // Start chat, reactions, cam mesh
  startChatListener();
  startReactionListener();
  await joinCamMesh();

  showToast("🎬 Live! Share room code: " + roomId);
};

/* ═══════════════════════════════════════════════
   JOIN STREAM (VIEWER)
   ═══════════════════════════════════════════════ */
window.joinStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return showToast("⚠️ Enter Room Code");

  isHost = false;
  const myViewerId = "v_" + Math.random().toString(36).substr(2, 9);
  const video = document.getElementById("remoteVideo");
  video.muted = false;

  await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/ready`), true);

  const pc = new RTCPeerConnection(servers);
  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      updateConnStatus("connected");
      document.getElementById("noSignal").classList.add("hidden");
      document.getElementById("liveBadge").style.display = "flex";
      document.getElementById("sourceTag").style.display = "";
      document.getElementById("sourceTag").textContent = "VIEWER";
      startStats();
      showToast("🎬 Connected! Watching now");
    }
  };

  screenPcMap[myViewerId] = pc;

  const offerCandidates = ref(db, `rooms/${roomId}/viewers/${myViewerId}/offerCandidates`);
  const answerCandidates = ref(db, `rooms/${roomId}/viewers/${myViewerId}/answerCandidates`);

  pc.onicecandidate = e => {
    if (e.candidate) push(answerCandidates, e.candidate.toJSON());
  };

  updateConnStatus("connecting");
  document.getElementById("noSignal").classList.add("hidden");

  onValue(ref(db, `rooms/${roomId}/viewers/${myViewerId}/offer`), async snap => {
    if (!snap.val() || pc.remoteDescription) return;
    await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));

    const existingSnap = await get(offerCandidates);
    if (existingSnap.exists()) {
      for (const c of Object.values(existingSnap.val())) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/answer`), {
      type: answer.type, sdp: answer.sdp
    });
  });

  onChildAdded(offerCandidates, async candSnap => {
    try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
  });

  // Background audio support
  const audioTracks = remoteStream.getAudioTracks();
  if (audioTracks.length > 0) {
    const bgAudio = document.getElementById("bgAudio");
    bgAudio.srcObject = new MediaStream(audioTracks);
    bgAudio.play().catch(() => {});
  }

  // Start chat, reactions, cam mesh
  startChatListener();
  startReactionListener();
  await joinCamMesh();
};

/* ═══════════════════════════════════════════════
   TOGGLE STREAM / LEAVE CALL
   ═══════════════════════════════════════════════ */
window.toggleStream = async () => {
  if (!isStreaming) await window.startStream();
  else await window.leaveCall();
};

window.leaveCall = async () => {
  stopStats();

  // Close screen share PCs
  Object.values(screenPcMap).forEach(p => {
    const pc = p.close ? p : p; // might be raw PC
    try { pc.close(); } catch (_) {}
  });
  screenPcMap = {};

  // Close cam PCs
  Object.values(camPcMap).forEach(entry => {
    if (entry.pc) try { entry.pc.close(); } catch (_) {}
  });
  camPcMap = {};
  camStreams = {};

  // Stop local streams
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (localCamStream) { localCamStream.getTracks().forEach(t => t.stop()); localCamStream = null; }

  // Cleanup Firebase
  if (roomId && myPeerId) {
    remove(ref(db, `rooms/${roomId}/camMembers/${myPeerId}`));
  }

  // Reset UI
  const video = document.getElementById("remoteVideo");
  video.srcObject = null;
  document.getElementById("noSignal").classList.remove("hidden");
  document.getElementById("liveBadge").style.display = "none";
  document.getElementById("sourceTag").style.display = "none";
  document.getElementById("qualityTag").style.display = "none";
  updateConnStatus("disconnected");

  const goLiveBtn = document.getElementById("goLiveBtn");
  goLiveBtn.innerHTML = '<span class="material-symbols-outlined">podcasts</span> Go Live';
  goLiveBtn.classList.remove("end");

  // Clear cam tiles
  const grid = document.getElementById("camGrid");
  grid.innerHTML = "";
  document.getElementById("camPanel").classList.remove("active");
  pinnedPeer = null;

  isStreaming = false;
  isHost = false;
  showToast("👋 Left the session");
};

/* ═══════════════════════════════════════════════
   QUALITY SETTINGS MODAL
   ═══════════════════════════════════════════════ */
window.openQualityModal = () => document.getElementById("qualityModal").classList.add("open");
window.closeQualityModal = () => document.getElementById("qualityModal").classList.remove("open");
window.applyQuality = async () => {
  const mbps = parseFloat(document.getElementById("bitrateSlider").value);
  await applyBitrate(mbps);
  showToast(`⚡ Bitrate: ${mbps} Mbps`);
  window.closeQualityModal();
};

/* ═══════════════════════════════════════════════
   MEDIA SESSION (Background Playback)
   ═══════════════════════════════════════════════ */
if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Live Party — Watch Together',
    artist: 'Streaming',
    album: 'Watch Party'
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