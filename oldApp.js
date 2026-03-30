import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, set, get, onChildAdded, onValue, push, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

/* ─── FIREBASE ─── */
const firebaseConfig = {
  apiKey: "AIzaSyBGnFw13ko0b4KAs7plpFmHlg0GohowElA",
  authDomain: "webrtc-cd5af.firebaseapp.com",
  databaseURL: "https://webrtc-cd5af-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "webrtc-cd5af"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ─── STUN + FREE TURN SERVERS ─── */
const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:82.25.104.130:3478" },
    { urls: "turn:82.25.104.130:3478", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:3478?transport=tcp", username: "akash", credential: "hostinger_vps_123" },
    { urls: "turn:82.25.104.130:5349?transport=tcp", username: "akash", credential: "hostinger_vps_123" }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 2,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
};

/* ─── STATE ─── */
let localStream, remoteStream, roomId;
let isStreaming = false;
let isHost = false;
let isScreenSharing = false;
let statsInterval = null;
let durationInterval = null;
let startTime = null;

/* ─── QUALITY SETTINGS ─── */
let qualitySettings = {
  screen: { res: "1080p", fps: 30 },
  bitrate: 4
};

/* ─── DOM ─── */
const remoteVideo = document.getElementById("remoteVideo");
const noSignal = document.getElementById("noSignal");
const connDot = document.getElementById("connDot");
const connLabel = document.getElementById("connLabel");
const liveBadge = document.getElementById("liveBadge");
const goLiveBtn = document.getElementById("goLiveBtn");
const sourceTag = document.getElementById("sourceTag");
const qualityTag = document.getElementById("qualityTag");
const qualitySummary = document.getElementById("qualitySummary");

/* ─── RESOLUTION MAP ─── */
const RES_MAP = {
  "4k": { width: 3840, height: 2160 },
  "2k": { width: 2560, height: 1440 },
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 }
};

/* ══════════════════════════════════════════════
   SCREEN SHARE + MIC INIT (Host Only)
   ══════════════════════════════════════════════ */
async function initMedia() {
  const { width, height } = RES_MAP[qualitySettings.screen.res];
  const fps = qualitySettings.screen.fps;
  
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps }, displaySurface: "monitor" },
      audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 48000, channelCount: 2 },
      systemAudio: "include"
    });
  } catch (e) {
    if (e.name !== "NotAllowedError") showToast("❌ Screen share failed: " + e.message);
    return null;
  }

  localStream = new MediaStream();
  
  screenStream.getVideoTracks().forEach(t => {
    t.onended = () => { if (isHost) leaveCall(); };
    localStream.addTrack(t);
  });
  screenStream.getAudioTracks().forEach(t => localStream.addTrack(t));

  // Display Host's own screen locally
  remoteVideo.srcObject = localStream;
  remoteVideo.muted = true; // prevent echoing host's own audio
  remoteVideo.play().catch(() => {});
  
  updateOverlayTags();
  noSignal.classList.add("hidden");
  isScreenSharing = true;
  return localStream;
}

/* ══════════════════════════════════════════════
   PEER CONNECTION (1-to-Many Mesh)
   ══════════════════════════════════════════════ */
let pcMap = {}; // viewerId -> RTCPeerConnection
let myViewerId = null; // Used by viewers

function createHostPC(viewerId) {
  const pc = new RTCPeerConnection(servers);
  pcMap[viewerId] = pc;

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.oniceconnectionstatechange = () => {
    console.log(`[${viewerId}] ICE:`, pc.iceConnectionState);
    if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
      pc.close();
      delete pcMap[viewerId];
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[${viewerId}] PC:`, pc.connectionState);
    if (pc.connectionState === "connected") {
      applyBitratePerPC(pc, qualitySettings.bitrate);
      showToast("👀 A new viewer joined!");
    }
  };

  return pc;
}

function createViewerPC() {
  const pc = new RTCPeerConnection(servers);
  pcMap["host"] = pc;

  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id))
        remoteStream.addTrack(track);
    });
    noSignal.classList.add("hidden");
    remoteVideo.play().catch(() => { });
  };

  pc.oniceconnectionstatechange = () => {
    updateConnStatus(pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") { startStats(); startTimer(); showToast("📺 Connected to Party!"); }
    if (pc.connectionState === "failed") { showToast("❌ Failed to connect"); }
  };

  return pc;
}

async function applyBitratePerPC(pcInstance, mbps) {
  for (const sender of pcInstance.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = mbps * 1_000_000;
    try { await sender.setParameters(params); } catch (_) { }
  }
}

async function applyBitrate(mbps) {
  Object.values(pcMap).forEach(pc => applyBitratePerPC(pc, mbps));
}

/* ══════════════════════════════════════════════
   START STREAM (Host)
   ══════════════════════════════════════════════ */
window.startStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return alert("Enter a Room Code first");

  isHost = true;
  await initMedia();
  if (!localStream) return;

  await new Promise(r => setTimeout(r, 500));

  await set(ref(db, `rooms/${roomId}`), { created: Date.now() });

  onChildAdded(ref(db, `rooms/${roomId}/viewers`), async snap => {
    const viewerId = snap.key;
    if (!viewerId) return;

    const pc = createHostPC(viewerId);
    const offerCandidates = ref(db, `rooms/${roomId}/viewers/${viewerId}/offerCandidates`);
    const answerCandidates = ref(db, `rooms/${roomId}/viewers/${viewerId}/answerCandidates`);

    pc.onicecandidate = e => {
      if (e.candidate) push(offerCandidates, e.candidate.toJSON());
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/viewers/${viewerId}/offer`), offer);

    onValue(ref(db, `rooms/${roomId}/viewers/${viewerId}/answer`), async ansSnap => {
      if (!ansSnap.val() || pc.remoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(ansSnap.val()));
    });

    onChildAdded(answerCandidates, async candSnap => {
      try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) { }
    });
  });

  isStreaming = true;
  goLiveBtn.textContent = "⬛ END LIVE";
  goLiveBtn.classList.add("end");
  liveBadge.classList.add("active");
  window.startChatListener();
  startStats(); startTimer();
  updateConnStatus("connected");
  showToast("🔴 Live! Waiting for viewers...");
};

/* ══════════════════════════════════════════════
   JOIN STREAM (Viewer)
   ══════════════════════════════════════════════ */
window.joinStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return alert("Enter a Room Code first");

  const roomSnap = await get(ref(db, `rooms/${roomId}`));
  if (!roomSnap.exists()) return alert("Room not found. Make sure host has started.");

  isHost = false;
  myViewerId = "v_" + Math.random().toString(36).substr(2, 9);
  localStream = new MediaStream();
  remoteStream = new MediaStream();
  if (remoteVideo) { remoteVideo.srcObject = remoteStream; remoteVideo.muted = false; }

  const pc = createViewerPC();

  const offerCandidates = ref(db, `rooms/${roomId}/viewers/${myViewerId}/offerCandidates`);
  const answerCandidates = ref(db, `rooms/${roomId}/viewers/${myViewerId}/answerCandidates`);

  pc.onicecandidate = e => {
    if (e.candidate) push(answerCandidates, e.candidate.toJSON());
  };

  await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}`), { joined: Date.now() });

  onValue(ref(db, `rooms/${roomId}/viewers/${myViewerId}/offer`), async snap => {
    if (!snap.val() || pc.remoteDescription) return;
    await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));

    const existingSnap = await get(offerCandidates);
    if (existingSnap.exists()) {
      for (const c of Object.values(existingSnap.val())) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) { }
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/answer`), answer);
  });

  onChildAdded(offerCandidates, async candSnap => {
    try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) { }
  });

  updateConnStatus("connecting");
  noSignal.classList.add("hidden");
  window.startChatListener();
  
  const btnMic = document.getElementById("btnMic");
  const btnCam = document.getElementById("btnCam");
  const btnScreen = document.getElementById("btnScreen");
  const btnBgBlur = document.getElementById("btnBgBlur");
  const localVideoPIP = document.querySelector(".pip-container");
  
  if(btnMic) btnMic.style.display = "none";
  if(btnCam) btnCam.style.display = "none";
  if(btnScreen) btnScreen.style.display = "none";
  if(btnBgBlur) btnBgBlur.style.display = "none";
  if(localVideoPIP) localVideoPIP.style.display = "none";
  
  document.getElementById("goLiveBtn").style.display = "none";
};

/* ══════════════════════════════════════════════
   TOGGLE LIVE
   ══════════════════════════════════════════════ */
window.toggleStream = async () => {
  if (!isStreaming) await window.startStream();
  else await window.leaveCall();
};

/* ══════════════════════════════════════════════
   MIC TOGGLE
   ══════════════════════════════════════════════ */
window.toggleMic = () => {
  if (!localStream) return showToast("⚠️ No stream active");
  const tracks = localStream.getAudioTracks();
  if (!tracks.length) return showToast("⚠️ No mic found");
  micEnabled = !micEnabled;
  tracks.forEach(t => t.enabled = micEnabled);
  updateMicBtn();
};

function updateMicBtn() {
  const btn = document.getElementById("btnMic");
  btn.className = micEnabled ? "icon-btn active" : "icon-btn muted-state";
  btn.innerHTML = micEnabled
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/></svg>MIC ON`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v4M8 23h8"/></svg>MIC OFF`;
}

/* ══════════════════════════════════════════════
   CAM TOGGLE
   ══════════════════════════════════════════════ */
window.toggleCam = () => {
  const tracks = localStream?.getVideoTracks() || [];
  if (!tracks.length) return;
  camEnabled = !camEnabled;
  tracks.forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById("btnCam");
  btn.className = camEnabled ? "icon-btn active" : "icon-btn muted-state";
  btn.innerHTML = camEnabled
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>CAM ON`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="1" y1="1" x2="23" y2="23"/><path d="M15.18 15.18A4.5 4.5 0 0 1 8.82 8.82M21 21l-9-9M3 3l18 18"/></svg>CAM OFF`;
};

/* ══════════════════════════════════════════════
   CAMERA SWITCH (front/back)
   ══════════════════════════════════════════════ */
window.switchCamera = async (face) => {
  if (!isHost || isScreenSharing) return;
  currentCamera = face;

  document.getElementById("btnCamFront").className = face === "front" ? "icon-btn active" : "icon-btn";
  document.getElementById("btnCamBack").className = face === "back" ? "icon-btn active" : "icon-btn";

  const facingMode = face === "back" ? "environment" : "user";
  const { width, height } = RES_MAP[qualitySettings.cam.res];
  const fps = qualitySettings.cam.fps;

  try {
    const newVideoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
      audio: false
    });

    // Stop old video
    rawCameraStream?.getVideoTracks().forEach(t => t.stop());
    rawCameraStream = newVideoStream;

    // Update localStream video track
    localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
    newVideoStream.getVideoTracks().forEach(t => localStream.addTrack(t));

    // Restart canvas pipeline with new source
    stopCanvasPipeline();
    startCanvasPipeline(localStream);

    await new Promise(r => setTimeout(r, 300));

    // Update WebRTC sender with new canvas track
    if (canvasStream) {
      const videoSender = pc?.getSenders().find(s => s.track?.kind === "video");
      if (videoSender) await videoSender.replaceTrack(canvasStream.getVideoTracks()[0]);
    }

    showToast(face === "back" ? "📷 Back camera" : "🤳 Front camera");
  } catch (e) {
    showToast("❌ Camera switch failed: " + e.message);
  }

  updateOverlayTags();
};

/* ══════════════════════════════════════════════
   MIRROR TOGGLE
   Canvas mein baked — viewer ko bhi dikhta hai
   ══════════════════════════════════════════════ */
window.toggleMirror = () => {
  isMirrored = !isMirrored;
  const btn = document.getElementById("btnMirror");
  btn.className = isMirrored ? "icon-btn active" : "icon-btn";
  showToast(isMirrored ? "↔️ Mirror ON (viewer ko bhi dikhega)" : "↔️ Mirror OFF");
  // drawLoop mein isMirrored check hota hai — auto update
};

/* ══════════════════════════════════════════════
   SCREEN SHARE
   ══════════════════════════════════════════════ */
window.startScreenShare = async () => {
  if (!isHost) return showToast("⚠️ Only host can share screen");

  if (isScreenSharing) {
    // Switch back to camera
    isScreenSharing = false;
    document.getElementById("btnScreen").className = "icon-btn";
    await window.switchCamera(currentCamera);
    return;
  }

  const screenStream = await initScreenShare();
  if (!screenStream) return;

  const screenVideoTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

  // Stop canvas pipeline (no effects on screen share)
  stopCanvasPipeline();

  // Replace video in WebRTC
  const videoSender = pc?.getSenders().find(s => s.track?.kind === "video");
  if (videoSender) await videoSender.replaceTrack(screenVideoTrack);

  // Replace audio with system audio if available
  if (screenAudioTrack) {
    const audioSender = pc?.getSenders().find(s => s.track?.kind === "audio");
    if (audioSender) await audioSender.replaceTrack(screenAudioTrack);
    showToast("🔊 Screen + system audio streaming!");
  } else {
    showToast("🖥️ Screen sharing (no system audio found)");
  }

  localVideo.srcObject = screenStream;
  localVideo.style.transform = "";
  localVideo.style.filter = "";

  isScreenSharing = true;
  document.getElementById("btnScreen").className = "icon-btn sharing";
  sourceTag.textContent = "SCREEN";
  qualityTag.textContent = `${qualitySettings.screen.res.toUpperCase()} ${qualitySettings.screen.fps}fps`;

  screenVideoTrack.addEventListener("ended", async () => {
    isScreenSharing = false;
    document.getElementById("btnScreen").className = "icon-btn";
    await window.switchCamera(currentCamera);
    showToast("🖥️ Screen share ended");
  });
};

/* ══════════════════════════════════════════════
   LEAVE CALL
   ══════════════════════════════════════════════ */
window.leaveCall = async () => {
  stopStats(); stopTimer();
  
  if (pcMap) {
    Object.values(pcMap).forEach(p => p.close());
    pcMap = {};
  }
  
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  
  if (roomId && isHost) await remove(ref(db, "rooms/" + roomId));
  else if (roomId && !isHost && myViewerId) await remove(ref(db, `rooms/${roomId}/viewers/${myViewerId}`));

  isStreaming = false; isScreenSharing = false;
  noSignal.classList.remove("hidden");
  liveBadge.classList.remove("active");
  goLiveBtn.textContent = "⬤ START SESSION";
  goLiveBtn.classList.remove("end");
  updateConnStatus("disconnected");
  clearStats();
  if (window.chatUnsubscribe) off(ref(db, `rooms/${roomId}/messages`), "child_added", window.chatUnsubscribe);
  showToast("👋 Session ended");
  setTimeout(() => location.reload(), 1500);
};

/* ══════════════════════════════════════════════
   QUALITY MODAL
   ══════════════════════════════════════════════ */
window.openQualityModal = () => {
  document.getElementById("qualityModal").classList.add("open");
  document.getElementById("scrRes").value = qualitySettings.screen.res;
  document.getElementById("scrFps").value = qualitySettings.screen.fps;
  document.getElementById("bitrateSlider").value = qualitySettings.bitrate;
  document.getElementById("bitrateValLabel").textContent = qualitySettings.bitrate + " Mbps";
};
window.closeQualityModal = () => document.getElementById("qualityModal").classList.remove("open");

window.applyQuality = async () => {
  qualitySettings.screen.res = document.getElementById("scrRes").value;
  qualitySettings.screen.fps = parseInt(document.getElementById("scrFps").value);
  qualitySettings.bitrate = parseFloat(document.getElementById("bitrateSlider").value);
  closeQualityModal();
  updateQualitySummary();
  await applyBitrate(qualitySettings.bitrate);
  updateOverlayTags();
  showToast("✅ Settings applied");
};

function updateQualitySummary() {
  const res = qualitySettings.screen.res;
  const fps = qualitySettings.screen.fps;
  qualitySummary.innerHTML = `${res.toUpperCase()}<br>${fps}fps<br>${qualitySettings.bitrate}Mbps`;
}

function updateOverlayTags() {
  sourceTag.textContent = "SCREEN SHARE";
  qualityTag.textContent = `${qualitySettings.screen.res.toUpperCase()} • ${qualitySettings.screen.fps}fps`;
}

/* ══════════════════════════════════════════════
   STATS
   ══════════════════════════════════════════════ */
async function getStats() {
  const activePc = Object.values(pcMap)[0];
  if (!activePc) return;
  const stats = await activePc.getStats();
  let bytesSent = 0, fps = 0, w = 0, h = 0, lost = 0, rtt = 0, codec = "—";
  stats.forEach(r => {
    if (r.type === "outbound-rtp" && r.kind === "video") {
      bytesSent = r.bytesSent || 0; fps = r.framesPerSecond || 0;
      w = r.frameWidth || 0; h = r.frameHeight || 0; lost = r.packetsLost || 0;
    }
    if (r.type === "candidate-pair" && r.state === "succeeded")
      rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
    if (r.type === "codec" && r.mimeType?.includes("video"))
      codec = r.mimeType.split("/")[1];
  });
  if (getStats._prev !== undefined) {
    const mbps = ((bytesSent - getStats._prev) * 8 / 1_000_000).toFixed(2);
    document.getElementById("statBitrate").innerHTML = `${mbps}<span class="stat-unit">Mbps</span>`;
    document.getElementById("barBitrate").style.width = Math.min(parseFloat(mbps) / (qualitySettings.bitrate + 2) * 100, 100) + "%";
  }
  getStats._prev = bytesSent;
  document.getElementById("statFps").textContent = fps ? Math.round(fps) : "—";
  document.getElementById("statRes").textContent = w && h ? `${w}×${h}` : "—";
  document.getElementById("statLoss").textContent = lost;
  document.getElementById("statRtt").innerHTML = rtt ? `${rtt}<span class="stat-unit">ms</span>` : `—<span class="stat-unit">ms</span>`;
  document.getElementById("statCodec").textContent = codec;
  document.getElementById("statRtt").className = "stat-value " + (rtt < 50 ? "green" : rtt < 150 ? "yellow" : "red");
}
function startStats() { if (statsInterval) return; statsInterval = setInterval(getStats, 1000); }
function stopStats() { clearInterval(statsInterval); statsInterval = null; }
function clearStats() {
  ["statBitrate", "statFps", "statRes", "statLoss", "statRtt", "statCodec"].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = "—";
  });
  document.getElementById("barBitrate").style.width = "0%";
  document.getElementById("statDuration").textContent = "00:00:00";
}

/* ══════════════════════════════════════════════
   TIMER
   ══════════════════════════════════════════════ */
function startTimer() {
  if (durationInterval) return;
  startTime = Date.now();
  durationInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor(s % 3600 / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    document.getElementById("statDuration").textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}
function stopTimer() { clearInterval(durationInterval); durationInterval = null; }

/* ══════════════════════════════════════════════
   CONNECTION STATUS
   ══════════════════════════════════════════════ */
function updateConnStatus(state) {
  const map = {
    connected: ["connected", "CONNECTED"],
    connecting: ["connecting", "CONNECTING…"],
    checking: ["connecting", "CHECKING…"],
    disconnected: ["", "DISCONNECTED"],
    failed: ["", "FAILED"],
    closed: ["", "CLOSED"]
  };
  const [cls, text] = map[state] || map.disconnected;
  connDot.className = "conn-dot " + cls;
  connLabel.textContent = text;
}

/* ══════════════════════════════════════════════
   GENERATE ROOM + TOAST
   ══════════════════════════════════════════════ */
window.generateRoom = () => {
  document.getElementById("roomId").value = Math.random().toString(36).substr(2, 6).toUpperCase();
};

function showToast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2800);
}

/* ─── Init ─── */
updateQualitySummary();

/* ══════════════════════════════════════════════
   LIVE CHAT (Firebase)
   ══════════════════════════════════════════════ */
window.sendChat = () => {
  const input = document.getElementById("chatInput");
  const msg = input?.value.trim() || "";
  if (!msg) return;
  if (!roomId) return showToast("⚠️ Join or Start a room first!");

  const nameInput = document.getElementById("userName");
  const senderName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "Viewer_" + Math.floor(Math.random()*1000);

  push(ref(db, `rooms/${roomId}/messages`), {
    sender: senderName,
    text: msg,
    timestamp: Date.now()
  });
  input.value = "";
};

window.startChatListener = () => {
  const chatMessages = document.getElementById("chatMessages");
  if (!chatMessages) return;
  chatMessages.innerHTML = `<div style="text-align:center; color:#9aa0a6; margin-top:10px;">Messages are visible to everyone in the room.</div>`;
  
  onChildAdded(ref(db, `rooms/${roomId}/messages`), snap => {
    const data = snap.val();
    if (!data) return;
    
    const nameInput = document.getElementById("userName");
    const myName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "";
    const isMe = data.sender === myName && myName !== "";
    
    const msgEl = document.createElement("div");
    msgEl.style.display = "flex";
    msgEl.style.flexDirection = "column";
    msgEl.style.gap = "2px";
    
    const timeStr = new Date(data.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    // Protect against XSS
    const safeSender = data.sender.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeText = data.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    msgEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-end;">
        <span style="font-weight:600; color: ${isMe ? '#8ab4f8' : '#e8eaed'};">${safeSender}</span>
        <span style="font-size:10px; color:#9aa0a6;">${timeStr}</span>
      </div>
      <div style="background: ${isMe ? 'rgba(138, 180, 248, 0.15)' : '#3c4043'}; padding: 8px 12px; border-radius: ${isMe ? '12px 12px 4px 12px' : '4px 12px 12px 12px'}; line-height: 1.4; color: ${isMe ? '#e8eaed' : '#e8eaed'}; word-break: break-word;">
        ${safeText}
      </div>
    `;
    
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
};