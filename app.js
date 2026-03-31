import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, set, get, onChildAdded, onChildRemoved, onValue, push, remove
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

/* ─── STUN + TURN SERVERS ─── */
const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
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

/* ─── MOBILE DETECTION ─── */
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

/* ─── STATE ─── */
let localStream = null;       // screen share stream
let remoteStream = null;      // received screen share
let localVoiceStream = null;  // mic + camera stream
let roomId = null;
let isStreaming = false;
let isHost = false;
let isScreenSharing = false;
let roomMode = "watch";       // "voice" or "watch"
let micEnabled = true;
let camEnabled = true;
let statsInterval = null;
let durationInterval = null;
let startTime = null;

/* ─── VOICE MESH STATE ─── */
let voicePcMap = {};     // peerId → { pc, audioEl, videoEl }
let myVoiceId = null;
let voiceSettings = {
  videoRes: "720p",
  videoBitrate: 1,       // Mbps
  maxParticipants: 5
};
let voiceVolume = 0.8;

/* ─── QUALITY SETTINGS (Screen Share) ─── */
let qualitySettings = {
  screen: { res: "1080p", fps: 30 },
  bitrate: 4
};

/* ─── DOM ─── */
const remoteVideo = document.getElementById("remoteVideo");
const bgAudio = document.getElementById("bgAudio");
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
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
  "360p": { width: 640, height: 360 }
};

/* ══════════════════════════════════════════════
   MODE MODAL FUNCTIONS
   ══════════════════════════════════════════════ */
window.openModeModal = () => {
  document.getElementById("modeModal").classList.add("open");
};
window.closeModeModal = () => {
  document.getElementById("modeModal").classList.remove("open");
};

window.confirmModeAndStart = async () => {
  // Read mode from UI
  roomMode = window.selectedMode || "voice";

  if (roomMode === "voice") {
    voiceSettings.videoRes = document.getElementById("voiceVideoRes").value;
    voiceSettings.videoBitrate = parseFloat(document.getElementById("voiceBitrateSlider").value);
    voiceSettings.maxParticipants = parseInt(document.getElementById("maxParticipantsSelect").value);
  }

  closeModeModal();
  await window.startStream();
};

/* ══════════════════════════════════════════════
   SCREEN SHARE INIT (Host Only) — PC #1
   ══════════════════════════════════════════════ */
async function initMedia() {
  const { width, height } = RES_MAP[qualitySettings.screen.res];
  const fps = qualitySettings.screen.fps;

  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
        displaySurface: "monitor"
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2
      },
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

  // Host preview (muted to prevent echo)
  remoteVideo.srcObject = localStream;
  remoteVideo.muted = true;
  remoteVideo.play().catch(() => {});

  updateOverlayTags();
  noSignal.classList.add("hidden");
  isScreenSharing = true;
  return localStream;
}

/* ══════════════════════════════════════════════
   VOICE + CAMERA INIT — for Voice Mesh (PC #2)
   ══════════════════════════════════════════════ */
async function initVoiceMedia() {
  const { width, height } = RES_MAP[voiceSettings.videoRes];

  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
        facingMode: "user"
      }
    });

    // Show local video tile in participant grid
    addLocalVideoTile();
    return localVoiceStream;
  } catch (e) {
    showToast("⚠️ Mic/Camera access failed: " + e.message);
    // Try audio only
    try {
      localVoiceStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
      addLocalVideoTile();
      return localVoiceStream;
    } catch (e2) {
      showToast("❌ No mic access: " + e2.message);
      return null;
    }
  }
}

/* ══════════════════════════════════════════════
   SCREEN SHARE PEER CONNECTIONS (PC #1)
   1-to-Many: Host → Viewers
   ══════════════════════════════════════════════ */
let screenPcMap = {}; // viewerId → RTCPeerConnection

function createHostScreenPC(viewerId) {
  const pc = new RTCPeerConnection(servers);
  screenPcMap[viewerId] = pc;

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.oniceconnectionstatechange = () => {
    console.log(`[Screen][${viewerId}] ICE:`, pc.iceConnectionState);
    if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
      pc.close();
      delete screenPcMap[viewerId];
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Screen][${viewerId}] PC:`, pc.connectionState);
    if (pc.connectionState === "connected") {
      applyBitratePerPC(pc, qualitySettings.bitrate);
      showToast("👀 A viewer joined!");
    }
  };

  return pc;
}

function createViewerScreenPC() {
  const pc = new RTCPeerConnection(servers);
  screenPcMap["host"] = pc;

  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
    });
    noSignal.classList.add("hidden");
    remoteVideo.play().catch(() => {});

    // Setup background audio — extract audio tracks into hidden audio element
    setupBackgroundAudio(remoteStream);
  };

  pc.oniceconnectionstatechange = () => {
    updateConnStatus(pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      startStats(); startTimer();
      showToast("📺 Connected to Party!");
    }
    if (pc.connectionState === "failed") {
      showToast("❌ Connection failed. Trying to reconnect...");
    }
  };

  return pc;
}

async function applyBitratePerPC(pcInstance, mbps) {
  for (const sender of pcInstance.getSenders()) {
    if (!sender.track) continue;
    // ONLY limit VIDEO bitrate — never cap audio (preserves HD bass quality)
    if (sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = mbps * 1_000_000;
    try { await sender.setParameters(params); } catch (_) {}
  }
}

/* ══════════════════════════════════════════════
   SDP MODIFICATION — Force HD Stereo Opus Audio
   This modifies the SDP BEFORE negotiation so that
   Opus codec uses stereo, max bitrate, and no CBR.
   This is the CORRECT way to ensure HD bass audio.
   ══════════════════════════════════════════════ */
function forceHDStereoAudio(sdp) {
  // Find Opus payload type from rtpmap
  const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\//i);
  if (!opusMatch) return sdp;
  const pt = opusMatch[1];

  // Modify Opus fmtp line to add stereo + high bitrate params
  const fmtpRegex = new RegExp(`(a=fmtp:${pt} .+)`);
  if (fmtpRegex.test(sdp)) {
    sdp = sdp.replace(fmtpRegex, (match) => {
      // Remove any existing stereo/bitrate params to avoid duplicates
      let clean = match
        .replace(/;?stereo=\d/g, '')
        .replace(/;?sprop-stereo=\d/g, '')
        .replace(/;?maxaveragebitrate=\d+/g, '')
        .replace(/;?cbr=\d/g, '')
        .replace(/;?maxplaybackrate=\d+/g, '');
      return clean + ';stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;cbr=0';
    });
  }
  return sdp;
}

async function applyBitrate(mbps) {
  Object.values(screenPcMap).forEach(pc => applyBitratePerPC(pc, mbps));
}

/* ══════════════════════════════════════════════
   VOICE MESH PEER CONNECTIONS (PC #2)
   All-to-All: Everyone ↔ Everyone
   ══════════════════════════════════════════════ */

function getPairKey(id1, id2) {
  return [id1, id2].sort().join("__");
}

async function createVoiceConnection(peerId, peerName, isOfferer) {
  const pairKey = getPairKey(myVoiceId, peerId);
  const pc = new RTCPeerConnection(servers);

  voicePcMap[peerId] = { pc, audioEl: null, peerName };

  // Add our mic + camera tracks
  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach(track => {
      pc.addTrack(track, localVoiceStream);
    });
  }

  // Handle incoming remote voice + video tracks
  const remoteVoiceStream = new MediaStream();

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => {
      if (!remoteVoiceStream.getTracks().find(t => t.id === track.id)) {
        remoteVoiceStream.addTrack(track);
      }
    });

    // Create/update audio element for this peer's voice
    const audioTracks = remoteVoiceStream.getAudioTracks();
    if (audioTracks.length > 0 && !voicePcMap[peerId]?.audioEl) {
      const audioEl = new Audio();
      audioEl.srcObject = new MediaStream(audioTracks);
      audioEl.volume = voiceVolume;
      audioEl.play().catch(() => {});
      if (voicePcMap[peerId]) voicePcMap[peerId].audioEl = audioEl;
    }

    // Add/update video tile
    addRemoteVideoTile(peerId, peerName, remoteVoiceStream);
  };

  // ICE candidates
  const myIcePath = isOfferer
    ? `rooms/${roomId}/voiceLinks/${pairKey}/offerCandidates`
    : `rooms/${roomId}/voiceLinks/${pairKey}/answerCandidates`;

  pc.onicecandidate = (e) => {
    if (e.candidate) push(ref(db, myIcePath), e.candidate.toJSON());
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[Voice][${peerId}] ICE:`, pc.iceConnectionState);
    if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
      cleanupVoicePeer(peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Voice][${peerId}] PC:`, pc.connectionState);
    if (pc.connectionState === "connected") {
      applyBitratePerPC(pc, voiceSettings.videoBitrate);
      showToast(`🎤 Voice connected with ${peerName}`);
    }
  };

  if (isOfferer) {
    // I create the offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/offer`), {
      type: offer.type,
      sdp: offer.sdp
    });

    // Listen for answer
    onValue(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/answer`), async (snap) => {
      if (!snap.val() || pc.signalingState === "stable") return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
      } catch (e) {
        console.warn("[Voice] setRemoteDesc error:", e);
      }
    });

    // Listen for answer ICE candidates
    onChildAdded(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/answerCandidates`), async (candSnap) => {
      try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
    });
  } else {
    // Listen for offer, then answer
    onValue(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/offer`), async (snap) => {
      if (!snap.val() || pc.signalingState !== "stable") return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/answer`), {
          type: answer.type,
          sdp: answer.sdp
        });
      } catch (e) {
        console.warn("[Voice] offer/answer error:", e);
      }
    });

    // Listen for offer ICE candidates
    onChildAdded(ref(db, `rooms/${roomId}/voiceLinks/${pairKey}/offerCandidates`), async (candSnap) => {
      try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
    });
  }

  updateParticipantCount();
}

function cleanupVoicePeer(peerId) {
  const entry = voicePcMap[peerId];
  if (!entry) return;

  if (entry.pc) {
    try { entry.pc.close(); } catch (_) {}
  }
  if (entry.audioEl) {
    entry.audioEl.pause();
    entry.audioEl.srcObject = null;
  }

  // Remove video tile
  const tile = document.getElementById(`tile_${peerId}`);
  if (tile) tile.remove();

  delete voicePcMap[peerId];
  updateParticipantCount();
}

async function joinVoiceMesh() {
  // Get mic + camera
  await initVoiceMedia();
  if (!localVoiceStream) {
    showToast("⚠️ Joining voice without mic/camera");
    localVoiceStream = new MediaStream(); // empty stream fallback
  }

  // Generate a unique voice peer ID
  myVoiceId = "vp_" + Math.random().toString(36).substr(2, 9);
  const myName = document.getElementById("userName").value.trim() || "User_" + Math.floor(Math.random() * 1000);

  // Register in Firebase
  await set(ref(db, `rooms/${roomId}/voiceMembers/${myVoiceId}`), {
    name: myName,
    joined: Date.now()
  });

  // Get existing members first, then create connections
  const membersSnap = await get(ref(db, `rooms/${roomId}/voiceMembers`));
  const existingMembers = membersSnap.exists() ? membersSnap.val() : {};

  for (const [peerId, peerData] of Object.entries(existingMembers)) {
    if (peerId === myVoiceId) continue;

    const isOfferer = myVoiceId < peerId;
    await createVoiceConnection(peerId, peerData.name || "Unknown", isOfferer);
  }

  // Listen for NEW members joining after us
  onChildAdded(ref(db, `rooms/${roomId}/voiceMembers`), async (snap) => {
    const peerId = snap.key;
    if (peerId === myVoiceId || voicePcMap[peerId]) return;

    // Check participant limit
    const currentCount = Object.keys(voicePcMap).length + 1; // +1 for self
    if (currentCount >= voiceSettings.maxParticipants) {
      console.log(`[Voice] Room full (${currentCount}/${voiceSettings.maxParticipants})`);
      return;
    }

    const peerData = snap.val();
    const isOfferer = myVoiceId < peerId;
    await createVoiceConnection(peerId, peerData.name || "Unknown", isOfferer);
  });

  // Listen for members leaving
  onChildRemoved(ref(db, `rooms/${roomId}/voiceMembers`), (snap) => {
    const peerId = snap.key;
    if (peerId === myVoiceId) return;

    cleanupVoicePeer(peerId);
    showToast(`👋 ${snap.val()?.name || "Someone"} left voice chat`);
  });

  // Activate voice UI
  document.body.classList.add("voice-mode");
  document.getElementById("modeBadge").style.display = "flex";
  document.getElementById("modeBadgeText").textContent = `Voice (${voiceSettings.maxParticipants} max)`;
  document.getElementById("voiceVolumeRow").style.display = "flex";

  updateParticipantCount();
  showToast("🎤 Voice + Video mesh active!");
}

/* ══════════════════════════════════════════════
   PARTICIPANT VIDEO TILES (UI)
   ══════════════════════════════════════════════ */

function addLocalVideoTile() {
  const grid = document.getElementById("gridTiles");
  const existing = document.getElementById("tile_local");
  if (existing) existing.remove();

  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = "tile_local";

  const myName = document.getElementById("userName").value.trim() || "You";

  if (localVoiceStream && localVoiceStream.getVideoTracks().length > 0) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = localVoiceStream;
    video.style.transform = "scaleX(-1)"; // mirror
    tile.appendChild(video);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "tile-avatar";
    avatar.textContent = myName.charAt(0).toUpperCase();
    tile.appendChild(avatar);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "tile-name";
  nameSpan.textContent = myName + " (You)";
  tile.appendChild(nameSpan);

  const micIcon = document.createElement("span");
  micIcon.className = "tile-mic material-symbols-outlined";
  micIcon.id = "localTileMic";
  micIcon.textContent = "mic";
  tile.appendChild(micIcon);

  grid.prepend(tile);
  document.getElementById("participantsGrid").classList.add("active");
  updateParticipantCount();
}

function addRemoteVideoTile(peerId, peerName, stream) {
  const grid = document.getElementById("gridTiles");
  let tile = document.getElementById(`tile_${peerId}`);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = `tile_${peerId}`;
    grid.appendChild(tile);
  } else {
    tile.innerHTML = "";
  }

  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length > 0) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // video muted — audio comes from separate audioEl
    video.srcObject = stream;
    tile.appendChild(video);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "tile-avatar";
    avatar.textContent = (peerName || "?").charAt(0).toUpperCase();
    tile.appendChild(avatar);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "tile-name";
  nameSpan.textContent = peerName || "Unknown";
  tile.appendChild(nameSpan);

  const micIcon = document.createElement("span");
  micIcon.className = "tile-mic material-symbols-outlined";
  micIcon.textContent = "mic";
  tile.appendChild(micIcon);

  updateParticipantCount();
}

function updateParticipantCount() {
  const count = document.getElementById("gridTiles").children.length;
  const el = document.getElementById("participantCount");
  if (el) el.textContent = count;
}

/* ══════════════════════════════════════════════
   VOICE VOLUME CONTROL
   ══════════════════════════════════════════════ */
window.updateVoiceVolume = (vol) => {
  voiceVolume = vol;
  Object.values(voicePcMap).forEach(entry => {
    if (entry.audioEl) entry.audioEl.volume = vol;
  });
};

/* ══════════════════════════════════════════════
   START STREAM (Host) — with Mode Selection
   ══════════════════════════════════════════════ */
window.startStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return alert("Enter a Room Code first");

  isHost = true;

  // Screen share
  await initMedia();
  if (!localStream) { isHost = false; return; }

  await new Promise(r => setTimeout(r, 500));

  // Write room info to Firebase
  await set(ref(db, `rooms/${roomId}`), {
    created: Date.now(),
    mode: roomMode,
    maxVoiceParticipants: roomMode === "voice" ? voiceSettings.maxParticipants : 0,
    voiceSettings: roomMode === "voice" ? {
      videoRes: voiceSettings.videoRes,
      videoBitrate: voiceSettings.videoBitrate
    } : null
  });

  // Listen for viewer screen share connections (PC #1)
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
    // Force HD stereo Opus in SDP before sending
    const hdSdp = forceHDStereoAudio(offer.sdp);
    await pc.setLocalDescription({ type: offer.type, sdp: hdSdp });
    await set(ref(db, `rooms/${roomId}/viewers/${viewerId}/offer`), {
      type: offer.type,
      sdp: hdSdp
    });

    onValue(ref(db, `rooms/${roomId}/viewers/${viewerId}/answer`), async ansSnap => {
      if (!ansSnap.val() || pc.remoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(ansSnap.val()));
    });

    onChildAdded(answerCandidates, async candSnap => {
      try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
    });
  });

  isStreaming = true;
  goLiveBtn.innerHTML = `<span class="material-symbols-outlined">stop_circle</span> END`;
  goLiveBtn.classList.add("end");
  liveBadge.classList.add("active");
  window.startChatListener();
  startStats(); startTimer();
  updateConnStatus("connected");

  // If voice mode, join voice mesh as host too
  if (roomMode === "voice") {
    await joinVoiceMesh();
    showToast("🔴 Live with Voice! Waiting for participants...");
  } else {
    showToast("🔴 Live! Waiting for viewers...");
  }
};

/* ══════════════════════════════════════════════
   JOIN STREAM (Viewer)
   ══════════════════════════════════════════════ */
window.joinStream = async () => {
  roomId = document.getElementById("roomId").value.trim();
  if (!roomId) return alert("Enter a Room Code first");

  const roomSnap = await get(ref(db, `rooms/${roomId}`));
  if (!roomSnap.exists()) return alert("Room not found. Make sure host has started.");

  const roomData = roomSnap.val();
  roomMode = roomData.mode || "watch";
  const maxVoice = roomData.maxVoiceParticipants || 5;

  if (roomMode === "voice" && roomData.voiceSettings) {
    voiceSettings.videoRes = roomData.voiceSettings.videoRes || "720p";
    voiceSettings.videoBitrate = roomData.voiceSettings.videoBitrate || 1;
    voiceSettings.maxParticipants = maxVoice;
  }

  isHost = false;
  const myViewerId = "v_" + Math.random().toString(36).substr(2, 9);
  localStream = new MediaStream();
  remoteStream = new MediaStream();
  if (remoteVideo) {
    remoteVideo.srcObject = remoteStream;
    remoteVideo.muted = false;
  }

  // JOIN SCREEN SHARE (PC #1 as viewer)
  const pc = createViewerScreenPC();
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
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await set(ref(db, `rooms/${roomId}/viewers/${myViewerId}/answer`), {
      type: answer.type,
      sdp: answer.sdp
    });
  });

  onChildAdded(offerCandidates, async candSnap => {
    try { await pc.addIceCandidate(new RTCIceCandidate(candSnap.val())); } catch (_) {}
  });

  updateConnStatus("connecting");
  noSignal.classList.add("hidden");
  window.startChatListener();

  // Hide host-only buttons
  document.getElementById("btnScreen").style.display = "none";
  goLiveBtn.style.display = "none";

  // If VOICE mode: join voice mesh too
  if (roomMode === "voice") {
    // Check if room is full
    const membersSnap = await get(ref(db, `rooms/${roomId}/voiceMembers`));
    const currentMembers = membersSnap.exists() ? Object.keys(membersSnap.val()).length : 0;

    if (currentMembers >= maxVoice) {
      showToast("🚫 Voice room is full! Joining as watch-only viewer.");
      // Still connected to screen share, just no voice
    } else {
      await joinVoiceMesh();
    }
  } else {
    // Watch-only: no voice controls needed
    document.getElementById("modeBadge").style.display = "flex";
    document.getElementById("modeBadgeText").textContent = "Watch Only";
  }
};

/* ══════════════════════════════════════════════
   TOGGLE LIVE
   ══════════════════════════════════════════════ */
window.toggleStream = async () => {
  if (!isStreaming) await window.openModeModal();
  else await window.leaveCall();
};

/* ══════════════════════════════════════════════
   MIC TOGGLE (Voice Mode)
   ══════════════════════════════════════════════ */
window.toggleMic = () => {
  if (!localVoiceStream) return showToast("⚠️ No voice stream active");
  const tracks = localVoiceStream.getAudioTracks();
  if (!tracks.length) return showToast("⚠️ No mic found");

  micEnabled = !micEnabled;
  tracks.forEach(t => t.enabled = micEnabled);

  const btn = document.getElementById("btnMic");
  const icon = btn.querySelector(".material-symbols-outlined");
  if (micEnabled) {
    btn.classList.remove("off");
    icon.textContent = "mic";
  } else {
    btn.classList.add("off");
    icon.textContent = "mic_off";
  }

  // Update local tile mic indicator
  const localMicIcon = document.getElementById("localTileMic");
  if (localMicIcon) {
    localMicIcon.textContent = micEnabled ? "mic" : "mic_off";
    localMicIcon.classList.toggle("muted", !micEnabled);
  }
};

/* ══════════════════════════════════════════════
   CAMERA TOGGLE (Voice Mode)
   ══════════════════════════════════════════════ */
window.toggleCam = () => {
  if (!localVoiceStream) return;
  const tracks = localVoiceStream.getVideoTracks();
  if (!tracks.length) return showToast("⚠️ No camera found");

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

  // Update local tile — show/hide video
  const localTile = document.getElementById("tile_local");
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

/* ══════════════════════════════════════════════
   SCREEN SHARE (Host Only, in-call)
   ══════════════════════════════════════════════ */
window.startScreenShare = async () => {
  if (!isHost) return showToast("⚠️ Only host can share screen");
  showToast("📺 Screen is already being shared");
};

/* ══════════════════════════════════════════════
   LEAVE CALL
   ══════════════════════════════════════════════ */
window.leaveCall = async () => {
  stopStats(); stopTimer();

  // Close all screen share PCs
  Object.values(screenPcMap).forEach(p => { try { p.close(); } catch (_) {} });
  screenPcMap = {};

  // Close all voice PCs
  Object.values(voicePcMap).forEach(entry => {
    if (entry.pc) try { entry.pc.close(); } catch (_) {}
    if (entry.audioEl) { entry.audioEl.pause(); entry.audioEl.srcObject = null; }
  });
  voicePcMap = {};

  // Stop local streams
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (localVoiceStream) localVoiceStream.getTracks().forEach(t => t.stop());

  // Clean up Firebase
  if (roomId && isHost) {
    await remove(ref(db, "rooms/" + roomId));
  } else if (roomId && myVoiceId) {
    await remove(ref(db, `rooms/${roomId}/voiceMembers/${myVoiceId}`));
  }

  // Reset UI
  isStreaming = false; isScreenSharing = false;
  document.body.classList.remove("voice-mode");
  noSignal.classList.remove("hidden");
  liveBadge.classList.remove("active");
  document.getElementById("modeBadge").style.display = "none";
  document.getElementById("participantsGrid").classList.remove("active");
  document.getElementById("gridTiles").innerHTML = "";
  document.getElementById("voiceVolumeRow").style.display = "none";
  goLiveBtn.innerHTML = `<span class="material-symbols-outlined">podcasts</span> Go Live`;
  goLiveBtn.classList.remove("end");
  goLiveBtn.style.display = "";
  updateConnStatus("disconnected");
  clearStats();

  // Stop background audio
  if (bgAudio) { bgAudio.pause(); bgAudio.srcObject = null; }

  showToast("👋 Session ended");
  setTimeout(() => location.reload(), 1500);
};

/* ══════════════════════════════════════════════
   BACKGROUND AUDIO PLAYBACK
   Uses hidden <audio> element + Media Session API
   ══════════════════════════════════════════════ */
function setupBackgroundAudio(stream) {
  if (!stream) return;

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return;

  // Create a separate audio stream for background playback
  const audioOnly = new MediaStream(audioTracks);
  bgAudio.srcObject = audioOnly;
  bgAudio.volume = remoteVideo.volume;
  bgAudio.play().catch(() => {});

  // Media Session API — tells OS that we're playing media
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Watch Party — Live Stream",
      artist: "Room: " + (roomId || "Unknown"),
      album: "Live Party",
      artwork: [
        { src: "icon.png", sizes: "192x192", type: "image/png" },
        { src: "icon.png", sizes: "512x512", type: "image/png" }
      ]
    });

    navigator.mediaSession.setActionHandler("play", () => {
      remoteVideo.play().catch(() => {});
      bgAudio.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      // Don't actually pause — keep audio playing
      bgAudio.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("stop", null);
    navigator.mediaSession.playbackState = "playing";
  }

  // Screen Wake Lock — prevent screen from sleeping
  requestWakeLock();
}

async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      let wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        console.log("[WakeLock] Released");
      });
      // Re-acquire if page becomes visible again
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible" && isStreaming) {
          try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
        }
      });
      console.log("[WakeLock] Acquired");
    } catch (e) {
      console.warn("[WakeLock] Failed:", e);
    }
  }
}

/* ══════════════════════════════════════════════
   QUALITY MODAL (Screen Share)
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
  const activePc = Object.values(screenPcMap)[0];
  if (!activePc) return;
  const stats = await activePc.getStats();
  let bytesSent = 0, bytesReceived = 0, fps = 0, w = 0, h = 0, lost = 0, rtt = 0, codec = "—";

  stats.forEach(r => {
    if (r.type === "outbound-rtp" && r.kind === "video") {
      bytesSent = r.bytesSent || 0; fps = r.framesPerSecond || 0;
      w = r.frameWidth || 0; h = r.frameHeight || 0; lost = r.packetsLost || 0;
    }
    if (r.type === "inbound-rtp" && r.kind === "video") {
      bytesReceived = r.bytesReceived || 0; fps = r.framesPerSecond || 0;
      w = r.frameWidth || 0; h = r.frameHeight || 0; lost = r.packetsLost || 0;
    }
    if (r.type === "candidate-pair" && r.state === "succeeded")
      rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
    if (r.type === "codec" && r.mimeType?.includes("video"))
      codec = r.mimeType.split("/")[1];
  });

  const bytes = isHost ? bytesSent : bytesReceived;
  if (getStats._prev !== undefined) {
    const mbps = ((bytes - getStats._prev) * 8 / 1_000_000).toFixed(2);
    document.getElementById("statBitrate").innerHTML = `${mbps}<span class="stat-unit">Mbps</span>`;
    document.getElementById("barBitrate").style.width = Math.min(parseFloat(mbps) / (qualitySettings.bitrate + 2) * 100, 100) + "%";
  }
  getStats._prev = bytes;
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
  const senderName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "Viewer_" + Math.floor(Math.random() * 1000);

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

    const timeStr = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const safeSender = data.sender.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeText = data.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    msgEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-end;">
        <span style="font-weight:600; color: ${isMe ? '#8ab4f8' : '#e8eaed'};">${safeSender}</span>
        <span style="font-size:10px; color:#9aa0a6;">${timeStr}</span>
      </div>
      <div style="background: ${isMe ? 'rgba(138, 180, 248, 0.15)' : '#3c4043'}; padding: 8px 12px; border-radius: ${isMe ? '12px 12px 4px 12px' : '4px 12px 12px 12px'}; line-height: 1.4; color: #e8eaed; word-break: break-word;">
        ${safeText}
      </div>
    `;

    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
};

/* ══════════════════════════════════════════════
   PWA SERVICE WORKER REGISTRATION
   ══════════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(e => {
    console.warn("SW registration failed:", e);
  });
}