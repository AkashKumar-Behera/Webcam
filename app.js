/* LIVE PARTY v5.0 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.5.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, onChildAdded, remove, onDisconnect }
  from "https://www.gstatic.com/firebasejs/11.5.0/firebase-database.js";

const firebaseConfig = { apiKey:"AIzaSyBGnFw13ko0b4KAs7plpFmHlg0GohowElA", authDomain:"webrtc-cd5af.firebaseapp.com", databaseURL:"https://webrtc-cd5af-default-rtdb.asia-southeast1.firebasedatabase.app", projectId:"webrtc-cd5af" };
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

const servers = { iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:82.25.104.130:3478"},{urls:"turn:82.25.104.130:3478",username:"akash",credential:"hostinger_vps_123"},{urls:"turn:82.25.104.130:5349",username:"akash",credential:"hostinger_vps_123"},{urls:"turn:82.25.104.130:3478?transport=tcp",username:"akash",credential:"hostinger_vps_123"},{urls:"turn:82.25.104.130:5349?transport=tcp",username:"akash",credential:"hostinger_vps_123"}], iceCandidatePoolSize:2 };
const RES_MAP = { "4k":{width:3840,height:2160},"2k":{width:2560,height:1440},"1080p":{width:1920,height:1080},"720p":{width:1280,height:720} };

/* STATE */
let localStream=null, roomId="", isHost=false, myName="";
let screenPcMap={}, viewerPc=null;
let connectedViewers={}, pendingViewers={};
let statsInterval=null, timerInterval=null, startTime=0, prevBytesStat=0;
let firebaseUnsubs=[], bgAudioSet=false, iceRestartCount=0;
const MAX_ICE_RESTARTS=3;
const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function logIce(pc,label){ pc.onicegatheringstatechange=()=>console.log(`[ICE ${label}] gather:${pc.iceGatheringState}`); pc.oniceconnectionstatechange=()=>console.log(`[ICE ${label}] ice:${pc.iceConnectionState}`); }
function logCandidate(c,label){ if(!c)return; const t=c.candidate?.match(/typ (\w+)/)?.[1]||'?'; console.log(`[ICE ${label}] ${t}|${c.candidate?.substring(0,60)}`); }

/* HELPERS */
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function nameToHsl(n){ let h=0; for(const c of String(n)) h=c.charCodeAt(0)+((h<<5)-h); return `hsl(${Math.abs(h)%360},65%,48%)`; }

/* UI */
function showToast(msg){ const t=document.getElementById("toast"); if(!t)return; t.textContent=msg; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove("show"),3500); }

function addSystemMsg(text){ const c=document.getElementById("chatMessages"); if(!c)return; const el=document.createElement("div"); el.className="chat-system"; el.textContent=text; c.appendChild(el); c.scrollTop=c.scrollHeight; }

function addFloatingChatMsg(sender,text){
  const overlay=document.getElementById("fullscreenChatOverlay"); if(!overlay)return;
  if(!document.fullscreenElement&&!document.webkitFullscreenElement)return;
  const el=document.createElement("div"); el.className="fs-chat-msg";
  el.innerHTML=`<b>${esc(sender)}</b> ${esc(text)}`; overlay.appendChild(el);
  el.addEventListener("animationend",()=>el.remove(),{once:true});
}

window.shareRoom=()=>{ const r=document.getElementById("roomId")?.value.trim()||roomId; if(!r)return showToast("⚠️ Start a session first"); const url=`${location.origin}${location.pathname}?room=${encodeURIComponent(r)}`; if(navigator.share){navigator.share({title:"Join my Watch Party! 🍿",url}).catch(()=>{});}else{navigator.clipboard?.writeText(url).then(()=>showToast("🔗 Link copied!")).catch(()=>showToast(url));} };

function updateConnStatus(state){ const dot=document.getElementById("connDot"),label=document.getElementById("connLabel"); if(!dot||!label)return; dot.classList.remove("connected","connecting","live"); if(state==="connected"){dot.classList.add("connected");label.textContent="CONNECTED";}else if(state==="connecting"){dot.classList.add("connecting");label.textContent="CONNECTING...";}else{label.textContent="DISCONNECTED";} }

function changeActionBtns(mode){ const c=document.getElementById("actionBtns"); if(!c)return; if(mode==="session"){ c.innerHTML=`<button class="btn-action end" onclick="leaveCall()"><span class="material-symbols-outlined">stop_circle</span> Leave Session</button>`; }else{ c.innerHTML=`<button class="btn-action host" onclick="confirmHost()"><span class="material-symbols-outlined">cast</span> Start Host Session</button><button class="btn-action join" onclick="confirmJoin()"><span class="material-symbols-outlined">login</span> Join Watch Party</button>`; } }

/* PEOPLE TAB */
function renderPeopleTab(){
  const c=document.getElementById("peopleList"); if(!c)return;
  let html="";
  const pending=Object.entries(pendingViewers);
  if(isHost&&pending.length>0){ html+=`<div class="ppl-section">⏳ Waiting to Join</div>`; for(const[vid,d]of pending){ const col=nameToHsl(d.name); html+=`<div class="ppl-item pending-item"><div class="ppl-av" style="background:${col}">${d.name[0].toUpperCase()}</div><div class="ppl-name">${esc(d.name)}</div><div class="ppl-btns"><button class="pa-btn approve" onclick="approveViewer('${vid}','${esc(d.name)}')"><span class="material-symbols-outlined">check</span></button><button class="pa-btn deny" onclick="denyViewer('${vid}','${esc(d.name)}')"><span class="material-symbols-outlined">close</span></button></div></div>`; } }
  const connected=Object.entries(connectedViewers);
  html+=`<div class="ppl-section">👥 In Session</div>`;
  if(myName){ const col=nameToHsl(myName); html+=`<div class="ppl-item"><div class="ppl-av" style="background:${col}">${myName[0].toUpperCase()}</div><div class="ppl-name">${esc(myName)} <span class="role-badge">${isHost?"HOST":"YOU"}</span></div></div>`; }
  for(const[vid,d]of connected){ const col=nameToHsl(d.name); html+=`<div class="ppl-item"><div class="ppl-av" style="background:${col}">${d.name[0].toUpperCase()}</div><div class="ppl-name">${esc(d.name)}</div>${isHost?`<button class="pa-btn kick" onclick="kickViewer('${vid}','${esc(d.name)}')"><span class="material-symbols-outlined">person_remove</span></button>`:""}</div>`; }
  if(!html&&!myName) html=`<div class="ppl-empty"><span class="material-symbols-outlined">group</span><p>No one yet</p></div>`;
  c.innerHTML=html;
  const badge=document.getElementById("peopleBadge"); if(badge){badge.textContent=pending.length;badge.style.display=pending.length>0?"flex":"none";}
}

window.approveViewer=async(vid,name)=>{ await set(ref(db,`rooms/${roomId}/waitroom/${vid}/status`),"approved"); delete pendingViewers[vid]; renderPeopleTab(); };
window.denyViewer  =async(vid,name)=>{ await set(ref(db,`rooms/${roomId}/waitroom/${vid}/status`),"denied"); setTimeout(()=>remove(ref(db,`rooms/${roomId}/waitroom/${vid}`)),3000); delete pendingViewers[vid]; renderPeopleTab(); showToast(`✗ ${name} declined`); };
window.kickViewer  =async(vid,name)=>{ await set(ref(db,`rooms/${roomId}/viewers/${vid}/kicked`),true); setTimeout(()=>remove(ref(db,`rooms/${roomId}/viewers/${vid}`)),2000); try{screenPcMap[vid]?.close();}catch(_){} delete screenPcMap[vid]; delete connectedViewers[vid]; renderPeopleTab(); showToast(`👢 ${name} removed`); };
window.applyBitrateNow=()=>{ Object.values(screenPcMap).forEach(pc=>{if(pc.connectionState==="connected")optimizeHostSender(pc);}); };

/* CAPTURE */
async function captureScreen(){
  const resStr=document.getElementById("scrRes")?.value||"1080p", fpsStr=document.getElementById("scrFps")?.value||"30";
  const {width,height}=RES_MAP[resStr]||RES_MAP["1080p"], fps=parseInt(fpsStr)||30;
  const con={video:{width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps,max:fps}},audio:{channelCount:2,sampleRate:48000,autoGainControl:false,echoCancellation:false,noiseSuppression:false}};
  try{ localStream=await navigator.mediaDevices.getDisplayMedia(con); }
  catch{ con.audio=true; try{localStream=await navigator.mediaDevices.getDisplayMedia(con);}catch{con.audio=false;localStream=await navigator.mediaDevices.getDisplayMedia(con);} }
  const vt=localStream.getVideoTracks()[0]; if(vt&&"contentHint"in vt)vt.contentHint="detail";
  const video=document.getElementById("remoteVideo"); video.srcObject=localStream; video.muted=true;
  vt.onended=()=>leaveCall(); return localStream;
}

/* OPTIMIZE SENDER */
async function optimizeHostSender(pc){
  const mbps=parseFloat(document.getElementById("bitrateSlider")?.value||"4"), fps=parseInt(document.getElementById("scrFps")?.value||"30")||30;
  for(const s of pc.getSenders()){ if(!s.track||s.track.kind!=="video")continue; const p=s.getParameters(); if(!p.encodings?.length)p.encodings=[{}]; p.encodings[0].maxBitrate=mbps*1_000_000; p.encodings[0].minBitrate=500_000; p.encodings[0].maxFramerate=fps; p.encodings[0].networkPriority="high"; p.encodings[0].priority="high"; p.degradationPreference="maintain-framerate"; try{await s.setParameters(p);}catch(_){} }
}

/* HOST */
window.confirmHost=async()=>{
  roomId=document.getElementById("roomId").value.trim(); myName=document.getElementById("userName").value.trim()||"Host";
  if(!roomId){roomId=Math.random().toString(36).substr(2,8).toUpperCase();document.getElementById("roomId").value=roomId;}
  if(myName)localStorage.setItem("watchparty_name",myName);
  try{await captureScreen();}catch{return showToast("⚠️ Screen share cancelled");}
  isHost=true;
  document.getElementById("noSignal").classList.add("hidden");
  document.getElementById("liveBadge").style.display="flex";
  document.getElementById("sourceTag").style.display=""; document.getElementById("sourceTag").textContent="HOSTING";
  updateConnStatus("connected"); changeActionBtns("session");
  document.getElementById("hostOnlySettings")?.style.removeProperty("display");
  window.switchTab("chat"); renderPeopleTab();

  const roomRef=ref(db,`rooms/${roomId}`);
  await set(ref(db,`rooms/${roomId}/host`),{name:myName,created:Date.now()});
  onDisconnect(roomRef).remove();

  // Waitroom
  const unsubW=onChildAdded(ref(db,`rooms/${roomId}/waitroom`),snap=>{
    const vid=snap.key, data=snap.val(); if(!data||!vid||data.status)return;
    pendingViewers[vid]={name:data.name||"Viewer"}; renderPeopleTab(); showToast(`🔔 ${data.name} wants to join`); window.switchTab("people");
  }); firebaseUnsubs.push(unsubW);

  // Viewer connections
  const unsubV=onChildAdded(ref(db,`rooms/${roomId}/viewers`),async snap=>{
    const vid=snap.key; if(!vid||screenPcMap[vid])return;
    get(ref(db,`rooms/${roomId}/viewers/${vid}/ready`)).then(s=>{const n=s.val()?.name||"Viewer"; connectedViewers[vid]={name:n}; renderPeopleTab(); addSystemMsg(`👋 ${n} joined`);});
    const pc=new RTCPeerConnection(servers); screenPcMap[vid]=pc;
    if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    logIce(pc,`H→${vid.substring(0,6)}`);
    pc.onconnectionstatechange=()=>{ console.log(`[H→${vid.substring(0,6)}] ${pc.connectionState}`); if(pc.connectionState==="connected")optimizeHostSender(pc); if(["failed","closed"].includes(pc.connectionState)){try{pc.close();}catch(_){} delete screenPcMap[vid]; delete connectedViewers[vid]; renderPeopleTab();} };
    const oRef=ref(db,`rooms/${roomId}/viewers/${vid}/offerCandidates`), aRef=ref(db,`rooms/${roomId}/viewers/${vid}/answerCandidates`);
    pc.onicecandidate=e=>{if(e.candidate){logCandidate(e.candidate,`H→${vid.substring(0,6)}`);push(oRef,e.candidate.toJSON());}};
    const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
    await set(ref(db,`rooms/${roomId}/viewers/${vid}/offer`),{type:offer.type,sdp:offer.sdp});
    let pendIce=[],rdReady=false;
    const unsubA=onValue(ref(db,`rooms/${roomId}/viewers/${vid}/answer`),async s=>{if(!s.val()||rdReady)return; try{await pc.setRemoteDescription(new RTCSessionDescription(s.val()));rdReady=true;for(const c of pendIce){try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch(_){}}pendIce=[];}catch(e){console.error(e);}});
    const unsubI=onChildAdded(aRef,async cs=>{const c=cs.val();if(rdReady){try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch(_){}}else pendIce.push(c);});
    firebaseUnsubs.push(unsubA,unsubI);
  }); firebaseUnsubs.push(unsubV);
  startHostStats(); startChatListener(); startReactionListener();
  showToast("🎬 Live! Room: "+roomId);
};

/* VIEWER */
window.confirmJoin=async()=>{
  roomId=document.getElementById("roomId").value.trim(); myName=document.getElementById("userName").value.trim()||"Viewer";
  if(!roomId)return showToast("⚠️ Enter Room Code");
  if(myName)localStorage.setItem("watchparty_name",myName);
  isHost=false; bgAudioSet=false; updateConnStatus("connecting");
  document.getElementById("hostOnlySettings") && (document.getElementById("hostOnlySettings").style.display="none");
  const myVid="v_"+Math.random().toString(36).substr(2,9);
  await set(ref(db,`rooms/${roomId}/waitroom/${myVid}`),{name:myName,requestedAt:Date.now()});
  onDisconnect(ref(db,`rooms/${roomId}/waitroom/${myVid}`)).remove();
  const ns=document.getElementById("noSignal"); ns.classList.remove("hidden");
  ns.querySelector("h3").textContent="Waiting for host..."; ns.querySelector("p").textContent="Host will let you in shortly";
  const unsubS=onValue(ref(db,`rooms/${roomId}/waitroom/${myVid}/status`),async ss=>{
    const status=ss.val(); if(!status)return; unsubS();
    if(status==="approved"){ns.classList.add("hidden"); await proceedJoin(myVid,myName);}
    else{showToast("❌ Host declined your request"); updateConnStatus("disconnected"); changeActionBtns("init"); ns.querySelector("h3").textContent="Waiting for Screen Share"; ns.querySelector("p").textContent="Connect to join or host a session";}
  }); firebaseUnsubs.push(unsubS);
};

async function proceedJoin(myVid,userName){
  onDisconnect(ref(db,`rooms/${roomId}/viewers/${myVid}`)).remove();
  await set(ref(db,`rooms/${roomId}/viewers/${myVid}/ready`),{name:userName});
  const pc=new RTCPeerConnection(servers); viewerPc=pc;
  const video=document.getElementById("remoteVideo"), remoteStream=new MediaStream();
  video.srcObject=remoteStream; video.muted=false;
  pc.ontrack=e=>{
    const track=e.track;
    if(e.receiver){if(track.kind==="audio"){try{e.receiver.playoutDelayHint=0;}catch(_){}}else{try{e.receiver.playoutDelayHint=0.05;}catch(_){} if("contentHint"in track)track.contentHint="detail";}}
    if(!remoteStream.getTracks().find(t=>t.id===track.id))remoteStream.addTrack(track);
    if(!bgAudioSet&&track.kind==="audio"){ bgAudioSet=true; const bg=document.getElementById("bgAudio"); bg.srcObject=new MediaStream([track]); video.muted=true; bg.play().then(()=>{if("mediaSession"in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:`Live Room ${roomId}`,artist:"Watch Party",artwork:[{src:"icon.png",sizes:"192x192",type:"image/png"}]});}).catch(e=>console.warn(e)); }
  };
  logIce(pc,"viewer");
  pc.onconnectionstatechange=()=>{
    console.log(`[Viewer] ${pc.connectionState}`);
    if(pc.connectionState==="connected"){iceRestartCount=0;updateConnStatus("connected");document.getElementById("noSignal").classList.add("hidden");document.getElementById("sourceTag").style.display="";document.getElementById("sourceTag").textContent="WATCHING";changeActionBtns("session");window.switchTab("chat");startStats(pc);renderPeopleTab();showToast("🎬 Connected!");}
    if(pc.connectionState==="disconnected"){updateConnStatus("connecting");showToast("⚡ Reconnecting...");}
    if(pc.connectionState==="failed"){if(iceRestartCount<MAX_ICE_RESTARTS){iceRestartCount++;showToast(`🔄 Retry ${iceRestartCount}/${MAX_ICE_RESTARTS}`);pc.restartIce();}else{showToast("❌ Connection failed");updateConnStatus("disconnected");leaveCall();}}
  };
  onValue(ref(db,`rooms/${roomId}/viewers/${myVid}/kicked`),s=>{if(s.val()){showToast("⛔ Removed by host");leaveCall();}});
  const oRef=ref(db,`rooms/${roomId}/viewers/${myVid}/offerCandidates`), aRef=ref(db,`rooms/${roomId}/viewers/${myVid}/answerCandidates`);
  pc.onicecandidate=e=>{if(e.candidate){logCandidate(e.candidate,"viewer");push(aRef,e.candidate.toJSON());}};
  let pendIce=[],rdReady=false;
  const unsubO=onValue(ref(db,`rooms/${roomId}/viewers/${myVid}/offer`),async snap=>{if(!snap.val()||rdReady)return;try{await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));rdReady=true;for(const c of pendIce){try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch(_){}}pendIce=[];const ans=await pc.createAnswer();await pc.setLocalDescription(ans);await set(ref(db,`rooms/${roomId}/viewers/${myVid}/answer`),{type:ans.type,sdp:ans.sdp});}catch(e){console.error(e);}});
  const unsubI=onChildAdded(oRef,async s=>{const c=s.val();if(rdReady){try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch(_){}}else pendIce.push(c);});
  firebaseUnsubs.push(unsubO,unsubI);
  startChatListener(); startReactionListener();
}

/* LEAVE */
window.leaveCall=async()=>{
  stopStats(); firebaseUnsubs.forEach(u=>{try{u();}catch(_){}}); firebaseUnsubs=[];
  Object.values(screenPcMap).forEach(pc=>{try{pc.close();}catch(_){}});screenPcMap={};
  if(viewerPc){try{viewerPc.close();}catch(_){}viewerPc=null;}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  const bg=document.getElementById("bgAudio"); if(bg){bg.srcObject=null;bg.pause();}
  if(isHost&&roomId)remove(ref(db,`rooms/${roomId}`));
  const ns=document.getElementById("noSignal"); ns.classList.remove("hidden"); ns.querySelector("h3").textContent="Waiting for Screen Share"; ns.querySelector("p").textContent="Connect to join or host a session";
  document.getElementById("remoteVideo").srcObject=null;
  document.getElementById("liveBadge").style.display="none";
  ["sourceTag","qualityTag"].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display="none";});
  document.getElementById("hostOnlySettings")&&(document.getElementById("hostOnlySettings").style.display="none");
  updateConnStatus("disconnected"); changeActionBtns("init");
  document.getElementById("chatMessages").innerHTML=`<div style="text-align:center;color:var(--text-muted);margin-top:30px;font-size:11px;">💬 Messages visible to everyone</div>`;
  connectedViewers={}; pendingViewers={}; renderPeopleTab();
  roomId=""; isHost=false; bgAudioSet=false; myName=""; showToast("👋 Disconnected");
};

/* CHAT */
window.sendChat=()=>{ const inp=document.getElementById("chatInput"),msg=inp?.value.trim(); if(!msg||!roomId)return; const name=document.getElementById("userName")?.value.trim()||(isHost?"Host":"Viewer"); push(ref(db,`rooms/${roomId}/chat`),{sender:name,text:msg,time:Date.now()}); inp.value=""; };

function startChatListener(){
  if(!roomId)return; const ts=Date.now(); const myN=document.getElementById("userName")?.value.trim()||(isHost?"Host":"Viewer");
  const unsub=onChildAdded(ref(db,`rooms/${roomId}/chat`),snap=>{
    const d=snap.val(); if(!d||d.time<ts-1000)return;
    const msgId=`chat_${snap.key}`; if(document.getElementById(msgId))return;
    const wrap=document.createElement("div"); wrap.className="chat-msg"; wrap.id=msgId;
    const isMe=d.sender===myN, time=new Date(d.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    const col=nameToHsl(d.sender), init=d.sender[0]?.toUpperCase()||"?";
    wrap.innerHTML=`<div class="chat-msg-header"><div class="chat-av" style="background:${col}">${init}</div><span class="chat-sender" style="color:${isMe?"var(--accent)":"var(--cyan)"}">${isMe?"You":esc(d.sender)}</span><span class="chat-time">${time}</span></div><div class="chat-bubble ${isMe?"me":"other"}">${esc(d.text)}</div>`;
    const c=document.getElementById("chatMessages"); if(c){c.appendChild(wrap);c.scrollTop=c.scrollHeight;if(!document.getElementById("contentChat").classList.contains("active"))showToast(`${d.sender}: ${d.text}`);}
    addFloatingChatMsg(isMe?"You":d.sender,d.text);
  }); firebaseUnsubs.push(unsub);
}

/* REACTIONS */
window.sendReaction=emoji=>{if(!roomId)return showToast("⚠️ Connect first");push(ref(db,`rooms/${roomId}/reactions`),{emoji,time:Date.now()+Math.random()});triggerEmojiUI(emoji);};
function startReactionListener(){if(!roomId)return;const ts=Date.now();const u=onChildAdded(ref(db,`rooms/${roomId}/reactions`),snap=>{const d=snap.val();if(!d||d.time<ts)return;triggerEmojiUI(d.emoji);});firebaseUnsubs.push(u);}
function triggerEmojiUI(emoji){const ov=document.getElementById("emojiOverlay");if(!ov)return;const el=document.createElement("div");el.className="emoji-float";el.textContent=emoji;el.style.left=(15+Math.random()*70)+"%";ov.appendChild(el);el.addEventListener("animationend",()=>el.remove(),{once:true});}

/* STATS — Viewer (inbound) */
function startStats(pc){
  if(!pc)return; startTime=Date.now(); prevBytesStat=0;
  const iv=isMobile?3000:2000;
  statsInterval=setInterval(async()=>{try{const stats=await pc.getStats();let inb=null,pair=null;stats.forEach(r=>{if(r.type==="inbound-rtp"&&r.kind==="video")inb=r;if(r.type==="candidate-pair"&&r.nominated)pair=r;});if(inb){const b=inb.bytesReceived||0,br=((b-prevBytesStat)*8/(iv/1000)/1_000_000).toFixed(1);prevBytesStat=b;const e=id=>document.getElementById(id);if(e("statBitrate"))e("statBitrate").innerHTML=`${br}<span class="stat-unit"> Mbps</span>`;if(e("barBitrate"))e("barBitrate").style.width=Math.min(br/12*100,100)+"%";if(e("statFps"))e("statFps").textContent=Math.round(inb.framesPerSecond||0);if(e("statRes"))e("statRes").textContent=`${inb.frameWidth||0}×${inb.frameHeight||0}`;if(e("statCodec"))e("statCodec").textContent=inb.decoderImplementation||"Auto";const loss=((inb.packetsLost||0)/Math.max(inb.packetsReceived||1,1)*100).toFixed(1);if(e("statLoss"))e("statLoss").textContent=`${loss}%`;const tag=e("qualityTag");if(tag){tag.style.display="";const h=inb.frameHeight||0;tag.textContent=h>=1080?"1080p":h>=720?"720p":`${h}p`;}}if(pair&&document.getElementById("statRtt"))document.getElementById("statRtt").innerHTML=`${Math.round((pair.currentRoundTripTime||0)*1000)}<span class="stat-unit"> ms</span>`;}catch(_){}},iv);
  timerInterval=setInterval(()=>{const s=Math.floor((Date.now()-startTime)/1000);const el=document.getElementById("statDuration");if(el)el.textContent=`${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;},1000);
}

/* STATS — Host (outbound) */
function startHostStats(){
  startTime=Date.now(); prevBytesStat=0; const iv=2000;
  statsInterval=setInterval(async()=>{const pcs=Object.values(screenPcMap).filter(p=>p.connectionState==="connected");if(!pcs.length)return;try{const stats=await pcs[0].getStats();let out=null,rin=null,pair=null;stats.forEach(r=>{if(r.type==="outbound-rtp"&&r.kind==="video")out=r;if(r.type==="remote-inbound-rtp"&&r.kind==="video")rin=r;if(r.type==="candidate-pair"&&r.nominated)pair=r;});if(out){const b=out.bytesSent||0,br=((b-prevBytesStat)*8/(iv/1000)/1_000_000).toFixed(1);prevBytesStat=b;const e=id=>document.getElementById(id);if(e("statBitrate"))e("statBitrate").innerHTML=`${br}<span class="stat-unit"> Mbps</span>`;if(e("barBitrate"))e("barBitrate").style.width=Math.min(br/12*100,100)+"%";if(e("statFps"))e("statFps").textContent=Math.round(out.framesPerSecond||0);if(e("statRes"))e("statRes").textContent=`${out.frameWidth||0}×${out.frameHeight||0}`;const qlr=out.qualityLimitationReason;if(e("statCodec"))e("statCodec").textContent=qlr&&qlr!=="none"?`⚠️ ${qlr}`:"Optimal";if(rin){const loss=((rin.packetsLost||0)/Math.max(out.packetsSent||1,1)*100).toFixed(1);if(e("statLoss"))e("statLoss").textContent=`${loss}%`;}const tag=e("qualityTag");if(tag){tag.style.display="";const h=out.frameHeight||0;tag.textContent=h>=1080?"1080p":h>=720?"720p":`${h}p`;}}if(pair&&document.getElementById("statRtt"))document.getElementById("statRtt").innerHTML=`${Math.round((pair.currentRoundTripTime||0)*1000)}<span class="stat-unit"> ms</span>`;}catch(_){}},iv);
  timerInterval=setInterval(()=>{const s=Math.floor((Date.now()-startTime)/1000);const el=document.getElementById("statDuration");if(el)el.textContent=`${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor((s%3600)/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;},1000);
}

function stopStats(){clearInterval(statsInterval);clearInterval(timerInterval);}
window.generateRoom=()=>{const c=Math.random().toString(36).substr(2,6).toUpperCase();const el=document.getElementById("roomId");if(el)el.value=c;showToast("🎲 Room code generated");};

/* PiP — auto on visibility change */
document.addEventListener("visibilitychange",async()=>{
  if(!document.hidden)return;
  const video=document.getElementById("remoteVideo");
  if(!video?.srcObject)return;
  if(document.pictureInPictureEnabled&&!document.pictureInPictureElement){try{await video.requestPictureInPicture();}catch(_){}}
});
document.getElementById("remoteVideo")?.addEventListener("enterpictureinpicture",()=>{const v=document.getElementById("remoteVideo"),a=document.getElementById("bgAudio");if(v)v.muted=false;if(a)a.muted=true;});
document.getElementById("remoteVideo")?.addEventListener("leavepictureinpicture",()=>{const v=document.getElementById("remoteVideo"),a=document.getElementById("bgAudio");if(v)v.muted=true;if(a)a.muted=false;});

if("serviceWorker"in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));