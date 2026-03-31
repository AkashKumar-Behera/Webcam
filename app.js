/* ═══════════════════════════════════════════════════════
   LIVE PARTY — PURE WATCH TOGETHER v4.0
   Architecture:
   • 1-to-Many Screen Share + Audio
   • Zero Face Cam (pure focus on the movie/screen)
   • Ultra-low latency optimization (playoutDelayHint)
   • Background Audio playback for Mobile
   ═══════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, onChildAdded, remove, onDisconnect }
  from "https://www.gstatic.com/firebasejs/11.5.0/firebase-database.js";

/* ── FIREBASE ── */
const firebaseConfig = {
  apiKey: "AIzaSyBGnFw13ko0b4KAs7plpFmHlg0GohowElA",
  authDomain: "webrtc-cd5af.firebaseapp.com",
  databaseURL: "https://webrtc-cd5af-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "webrtc-cd5af"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ── ICE / TURN ── */
const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:82.25.104.130:3478" },
    { urls: "turn:82.25.104.130:3478", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:3478?transport=tcp", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349?transport=tcp", username: "akash", credential: "hostinger_vps_123" }
  ],
  iceCandidatePoolSize: 2
};

const RES_MAP = {
  "4k":    { width: 3840, height: 2160 },
  "2k":    { width: 2560, height: 1440 },
  "1080p": { width: 1920, height: 1080 },
  "720p":  { width: 1280, height: 720 }
};

/* ── STATE ── */
let localStream = null;
let roomId = "";
let isHost = false;

// Connections
let screenPcMap = {}; // Host: viewerID -> RTCPeerConnection
let viewerPc = null;  // Viewer: RTCPeerConnection

// Utilities
let statsInterval = null;
let timerInterval = null;
let startTime = 0;
let prevBytesReceived = 0;
let firebaseUnsubs = [];
let bgAudioSet = false;
let iceRestartCount = 0;
const MAX_ICE_RESTARTS = 3;

// Environment
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* ── ICE Debug Logger ── */
function logIce(pc, label) {
  pc.onicecandidate = null; // will be re-set by caller
  pc.onicegatheringstatechange = () => {
    console.log(`[ICE ${label}] gathering: ${pc.iceGatheringState}`);
  };
  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE ${label}] iceConnection: ${pc.iceConnectionState}`);
  };
}

function logCandidate(c, label) {
  if (!c) return;
  const type = c.candidate?.match(/typ (\w+)/)?.[1] || '?';
  console.log(`[ICE ${label}] candidate: ${type} | ${c.candidate?.substring(0, 80)}`);
}

/* ═══════════════════════════════════════════════
   UI UTILITIES
   ═══════════════════════════════════════════════ */
function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
}

function updateConnStatus(state) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  if (!dot || !label) return;
  
  dot.classList.remove("connected", "connecting", "live");
  
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

function changeActionBtns(mode) {
  const container = document.getElementById("actionBtns");
  if (mode === "session") {
    container.innerHTML = `
      <button class="btn-action end" onclick="leaveCall()">
        <span class="material-symbols-outlined">stop_circle</span> Leave Session
      </button>
    `;
  } else {
    container.innerHTML = `
      <button class="btn-action host" onclick="confirmHost()">
        <span class="material-symbols-outlined">cast</span> Start Host Session
      </button>
      <button class="btn-action join" onclick="confirmJoin()">
        <span class="material-symbols-outlined">login</span> Join Watch Party
      </button>
    `;
  }
}

/* ═══════════════════════════════════════════════
   HOST CAPTURE SCREEN
   ═══════════════════════════════════════════════ */
async function captureScreen() {
  const resStr = document.getElementById("scrRes")?.value || "1080p";
  const fpsStr = document.getElementById("scrFps")?.value || "30";
  const { width, height } = RES_MAP[resStr] || RES_MAP["1080p"];
  const fps = parseInt(fpsStr) || 30;

  const constraints = {
    video: { 
      width: { ideal: width }, 
      height: { ideal: height }, 
      frameRate: { ideal: fps } 
    },
    audio: {
      channelCount: 2, 
      sampleRate: 48000,
      autoGainControl: false, 
      echoCancellation: false, 
      noiseSuppression: false // Crucial for media audio quality
    }
  };

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (e) {
    // Safari fallback constraints
    constraints.audio = true;
    localStream = await navigator.mediaDevices.getDisplayMedia(constraints);
  }

  const video = document.getElementById("remoteVideo");
  video.srcObject = localStream;
  video.muted = true; // Host mutes themselves

  // Stop session if window sharing stops at OS level
  localStream.getVideoTracks()[0].onended = () => leaveCall();
  return localStream;
}

/* ═══════════════════════════════════════════════
   BITRATE & LATENCY OPTIMIZATION
   ═══════════════════════════════════════════════ */
async function optimizeHostSender(pc) {
  const mbps = parseFloat(document.getElementById("bitrateSlider")?.value || "4");
  
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    
    // Set Bitrate
    params.encodings[0].maxBitrate = mbps * 1_000_000;
    
    // Low latency network tuning
    params.encodings[0].networkPriority = "high";
    params.degradationPreference = "maintain-framerate"; 
    
    try { await sender.setParameters(params); } catch (_) {}
  }
}

/* ═══════════════════════════════════════════════
   HOST LOGIC
   ═══════════════════════════════════════════════ */
window.confirmHost = async () => {
  roomId = document.getElementById("roomId").value.trim();
  const userName = document.getElementById("userName").value.trim() || "Host";

  if (!roomId) {
    roomId = Math.random().toString(36).substr(2, 8).toUpperCase();
    document.getElementById("roomId").value = roomId;
  }

  try { await captureScreen(); }
  catch (e) { return showToast("⚠️ Screen share cancelled"); }

  isHost = true;
  document.getElementById("noSignal").classList.add("hidden");
  document.getElementById("liveBadge").style.display = "flex";
  document.getElementById("sourceTag").style.display = "";
  document.getElementById("sourceTag").textContent = "HOSTING";
  
  updateConnStatus("connected");
  changeActionBtns("session");
  window.switchTab("settings"); // Keep them on settings to adjust volume/etc or switch to chat manually

  // Register Host in DB
  const roomRef = ref(db, `rooms/${roomId}`);
  await set(ref(db, `rooms/${roomId}/host`), { name: userName, created: Date.now() });

  // Clean room on disconnect
  onDisconnect(roomRef).remove();

  // Listen for Viewers
  const unsubViewers = onChildAdded(ref(db, `rooms/${roomId}/viewers`), async snap => {
    const viewerId = snap.key;
    if (!viewerId || screenPcMap[viewerId]) return;

    // Create RTCPeerConnection for viewer
    const pc = new RTCPeerConnection(servers);
    screenPcMap[viewerId] = pc;

    // Add Host Streams
    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    logIce(pc, `host→${viewerId.substring(0,6)}`);

    pc.onconnectionstatechange = () => {
      console.log(`[Host→${viewerId.substring(0,6)}] connectionState: ${pc.connectionState}`);
      if (pc.connectionState === "connected") optimizeHostSender(pc);
      if (["failed", "closed"].includes(pc.connectionState)) {
        try { pc.close(); } catch (_) {}
        delete screenPcMap[viewerId];
      }
    };

    // ICE Handshake
    const offerCandsRef = ref(db, `rooms/${roomId}/viewers/${viewerId}/offerCandidates`);
    const answerCandsRef = ref(db, `rooms/${roomId}/viewers/${viewerId}/answerCandidates`);

    pc.onicecandidate = e => {
      if (e.candidate) {
        logCandidate(e.candidate, `host→${viewerId.substring(0,6)}`);
        push(offerCandsRef, e.candidate.toJSON());
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/viewers/${viewerId}/offer`), { type: offer.type, sdp: offer.sdp });

    // Listen for Answer
    let pendingViewerIce = [];
    let hostRemoteDescReady = false;

    const unsubAnswer = onValue(ref(db, `rooms/${roomId}/viewers/${viewerId}/answer`), async rootSnap => {
      if (!rootSnap.val() || hostRemoteDescReady) return;
      try { 
        await pc.setRemoteDescription(new RTCSessionDescription(rootSnap.val())); 
        hostRemoteDescReady = true;

        // Apply any early ICE candidates
        for (const c of pendingViewerIce) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
        }
        pendingViewerIce = [];
      } catch (e) {
        console.error("Error setting remote description:", e);
      }
    });
    firebaseUnsubs.push(unsubAnswer);

    // Listen for Viewer ICE
    const unsubIce = onChildAdded(answerCandsRef, async cSnap => {
      const c = cSnap.val();
      if (hostRemoteDescReady) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      } else {
        pendingViewerIce.push(c);
      }
    });
    firebaseUnsubs.push(unsubIce);
  });
  
  firebaseUnsubs.push(unsubViewers);

  startChatListener();
  startReactionListener();
  showToast("🎬 Live! Room code: " + roomId);
};


/* ═══════════════════════════════════════════════
   VIEWER LOGIC
   ═══════════════════════════════════════════════ */
window.confirmJoin = async () => {
  roomId = document.getElementById("roomId").value.trim();
  const userName = document.getElementById("userName").value.trim() || "Viewer";

  if (!roomId) return showToast("⚠️ Enter Room Code");

  isHost = false;
  bgAudioSet = false;
  updateConnStatus("connecting");
  document.getElementById("noSignal").classList.add("hidden");

  const myViewerId = "v_" + Math.random().toString(36).substr(2, 9);
  
  // Clean on drop
  onDisconnect(ref(db, `rooms/${roomId}/viewers/${myViewerId}`)).remove();
  
  // Signal presence
  await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/ready`), { name: userName });

  const pc = new RTCPeerConnection(servers);
  viewerPc = pc;

  const video = document.getElementById("remoteVideo");
  const remoteStream = new MediaStream();
  video.srcObject = remoteStream;
  video.muted = false; // Viewers hear audio

  pc.ontrack = (e) => {
    // Sub-50ms latency tuning! Playout delay 0 means no jitter buffering.
    if (e.receiver) {
      e.receiver.playoutDelayHint = 0; 
    }

    const track = e.track;
    if (!remoteStream.getTracks().find(t => t.id === track.id)) {
      remoteStream.addTrack(track);
    }
    
    // Background Audio Handling - The savior of mobile watch parties!
    if (!bgAudioSet && track.kind === 'audio') {
      bgAudioSet = true;
      const bgAudio = document.getElementById("bgAudio");
      bgAudio.srcObject = new MediaStream([track]);
      
      // Mute the video element's audio so we don't get double output
      video.muted = true; 
      
      bgAudio.play().then(() => {
        // Tie MediaSession so mobile OS sees active media playback
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: `Live Room ${roomId}`,
            artist: 'Watch Party',
            artwork: [{ src: 'icon.png', sizes: '192x192', type: 'image/png' }]
          });
        }
      }).catch(err => console.warn("Background audio play failed:", err));
    }
  };

  logIce(pc, 'viewer');

  pc.onconnectionstatechange = () => {
    console.log(`[Viewer] connectionState: ${pc.connectionState}`);
    if (pc.connectionState === "connected") {
      iceRestartCount = 0; // reset on success
      updateConnStatus("connected");
      document.getElementById("noSignal").classList.add("hidden");
      document.getElementById("sourceTag").style.display = "";
      document.getElementById("sourceTag").textContent = "WATCHING";
      
      changeActionBtns("session");
      window.switchTab("chat");
      startStats(pc);
      showToast("🎬 Connected!");
    }
    if (pc.connectionState === "disconnected") {
      // Don't immediately fail — mobile networks recover
      console.log("[Viewer] ICE disconnected, waiting for recovery...");
      updateConnStatus("connecting");
      showToast("⚡ Reconnecting...");
    }
    if (pc.connectionState === "failed") {
      if (iceRestartCount < MAX_ICE_RESTARTS) {
        iceRestartCount++;
        console.log(`[Viewer] ICE restart attempt ${iceRestartCount}/${MAX_ICE_RESTARTS}`);
        showToast(`🔄 Retrying... (${iceRestartCount}/${MAX_ICE_RESTARTS})`);
        // ICE Restart — renegotiate candidates
        pc.restartIce();
      } else {
        showToast("❌ Connection failed after retries");
        updateConnStatus("disconnected");
        leaveCall();
      }
    }
  };

  const offerCandsRef = ref(db, `rooms/${roomId}/viewers/${myViewerId}/offerCandidates`);
  const answerCandsRef = ref(db, `rooms/${roomId}/viewers/${myViewerId}/answerCandidates`);

  pc.onicecandidate = e => {
    if (e.candidate) {
      logCandidate(e.candidate, 'viewer');
      push(answerCandsRef, e.candidate.toJSON());
    } else {
      console.log('[Viewer] ICE gathering complete');
    }
  };

  let pendingIce = [];
  let remoteDescReady = false;

  // Listen for Host Offer
  const unsubOffer = onValue(ref(db, `rooms/${roomId}/viewers/${myViewerId}/offer`), async snap => {
    if (!snap.val() || remoteDescReady) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
      remoteDescReady = true;

      // Unpack early ICE
      for (const c of pendingIce) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
      pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/answer`), { type: answer.type, sdp: answer.sdp });
    } catch(e) { console.error(e); }
  });
  firebaseUnsubs.push(unsubOffer);

  // Listen for Host ICE Candidates
  const unsubIce = onChildAdded(offerCandsRef, async snap => {
    const c = snap.val();
    if (remoteDescReady) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    } else {
      pendingIce.push(c);
    }
  });
  firebaseUnsubs.push(unsubIce);

  startChatListener();
  startReactionListener();
};


/* ═══════════════════════════════════════════════
   LEAVE CALL / TEARDOWN
   ═══════════════════════════════════════════════ */
window.leaveCall = async () => {
  stopStats();

  // Clean Firebase listeners
  firebaseUnsubs.forEach(unsub => { try { unsub(); } catch(_) {} });
  firebaseUnsubs = [];

  // Close ALL Host connections
  Object.values(screenPcMap).forEach(pc => { try { pc.close(); } catch(_) {} });
  screenPcMap = {};

  // Close Viewer connection
  if (viewerPc) { try { viewerPc.close(); } catch(_) {} viewerPc = null; }

  // Stop capturing Screen
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  // Pause Audio
  const bgAudio = document.getElementById("bgAudio");
  if (bgAudio) { bgAudio.srcObject = null; bgAudio.pause(); }
  
  // Wipe room data if Host
  if (isHost && roomId) {
    remove(ref(db, `rooms/${roomId}`));
  }

  // Reset UI
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("noSignal").classList.remove("hidden");
  document.getElementById("liveBadge").style.display = "none";
  document.getElementById("sourceTag").style.display = "none";
  document.getElementById("qualityTag").style.display = "none";
  
  updateConnStatus("disconnected");
  changeActionBtns("init");

  // Keep chat container but we could clear it here:
  document.getElementById("chatMessages").innerHTML = 
    `<div style="text-align:center; color:var(--text-muted); margin-top:30px; font-size:11px;">💬 Messages visible to everyone</div>`;

  roomId = "";
  isHost = false;
  bgAudioSet = false;
  showToast("👋 Disconnected");
};


/* ═══════════════════════════════════════════════
   CHAT SYSTEM
   ═══════════════════════════════════════════════ */
window.sendChat = () => {
  const input = document.getElementById("chatInput");
  const msg = input?.value.trim();
  if (!msg || !roomId) return;
  
  const name = document.getElementById("userName")?.value.trim() || (isHost ? "Host" : "Viewer");
  push(ref(db, `rooms/${roomId}/chat`), { sender: name, text: msg, time: Date.now() });
  input.value = "";
};

function startChatListener() {
  if (!roomId) return;
  const ts = Date.now(); // only new messages
  const myName = document.getElementById("userName")?.value.trim() || (isHost ? "Host" : "Viewer");

  const unsub = onChildAdded(ref(db, `rooms/${roomId}/chat`), (snap) => {
    const d = snap.val();
    if (!d || d.time < ts - 1000) return; // Prevent old dupes
    
    // Prevent DOM dupes
    const msgId = `chat_${snap.key}`;
    if (document.getElementById(msgId)) return;

    const wrap = document.createElement("div");
    wrap.className = "chat-msg";
    wrap.id = msgId;

    const isMe = d.sender === myName;
    const timeStr = new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrap.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-sender" style="color:${isMe ? 'var(--accent)' : 'var(--cyan)'}">${isMe ? 'You' : d.sender}</span>
        <span class="chat-time">${timeStr}</span>
      </div>
      <div class="chat-bubble ${isMe ? 'me' : 'other'}">${d.text}</div>
    `;

    const container = document.getElementById("chatMessages");
    if (container) {
      container.appendChild(wrap);
      container.scrollTop = container.scrollHeight;
      
      // If we aren't in chat tab, show a tiny toast
      if (!document.getElementById("contentChat").classList.contains("active")) {
        showToast(`${d.sender}: ${d.text}`);
      }
    }
  });
  firebaseUnsubs.push(unsub);
}


/* ═══════════════════════════════════════════════
   REACTIONS (EMOJI)
   ═══════════════════════════════════════════════ */
window.sendReaction = (emoji) => {
  if (!roomId) return showToast("⚠️ Connect first");
  // Don't send exact same ms if spammed
  push(ref(db, `rooms/${roomId}/reactions`), { emoji, time: Date.now() + Math.random() }); 
  triggerEmojiUI(emoji);
};

function startReactionListener() {
  if (!roomId) return;
  const ts = Date.now();
  const unsub = onChildAdded(ref(db, `rooms/${roomId}/reactions`), (snap) => {
    const d = snap.val();
    if (!d || d.time < ts) return; // skip old
    triggerEmojiUI(d.emoji);
  });
  firebaseUnsubs.push(unsub);
}

function triggerEmojiUI(emoji) {
  const overlay = document.getElementById("emojiOverlay");
  if (!overlay) return;
  const el = document.createElement("div");
  el.className = "emoji-float";
  el.textContent = emoji;
  el.style.left = (15 + Math.random() * 70) + "%"; // random spread
  overlay.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}


/* ═══════════════════════════════════════════════
   STATS SYSTEM
   ═══════════════════════════════════════════════ */
function startStats(pc) {
  if (!pc) return;
  startTime = Date.now();
  prevBytesReceived = 0;
  
  // 3s interval Mobile, 2s Desktop
  const intervalTime = isMobile ? 3000 : 2000;

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
        const timeDiffSeconds = intervalTime / 1000;
        const bitrate = ((bytes - prevBytesReceived) * 8 / timeDiffSeconds / 1_000_000).toFixed(1);
        prevBytesReceived = bytes;
        
        const el = (id) => document.getElementById(id);
        
        if (el("statBitrate")) el("statBitrate").innerHTML = `${bitrate}<span class="stat-unit"> Mbps</span>`;
        if (el("barBitrate")) el("barBitrate").style.width = Math.min(bitrate / 12 * 100, 100) + "%";
        if (el("statFps")) el("statFps").textContent = Math.round(inbound.framesPerSecond || 0);
        if (el("statRes")) el("statRes").textContent = `${inbound.frameWidth||0}×${inbound.frameHeight||0}`;
        if (el("statCodec")) el("statCodec").textContent = inbound.decoderImplementation || "Auto";
        
        const loss = ((inbound.packetsLost||0) / Math.max(inbound.packetsReceived||1, 1) * 100).toFixed(1);
        if (el("statLoss")) el("statLoss").textContent = `${loss}%`;
        
        const tag = el("qualityTag");
        if (tag) { 
          tag.style.display = ""; 
          tag.textContent = inbound.frameHeight >= 1080 ? "1080p" : inbound.frameHeight >= 720 ? "720p" : `${inbound.frameHeight||0}p`; 
        }
      }
      
      if (pair && document.getElementById("statRtt")) {
        const rtt = Math.round((pair.currentRoundTripTime || 0) * 1000);
        document.getElementById("statRtt").innerHTML = `${rtt}<span class="stat-unit"> ms</span>`;
      }
    } catch (_) {}
  }, intervalTime);

  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const el = document.getElementById("statDuration");
    if (el) {
      const hh = Math.floor(s/3600).toString().padStart(2,'0');
      const mm = Math.floor((s%3600)/60).toString().padStart(2,'0');
      const ss = (s%60).toString().padStart(2,'0');
      el.textContent = `${hh}:${mm}:${ss}`;
    }
  }, 1000);
}

function stopStats() { 
  clearInterval(statsInterval); 
  clearInterval(timerInterval); 
}

/* ═══════════════════════════════════════════════
   ROOM CODE HELPER
   ═══════════════════════════════════════════════ */
window.generateRoom = () => {
  const code = Math.random().toString(36).substr(2, 6).toUpperCase();
  const el = document.getElementById("roomId");
  if (el) el.value = code;
  showToast("🎲 Room code generated");
};

/* ── SERVICE WORKER ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}