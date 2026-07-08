"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { startRoomConnection } from "./roomConnection";
import { auth, db } from "../../../lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { ref, push } from "firebase/database";
import CloudStickers from "../../../components/CloudStickers";

function StickerPickerOverlay({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [uid, setUid] = useState("");

  useEffect(() => {
    try {
      const profile = JSON.parse(localStorage.getItem("nova_user_profile") || "null");
      if (profile?.uid) setUid(profile.uid);
    } catch {}
    (window as any).toggleStickerPicker = () => setOpen((o) => !o);
    return () => { delete (window as any).toggleStickerPicker; };
  }, []);

  const sendSticker = (url: string) => {
    const sender =
      (document.getElementById("userName") as HTMLInputElement)?.value.trim() ||
      localStorage.getItem("watchparty_name") ||
      "Viewer";
    push(ref(db, `rooms/${roomId}/chat`), { sender, sticker: url, time: Date.now() });
    setOpen(false);
  };

  if (!open) return null;
  return (
    <div className="stk-overlay">
      <div className="stk-overlay-header">
        <span><span className="material-symbols-outlined" style={{ fontSize: "18px", verticalAlign: "-4px" }}>emoji_emotions</span> Stickers</span>
        <button onClick={() => setOpen(false)}><span className="material-symbols-outlined">close</span></button>
      </div>
      {uid ? (
        <CloudStickers uid={uid} mode="picker" onSelect={sendSticker} />
      ) : (
        <div className="stk-empty"><p>Sign in to use cloud stickers.</p></div>
      )}
    </div>
  );
}

export default function RoomPage({ params: paramsPromise }: { params: Promise<{ roomId: string }> }) {
  const router = useRouter();
  const params = use(paramsPromise);
  const roomId = params.roomId;
  
  const [role, setRole] = useState("viewer");
  const [loading, setLoading] = useState(true);
  
  const PROFILE_KEY = "nova_user_profile";

  useEffect(() => {
    // Verify auth
    const localProfile = localStorage.getItem(PROFILE_KEY);
    console.log(">>> [Room Page] Initial localProfile:", localProfile);
    if (!localProfile) {
      console.log(">>> [Room Page] No local profile, redirecting to login...");
      router.push(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      console.log(">>> [Room Page] onAuthStateChanged user:", user ? user.uid : "null");
      if (user) {
        // Read role query param
        const search = new URLSearchParams(window.location.search);
        const queryRole = search.get("role") || "viewer";
        setRole(queryRole);
        setLoading(false);
      } else {
        // Only redirect if there is no localProfile (e.g. user manually logged out)
        const currentProfile = localStorage.getItem(PROFILE_KEY);
        console.log(">>> [Room Page] Auth null, currentProfile:", currentProfile);
        if (!currentProfile) {
          console.log(">>> [Room Page] No current profile, redirecting to login...");
          router.push(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        }
      }
    });

    return () => unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!loading && roomId) {
      // Start the Room Connection once DOM elements are mounted
      // Allow DOM to settle for a tick
      const timer = setTimeout(() => {
        startRoomConnection(roomId, role);
      }, 100);

      // Global leave handler — cleans up the WebRTC session, then returns to dashboard
      (window as any).leaveRoom = async () => {
        try { await (window as any).leaveCall?.(); } catch {}
        router.push("/");
      };

      return () => {
        clearTimeout(timer);
        delete (window as any).leaveRoom;
      };
    }
  }, [loading, roomId, role, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#030408] text-white">
        <div className="text-center">
          <span className="material-symbols-outlined text-4xl animate-spin text-[#10b981]">autorenew</span>
          <p className="mt-2 text-sm text-[#94a3b8]">Loading Room Session...</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <StickerPickerOverlay roomId={roomId} />
    <div
      className="room-container-wrapper"
      style={{ width: "100%", height: "100vh" }}
      dangerouslySetInnerHTML={{
        __html: `<audio id="silenceLoop" loop playsinline></audio>
<div class="app-layout">
    <div class="main-col">
      <!-- Info Bar Above Video -->
      <div class="video-info-bar">
        <div class="badge-row">
          <div class="badge"><span class="dot" id="connDot"></span><span id="connLabel">DISCONNECTED</span></div>
          <div class="badge" id="liveBadge" style="display:none;"><span class="dot live"></span>LIVE</div>
        </div>
        
        <!-- Mood display (shows current mood in header) -->
        <div id="moodBar" style="display:none; padding:4px 8px; font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
          <span id="moodEmoji">🎬</span> <span id="moodLabel" style="font-weight:600;">Movie Night</span>
        </div>

        <div class="overlay-tags">
          <span class="overlay-tag" id="sourceTag" style="display:none;">—</span>
          <span class="overlay-tag" id="qualityTag" style="display:none;">—</span>
        </div>

        <button class="leave-room-btn" onclick="window.leaveRoom && window.leaveRoom()" title="Leave Room">
          <span class="material-symbols-outlined">logout</span>
          Leave
        </button>
      </div>

      <div class="video-wrap" id="videoWrap" style="background:transparent !important; overflow:visible;">
        <canvas id="ambientCanvas" class="ambient-glow-layer"></canvas>
        <video id="remoteVideo" autoplay playsinline muted style="z-index:5; position:relative;"></video>
        <audio id="bgAudio" playsinline loop></audio>

        <!-- YouTube Player Container -->
        <div id="ytPlayerContainer" style="display:none; width:100%; height:100%; position:relative; z-index:6; min-height:360px; border-radius:20px; overflow:hidden; background:#000;">
          <div id="ytPlayer" style="width:100%; height:100%;"></div>
        </div>

        <!-- Wait Overlay (When screen share paused) -->
        <div id="waitOverlay" style="display:none; position:absolute; inset:0; background:rgba(13,10,20,0.85); backdrop-filter:blur(10px); z-index:5; flex-direction:column; align-items:center; justify-content:center; color:#F5E6EF; text-align:center;">
          <span class="material-symbols-outlined" style="font-size:48px; margin-bottom:10px; color:var(--accent); animation:heartPop 2s infinite;">hourglass_empty</span>
          <div style="font-size:18px; font-weight:600; letter-spacing:0.5px;" id="waitOverlayTitle">Waiting for Host</div>
          <div style="font-size:13px; color:rgba(245,230,239,0.6); margin-top:6px;" id="waitOverlaySub">Host has paused screen sharing. Stay tuned.</div>
        </div>

        <!-- Drawing Canvas -->
        <canvas id="drawCanvas"></canvas>

        <!-- Drawing Toolbar -->
        <div id="drawToolbar">
          <button class="draw-btn active" id="drawToggleBtn" onclick="toggleDraw()" title="Draw">✏️</button>
          <div class="draw-btn" style="cursor:default;padding:4px;gap:4px;height:auto;flex-direction:column;">
            <div class="draw-color" style="background:#C94B7B;" onclick="setDrawColor('#C94B7B')"></div>
            <div class="draw-color" style="background:#7C3AED;" onclick="setDrawColor('#7C3AED')"></div>
            <div class="draw-color" style="background:#F472B6;" onclick="setDrawColor('#F472B6')"></div>
            <div class="draw-color" style="background:#fff;" onclick="setDrawColor('#ffffff')"></div>
            <label style="cursor:pointer;" title="Custom Color">
              <input type="color" onchange="window.setDrawColor(this.value);" style="width:20px;height:20px;border:none;padding:0;background:none;cursor:pointer;">
            </label>
          </div>
          <button class="draw-btn" onclick="clearDrawCanvas()" title="Clear">🗑️</button>
        </div>

        <!-- No Signal State -->
        <div class="no-signal" id="noSignal" style="background:rgba(15,12,22,0.4); backdrop-filter:blur(10px); border-radius:20px;">
          <div class="ns-icon"><span class="material-symbols-outlined">movie</span></div>
          <h3>Waiting for Screen Share</h3>
          <p>Start a session to watch together ❤️</p>
        </div>



        <!-- Autoplay Recovery Overlay -->
        <div id="autoplayOverlay" onclick="recoverAutoplay()">
          <span class="material-symbols-outlined" style="font-size:52px;color:var(--accent);filter:drop-shadow(0 0 20px rgba(201,75,123,0.5));">play_circle</span>
          <h3>Tap to Unmute & Play</h3>
        </div>


        <div class="video-btns">
          <!-- Popup Menu -->
          <div id="nonFsPopup" class="non-fs-popup">
             <!-- QUICK NO-HEAT (IN POPUP) -->
             <button class="vbtn" id="noHeatBtnQuick" onclick="document.getElementById('noHeatToggle').click()" title="Toggle No Heat" style="border-color:#339933; background:rgba(51,153,51,0.1) !important;">
               <span class="material-symbols-outlined" style="color:#339933;">bolt</span>
             </button>
             <button class="vbtn" id="changeScreenBtn" onclick="window.replaceScreenShareBtn()" style="display:none;" title="Change Screen"><span class="material-symbols-outlined">screen_share</span></button>
            <button class="vbtn" onclick="toggleFullscreen()" title="Fullscreen"><span class="material-symbols-outlined">fullscreen</span></button>
            <button class="vbtn" onclick="togglePip()" title="Picture-in-Picture"><span class="material-symbols-outlined">picture_in_picture</span></button>
            <button class="vbtn" id="refreshBtn" onclick="manualResync()" style="display:none;" title="Refresh Stream"><span class="material-symbols-outlined">refresh</span></button>
            <!-- Resolution Select (Main) -->
            <select id="quickResSelect" class="vbtn" style="display:none; width:42px; padding:0; font-size:9px;" onchange="document.getElementById('scrResS').value=this.value; window.replaceScreenShareBtn()">
               <option value="2160p">4K</option><option value="1440p">2K</option><option value="1080p" selected>1080</option><option value="720p">720</option>
            </select>
            <button class="vbtn" id="drawToggleToolbar" onclick="toggleDrawToolbar()" style="display:none;" title="Draw Tool"><span class="material-symbols-outlined">draw</span></button>
            <button class="vbtn" id="shareScreenBtn" onclick="window.startScreenShare()" title="Share Screen" style="display:none;"><span class="material-symbols-outlined">screen_share</span></button>
            <button class="vbtn" id="micBtnMain" onclick="toggleVoiceChat()" title="Toggle Microphone" style="background:rgba(239,68,68,0.2);border-color:rgba(239,68,68,0.3)"><span class="material-symbols-outlined" id="micIconMain">mic_off</span></button>
          </div>

          <!-- Main Screen Quick No Heat -->
          <button class="vbtn" id="noHeatBtnMain" onclick="document.getElementById('noHeatToggle').click()" style="background:#000 !important; border:1px solid #339933 !important; animation: micPulse 2s infinite;" title="No Heat Mode">
            <span class="material-symbols-outlined" style="color:#339933; font-size:20px;">bolt</span>
          </button>
          
          <!-- Trigger Button -->
          <button class="vbtn" id="nonFsTrigger" onclick="toggleNonFsPopup()" style="background:rgba(15,12,22,0.9) !important; border:1px solid rgba(255,255,255,0.1) !important; box-shadow:none !important;"><span class="material-symbols-outlined" style="opacity:0.6;">apps</span></button>
        </div>

          <!-- FULLSCREEN ONLY: LEFT POPUP -->
          <div class="fs-mob-left">
            <div id="mobSessionMenu" class="mob-menu-expand">
               <button class="vbtn" onclick="toggleFullscreen()"><span class="material-symbols-outlined">fullscreen_exit</span></button>
               <button class="vbtn" onclick="togglePip()"><span class="material-symbols-outlined">picture_in_picture</span></button>
               <button class="vbtn" onclick="manualResync()"><span class="material-symbols-outlined">refresh</span></button>
               <select id="quickResSelectFS" class="vbtn" style="width:38px; padding:0; font-size:9px;" onchange="document.getElementById('scrResS').value=this.value; window.replaceScreenShareBtn()">
                  <option value="2160p">4K</option><option value="1440p">2K</option><option value="1080p" selected>1080</option><option value="720p">720</option>
               </select>
               <button class="vbtn" id="drawToggleToolbarFS" onclick="toggleDrawToolbar()"><span class="material-symbols-outlined">draw</span></button>
               <button class="vbtn" id="fsMicBtn" onclick="toggleVoiceChat()"><span class="material-symbols-outlined">mic</span></button>
            </div>
            <button class="vbtn" id="mobNavToggle" onclick="window.toggleMobControls()" style="background:var(--accent); color:#fff; border:none; box-shadow:0 4px 15px var(--accent-glow);">
               <span class="material-symbols-outlined">widgets</span>
            </button>
          </div>

          <!-- FULLSCREEN ONLY: RIGHT INTERACTION STACK -->
          <div class="fs-mob-right">
             <!-- Reactions -->
             <div style="position:relative;">
               <div id="fsReactMenu" class="fs-popup-menu" style="display:none; position:absolute; bottom:130%; right:0; padding:10px; flex-wrap:wrap; width:180px; gap:8px;">
                 <button class="emj-btn" onclick="sendReaction('❤️')">❤️</button><button class="emj-btn" onclick="sendReaction('😂')">😂</button><button class="emj-btn" onclick="sendReaction('👍')">👍</button><button class="emj-btn" onclick="sendReaction('😮')">😮</button><button class="emj-btn" onclick="sendReaction('🔥')">🔥</button><button class="emj-btn" onclick="sendReaction('💀')">💀</button>
               </div>
               <button class="vbtn" onclick="window.toggleFsMenu('fsReactMenu')" style="background:rgba(201,75,123,0.3); border-color:rgba(201,75,123,0.5);"><span class="material-symbols-outlined">add_reaction</span></button>
             </div>
             <!-- Chat -->
             <div style="position:relative;">
              <div id="fsChatBox" class="fs-popup-menu" style="display:none; position:absolute; bottom:140%; right:0; width:320px; max-width:85vw; flex-direction:column; background:rgba(15,12,22,0.9); backdrop-filter:blur(25px); border:1px solid rgba(201,75,123,0.3); border-radius:30px; box-shadow:0 15px 50px rgba(0,0,0,0.6); overflow:hidden; transform-origin:bottom right;">
                  <div id="fsChatMessages" style="flex:1; overflow-y:auto; padding:15px; display:flex; flex-direction:column; gap:10px; max-height:300px; scrollbar-width:none;"></div>
                  <div id="fsChatTypingStatus" class="typing-status" hidden></div>
                  <div style="display:flex; padding:12px; background:rgba(255,255,255,0.03); border-top:1px solid rgba(255,255,255,0.08); align-items:center; gap:10px;">
                    <input type="file" id="fsChatInputFile" accept="image/*" style="display:none;" onchange="window.handleChatImageUpload(this)">
                    <button onclick="document.getElementById('fsChatInputFile').click()" style="background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer;"><span class="material-symbols-outlined" style="font-size:20px;">image</span></button>
                    <button onclick="window.toggleStickerPicker && window.toggleStickerPicker()" style="background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer;" title="Cloud Stickers"><span class="material-symbols-outlined" style="font-size:20px;">emoji_emotions</span></button>
                    <textarea id="fsChatInput" placeholder="Type a message..." rows="1" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:20px; color:#fff; flex:1; font-size:13px; padding:10px 15px; outline:none; resize:none; font-family:inherit;" onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault(); window.sendChatFs();}"></textarea>
                    <button onclick="window.sendChatFs()" style="width:40px; height:40px; border-radius:50%; background:var(--accent); border:none; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:0.2s;"><span class="material-symbols-outlined" style="font-size:18px;">send</span></button>
                  </div>
               </div>
               <button class="vbtn" id="fsChatBtn" onclick="window.toggleFsMenu('fsChatBox'); document.getElementById('fsChatInput').focus();" style="background:rgba(201,75,123,0.3); border-color:rgba(201,75,123,0.5);">
                 <span class="material-symbols-outlined">chat</span>
                 <span id="fsChatBadge" style="display:none; position:absolute; top:-2px; right:-2px; width:10px; height:10px; background:var(--accent); border-radius:50%; border:2px solid #000;"></span>
               </button>
             </div>
          </div>
        </div>


        <!-- Emoji Float Zone -->
        <div class="emoji-overlay" id="emojiOverlay"></div>
      </div>

      <!-- SIDE PANEL -->
      <div class="side-panel">
      <!-- Brand Header -->
      <div class="couple-header">
        <div class="couple-brand">
          <div class="couple-brand-icon"><span class="material-symbols-outlined">favorite</span></div>
          <span class="couple-brand-name">Nova</span>
        </div>
        <span class="couple-together-badge" id="togetherBadge">Watch Together ✨</span>
      </div>

      <!-- Tabs -->
      <div class="panel-tabs">
        <button class="panel-tab active" onclick="window.switchTab('chat')" id="tabChat" style="position:relative;">Chat<span class="tab-badge" id="chatBadge" style="background:var(--accent);">!</span></button>
        <button class="panel-tab" onclick="window.switchTab('stats')" id="tabStats">Stats</button>
        <button class="panel-tab" onclick="window.switchTab('settings')" id="tabSettings">Settings</button>
        <button class="panel-tab" onclick="window.switchTab('people')" id="tabPeople" style="position:relative;">People<span class="tab-badge" id="peopleBadge">0</span></button>
      </div>

      <!-- CHAT TAB -->
      <div class="panel-content active" id="contentChat">
        <div class="chat-messages" id="chatMessages">
          <div style="text-align:center;color:var(--text-muted);margin-top:30px;font-size:11px;">💬 Messages visible to everyone</div>
        </div>
        <div id="chatTypingStatus" class="typing-status" hidden></div>
        <div class="chat-bottom-area">
          <div class="chat-emoji-bar" id="chatEmojiBar">
            <button class="emj-btn" onclick="sendReaction('❤️')">❤️</button>
            <button class="emj-btn" onclick="sendReaction('🎉')">🎉</button>
            <button class="emj-btn" onclick="sendReaction('😂')">😂</button>
            <button class="emj-btn" onclick="sendReaction('👍')">👍</button>
            <button class="emj-btn" onclick="sendReaction('😍')">😍</button>
            <button class="emj-btn" onclick="sendReaction('🔥')">🔥</button>
            <button class="emj-btn" onclick="sendReaction('👏')">👏</button>
            <button class="emj-btn" onclick="sendReaction('💕')">💕</button>
            <button class="emj-btn" onclick="sendReaction('🍿')">🍿</button>
            <button class="emj-btn" onclick="sendReaction('😮')">😮</button>
            <button class="emj-btn" onclick="sendReaction('💀')">💀</button>
            <button class="emj-btn" onclick="sendReaction('✨')">✨</button>
            <button class="emj-btn add-emj-btn" onclick="window.addCustomReaction()" style="background:var(--surface);border-radius:50%;font-size:16px;" title="Add Custom Emoji">+</button>
          </div>
          <div class="chat-bottom">
            <button class="chat-attach" id="emojiToggleBtn"
              onclick="document.getElementById('chatEmojiBar').classList.toggle('open'); this.children[0].textContent = document.getElementById('chatEmojiBar').classList.contains('open') ? 'keyboard_arrow_down' : 'add_reaction';">
              <span class="material-symbols-outlined" style="font-size:18px;">add_reaction</span>
            </button>
            <button class="chat-attach" onclick="document.getElementById('chatFileInput').click()">
              <span class="material-symbols-outlined" style="font-size:18px;">image</span>
            </button>
            <button class="chat-attach" onclick="window.toggleStickerPicker && window.toggleStickerPicker()" title="Cloud Stickers">
              <span class="material-symbols-outlined" style="font-size:18px;">emoji_emotions</span>
            </button>
            <button class="chat-attach" id="micBtnChat" onclick="toggleVoiceChat()" title="Voice Chat">
              <span class="material-symbols-outlined" id="micIconChat" style="font-size:18px;color:rgba(239,68,68,0.7);">mic_off</span>
            </button>
            <textarea class="chat-input" id="chatInput" placeholder="Say something... 💬" rows="1" style="resize:none; padding-top:10px; border-radius:20px; overflow-y:auto;" oninput="this.style.height='';this.style.height=Math.min(this.scrollHeight, 100)+'px';" onkeypress="if(event.key==='Enter' && !event.shiftKey && window.innerWidth>768){event.preventDefault();window.sendChat();}"></textarea>
            <button class="chat-send" onclick="sendChat()" style="margin-right:10px;"><span class="material-symbols-outlined" style="font-size:17px;">send</span></button>
            <input type="file" id="chatFileInput" accept="image/*" style="display:none" onchange="window.handleChatImageUpload(this)">
          </div>
        </div>
      </div>

      <!-- STATS TAB -->
      <div class="panel-content" id="contentStats">
        <div class="stats-wrap">
          <!-- Connection Health -->
          <div class="conn-health-card">
            <div class="conn-health-label">Connection Health</div>
            <div class="conn-health-bar-wrap"><div class="conn-health-bar" id="connHealthBar"></div></div>
            <div class="conn-health-text" id="connHealthText">Waiting for signal...</div>
          </div>
          <!-- Stat Grid -->
          <div class="stat-grid">
            <div class="stat-card">
              <div class="stat-label">Bitrate</div>
              <div class="stat-value" id="statBitrate">—</div>
              <div class="bar-track"><div class="bar-fill" id="barBitrate" style="width:0%"></div></div>
            </div>
            <div class="stat-card">
              <div class="stat-label">FPS</div>
              <div class="stat-value" id="statFps">—</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Resolution</div>
              <div class="stat-value" id="statRes">—</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Latency</div>
              <div class="stat-value" id="statRtt">—</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Codec</div>
              <div class="stat-value" id="statCodec">—</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Packet Loss</div>
              <div class="stat-value" id="statLoss">—</div>
            </div>
            <div class="stat-card" style="grid-column:1/-1;">
              <div class="stat-label">Duration Together</div>
              <div class="stat-value" id="statDuration">00:00:00</div>
            </div>
          </div>
          <!-- Diagnostic Log -->
          <div class="stat-card" style="background:rgba(0,0,0,0.2);border-style:dashed;">
            <div class="stat-label" style="display:flex;justify-content:space-between;align-items:center;">
              Debug Log
              <button onclick="document.getElementById('connLog').textContent='-- Log Reset --';" style="background:none;border:none;color:var(--accent);font-size:9px;cursor:pointer;">Clear</button>
            </div>
            <div id="connLog" style="font-size:10px;font-family:monospace;color:var(--text-muted);margin-top:8px;line-height:1.4;max-height:120px;overflow-y:auto;word-break:break-all;padding:4px;">
              -- Waiting for connection --
            </div>
          </div>
        </div>
      </div>

      <!-- SETTINGS TAB -->
      <div class="panel-content" id="contentSettings">
        <div class="settings-wrap">
          <!-- Connection -->
          <div>
            <div class="section-title">Connection</div>
            <div class="form-group"><label>Your Name</label><input class="form-input" id="userName" placeholder="Enter your name" spellcheck="false" /></div>
            <div class="form-group"><label>Room Code</label>
              <div style="display:flex;gap:6px;">
                <input class="form-input" id="roomId" placeholder="Enter room code" maxlength="12" spellcheck="false" style="flex:1;" />
                <button class="btn-action" onclick="generateRoom()" style="width:42px;padding:0;flex-shrink:0;"><span class="material-symbols-outlined">autorenew</span></button>
              </div>
            </div>
            <div class="form-group" style="margin-top:10px;">
              <label style="display:flex; align-items:center; gap:10px; cursor:pointer;" title="Mute incoming reaction sounds">
                <input type="checkbox" id="muteReactionsToggle" style="width:16px;height:16px;accent-color:var(--accent);">
                <span style="font-size:13px; font-weight:400;">Mute Reaction Sounds</span>
              </label>
            </div>
            <div class="form-group" id="lowDataGroup">
              <input type="checkbox" id="lowDataMode" style="width:16px;height:16px;cursor:pointer;" onchange="showToast(this.checked?'📉 Low Data Mode ON':'📉 Low Data Mode OFF')" />
              <label for="lowDataMode" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text);">Low Data Mode</label>
            </div>
            <div style="background:rgba(51, 153, 51, 0.1); border:1px solid rgba(51, 153, 51, 0.3); padding:10px; border-radius:12px; margin-top:10px; display:flex; align-items:center; justify-content:space-between; cursor:pointer;" onclick="document.getElementById('noHeatToggle').click()">
              <div style="display:flex; flex-direction:column;">
                <span style="font-size:12px; font-weight:700; color:#339933;">🚀 No Heat Mode</span>
                <small style="font-size:9px; color:var(--text-muted);">Save battery & boost speed</small>
              </div>
              <input type="checkbox" id="noHeatToggle" style="width:18px; height:18px; cursor:pointer;" onchange="toggleNoHeat(this.checked)" onclick="event.stopPropagation()" />
            </div>
          </div>

          <!-- Viewer Host Info -->
          <div id="viewerHostSettings">
            <div class="section-title">Host's Stream Settings</div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--text-muted)">Quality:</span><span id="vhsQuality" style="font-weight:600">—</span></div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--text-muted)">FPS:</span><span id="vhsFps" style="font-weight:600">—</span></div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span style="color:var(--text-muted)">Bitrate:</span><span id="vhsBitrate" style="font-weight:600">—</span></div>
            <div style="display:flex;justify-content:space-between;font-size:12px;"><span style="color:var(--text-muted)">Buffer:</span><span id="vhsDelay" style="font-weight:600">—</span></div>
          </div>

          <!-- HOST ONLY SETTINGS -->
          <div id="hostOnlySettings">
            <div class="section-title host-controls-header">
              Host Controls
              <div class="host-mini-btns">
                <button class="host-mini-btn mute-all" onclick="window.muteAllViewers()">Mute All</button>
              </div>
            </div>
            <!-- Always-visible Change Screen button -->
            <button class="btn-action" id="changeScreenBtn" onclick="window.replaceScreenShareBtn()" style="display:none; height:36px;font-size:12px;background:rgba(124,58,237,0.1);color:var(--accent2);border-color:rgba(124,58,237,0.35);margin-bottom:10px;width:100%;">
              <span class="material-symbols-outlined" style="font-size:16px;">screen_share</span> Change Screen
            </button>
            <div class="form-row">
              <div class="form-group"><label>Quality</label>
                <select class="form-select" id="scrResS" onchange="document.getElementById('scrRes').value=this.value;">
                  <option value="2160p">4K (2160p)</option>
                  <option value="1440p">2K (1440p)</option>
                  <option value="1080p" selected>1080p</option>
                  <option value="720p">720p</option>
                  <option value="480p">480p</option>
                  <option value="360p">360p</option>
                  <option value="240p">240p</option>
                  <option value="144p">144p</option>
                </select>
              </div>
              <div class="form-group"><label>FPS</label>
                <select class="form-select" id="scrFpsS" onchange="document.getElementById('scrFps').value=this.value;">
                  <option value="60">60 fps</option>
                  <option value="30" selected>30 fps</option>
                  <option value="24">24 fps</option>
                </select>
              </div>
            </div>
            <div class="form-group"><label>Video Codec (RTX 4060 🚀)</label>
              <select class="form-select" id="prefCodecS" onchange="document.getElementById('preferredCodec').value=this.value; applyBitrateNow(); window.pushHostSettings();">
                <option value="av1">AV1 (Best Quality - RTX 40/Modern)</option>
                <option value="h265">H.265 (HEVC - High Efficiency)</option>
                <option value="vp9">VP9 (High Quality - Stable)</option>
                <option value="h264" selected>H.264 (Compatible - Default)</option>
              </select>
            </div>

            <!-- YOUTUBE HOST CONTROLS -->
            <div id="youtubeHostSettings" style="display:none; border-top:1px solid rgba(255,255,255,0.08); padding-top:14px; margin-top:14px;">
              <div class="section-title">📺 YouTube Sync Controls</div>
              <div class="form-group">
                <label>YouTube Link or Video ID</label>
                <div style="display:flex;gap:6px;">
                  <input class="form-input" id="ytUrlInput" placeholder="Paste YouTube link or ID" style="flex:1;" />
                  <button class="btn-action" onclick="window.changeYoutubeVideo && window.changeYoutubeVideo(document.getElementById('ytUrlInput').value)" style="width:70px;padding:0;font-size:12px;flex-shrink:0;">Load</button>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
                <button class="btn-action" onclick="window.playYoutubeForEveryone && window.playYoutubeForEveryone()" style="background:rgba(16,185,129,0.1);color:#10b981;border-color:rgba(16,185,129,0.3);"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">play_arrow</span> Play All</button>
                <button class="btn-action" onclick="window.pauseYoutubeForEveryone && window.pauseYoutubeForEveryone()" style="background:rgba(239,68,68,0.1);color:#ef4444;border-color:rgba(239,68,68,0.3);"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;">pause</span> Pause All</button>
              </div>
            </div>
          </div>
            <!-- Bitrate adjustment removed as requested -->
            <button class="btn-action" onclick="window.replaceScreenShareBtn();window.pushHostSettings();" style="height:34px;font-size:12px;background:rgba(201,75,123,0.12);color:var(--accent);border-color:rgba(201,75,123,0.3);margin:10px 0;">
              <span class="material-symbols-outlined" style="font-size:16px;">task_alt</span> Apply Settings
            </button>
            <div class="form-group">
              <label style="display:flex;justify-content:space-between;">Stream Buffer <span id="delayValLabel" style="color:#fbbf24;">0.05 s</span></label>
              <input type="range" class="styled-range" id="streamDelaySlider" min="0" max="2" value="0.05" step="0.1"
                oninput="document.getElementById('delayValLabel').textContent=this.value+' s';"
                onchange="window.pushHostSettings();" />
              <div style="font-size:9px;color:var(--text-muted);margin-top:4px;">Increase if others experience stuttering</div>
            </div>
          </div>

          <!-- Microphone -->
          <div>
            <div class="section-title">🎙️ Microphone</div>
            <div class="form-group">
              <label>Input Device</label>
              <select class="form-select" id="micSelect" onchange="window.refreshMicMeter()">
                <option value="">Default Microphone</option>
              </select>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <input type="checkbox" id="micEcho" checked style="width:14px;height:14px;cursor:pointer;" onchange="window.refreshMicMeter()" />
                <label for="micEcho" style="margin:0;font-size:11px;text-transform:none;">Echo Cancel</label>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <input type="checkbox" id="micNoise" checked style="width:14px;height:14px;cursor:pointer;" onchange="window.refreshMicMeter()" />
                <label for="micNoise" style="margin:0;font-size:11px;text-transform:none;">Noise Suppress</label>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <input type="checkbox" id="micAGC" checked style="width:14px;height:14px;cursor:pointer;" onchange="window.refreshMicMeter()" />
                <label for="micAGC" style="margin:0;font-size:11px;text-transform:none;">Auto Gain</label>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <div id="micMeter" style="flex:1;height:4px;background:rgba(201,75,123,0.15);border-radius:2px;overflow:hidden;">
                  <div id="micMeterFill" style="width:0%;height:100%;background:linear-gradient(90deg,var(--accent),var(--pink-soft));transition:width 0.1s;"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Volume -->
          <div>
            <div class="section-title">🔊 Volume</div>
            <div class="volume-row">
              <span class="material-symbols-outlined">volume_up</span>
              <label>Movie</label>
              <input type="range" id="movieVolume" min="0" max="100" value="100" oninput="setMovieVolume(this.value)" />
              <span class="vol-value" id="movieVolVal">100%</span>
            </div>
          </div>

          <!-- Actions -->
          <div>
            <div class="section-title">Actions</div>
            <div class="action-btns" id="actionBtns">
              <button class="btn-action host" onclick="confirmHost()"><span class="material-symbols-outlined">cast</span>Start Host Session</button>
              <button class="btn-action join" onclick="confirmJoin()"><span class="material-symbols-outlined">login</span>Join Watch Party</button>
            </div>
          </div>

          <!-- Share -->
          <div>
            <div class="section-title">Share</div>
            <button class="btn-action share" onclick="shareRoom()"><span class="material-symbols-outlined">share</span>Share Invite Link</button>
          </div>

        </div>
      </div>

      <!-- PEOPLE TAB -->
      <div class="panel-content" id="contentPeople">
        <div class="people-wrap" id="peopleList">
          <div class="ppl-empty">
            <span class="material-symbols-outlined">favorite_border</span>
            <p>No one yet</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast"></div>
<canvas id="colorExtractCanvas" width="16" height="9" style="display:none;"></canvas>`
      }}
    />
    </>
  );
}
