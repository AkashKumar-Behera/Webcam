"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth, db } from "../lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { ref, set, get, push, onValue, remove } from "firebase/database";

export default function DashboardPage() {
  const router = useRouter();

  // Navigation state
  const [activeTab, setActiveTab] = useState<"dashboard" | "friends" | "notifications" | "profile">("dashboard");

  // User details
  const [myUid, setMyUid] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [photoURL, setPhotoURL] = useState("");
  const [bio, setBio] = useState("");

  // Room configs
  const [room, setRoom] = useState("");
  const [mode, setMode] = useState("party");
  const [mood, setMood] = useState({ id: "movie", emoji: "🎬", label: "Movie Night" });
  const [enableMic, setEnableMic] = useState(true);
  const [showHostSettings, setShowHostSettings] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "private" | "unlisted">("public");
  const [roomPassword, setRoomPassword] = useState("");

  // Host stream options
  const [quality, setQuality] = useState("1080p");
  const [fps, setFps] = useState("30");
  const [codec, setCodec] = useState("h264");

  // System states
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [friendsList, setFriendsList] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [publicRooms, setPublicRooms] = useState<any[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [showHostModal, setShowHostModal] = useState(false);

  const PROFILE_KEY = "nova_user_profile";

  useEffect(() => {
    // Read local cache profile
    try {
      const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      if (profile) {
        setName(profile.name || "");
        setEmail(profile.email || "");
        setPhotoURL(profile.photoURL || "");
        setMyUid(profile.uid || "");
      }
    } catch (e) {
      console.warn("Could not read local profile:", e);
    }

    // Auth verification
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const localProfile = localStorage.getItem(PROFILE_KEY);
      if (!user && !localProfile) {
        router.push("/login");
      } else {
        const uid = user?.uid || (localProfile ? JSON.parse(localProfile).uid : "");
        setMyUid(uid);
        setLoading(false);
        if (uid) {
          syncUserData(uid);
          listenToFriends(uid);
          listenToNotifications(uid);
          syncOnlineStatus(uid);
        }
      }
    });

    // Listen to active rooms
    const roomsRef = ref(db, "rooms");
    const unsubscribeRooms = onValue(roomsRef, (snap) => {
      if (snap.exists()) {
        const list: any[] = [];
        Object.entries(snap.val()).forEach(([roomId, val]: [string, any]) => {
          if (val.visibility === "public" || val.visibility === "private") {
            let userCount = 1;
            if (val.participants) {
              userCount += Object.keys(val.participants).length;
            }
            if (val.viewers) {
              userCount += Object.keys(val.viewers).length;
            }
            list.push({
              roomId,
              hostName: val.host?.name || "Host",
              hostPhoto: val.host?.photoURL || "",
              visibility: val.visibility,
              password: val.password || "",
              userCount,
              moodLabel: val.moodLabel || "Movie Night",
              moodEmoji: val.moodEmoji || "🎬"
            });
          }
        });
        setPublicRooms(list);
      } else {
        setPublicRooms([]);
      }
      setRoomsLoading(false);
    });

    // Load memories
    try {
      const saved = JSON.parse(localStorage.getItem("saath_memories") || "[]");
      setMemories(saved);
    } catch {}

    return () => {
      unsubscribe();
      unsubscribeRooms();
    };
  }, [router]);

  const syncUserData = (uid: string) => {
    onValue(ref(db, `users/${uid}`), (snap) => {
      if (snap.exists()) {
        const val = snap.val();
        setBio(val.bio || "");
        if (val.name) setName(val.name);
        if (val.photoURL) setPhotoURL(val.photoURL);
      }
    });
  };

  const syncOnlineStatus = (uid: string) => {
    const statusRef = ref(db, `status/${uid}`);
    set(statusRef, { state: "online", lastChanged: Date.now() });
    // Cleanup status on window close or tab change
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        set(statusRef, { state: "offline", lastChanged: Date.now() });
      });
    }
  };

  const listenToFriends = (uid: string) => {
    onValue(ref(db, `friends/${uid}`), async (snap) => {
      if (snap.exists()) {
        const friendsData = snap.val();
        const list: any[] = [];
        for (const [friendId, relation] of Object.entries(friendsData)) {
          if (relation === "friend") {
            const userSnap = await get(ref(db, `users/${friendId}`));
            const statusSnap = await get(ref(db, `status/${friendId}`));
            if (userSnap.exists()) {
              list.push({
                uid: friendId,
                ...userSnap.val(),
                status: statusSnap.exists() ? statusSnap.val().state : "offline"
              });
            }
          }
        }
        setFriendsList(list);
      } else {
        setFriendsList([]);
      }
    });
  };

  const listenToNotifications = (uid: string) => {
    onValue(ref(db, `friends/${uid}`), async (snap) => {
      const notifs: any[] = [];
      if (snap.exists()) {
        const friendsData = snap.val();
        for (const [friendId, relation] of Object.entries(friendsData)) {
          if (relation === "incoming") {
            const userSnap = await get(ref(db, `users/${friendId}`));
            if (userSnap.exists()) {
              notifs.push({
                id: friendId,
                type: "friend_request",
                name: userSnap.val().name,
                email: userSnap.val().email
              });
            }
          }
        }
      }
      
      // Also fetch room invites
      const inviteSnap = await get(ref(db, `invites/${uid}`));
      if (inviteSnap.exists()) {
        Object.entries(inviteSnap.val()).forEach(([inviteId, val]: [string, any]) => {
          notifs.push({
            id: inviteId,
            type: "room_invite",
            roomId: val.roomId,
            hostName: val.hostName,
            mood: val.mood
          });
        });
      }
      setNotifications(notifs);
    });
  };

  const handleLogout = async () => {
    // Set status to offline before logging out
    if (myUid) {
      await set(ref(db, `status/${myUid}`), { state: "offline", lastChanged: Date.now() });
    }
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem("watchparty_name");
    localStorage.removeItem("watchparty_email");
    localStorage.removeItem("nova_auth_provider");
    await signOut(auth);
    router.push("/login");
  };

  const generateRoomCode = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoom(code);
  };

  const handleStartHost = async () => {
    if (!name.trim()) {
      alert("Please enter your name.");
      return;
    }
    const finalRoom = room.trim() || Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Save to local storage for the room session
    localStorage.setItem("watchparty_name", name.trim());
    localStorage.setItem("watchparty_email", email || `${name.trim().toLowerCase()}@manual.local`);
    localStorage.setItem("watchparty_room", finalRoom);
    localStorage.setItem("watchparty_mode", mode);
    localStorage.setItem("watchparty_mood_id", mood.id);
    localStorage.setItem("watchparty_mood_emoji", mood.emoji);
    localStorage.setItem("watchparty_mood_label", mood.label);
    localStorage.setItem("watchparty_host_mic", enableMic ? "true" : "false");
    localStorage.setItem("watchparty_stream_quality", quality);
    localStorage.setItem("watchparty_stream_fps", fps);
    localStorage.setItem("watchparty_stream_codec", codec);

    // Save Room Configurations to RTDB
    const roomRef = ref(db, `rooms/${finalRoom}`);
    const hostPayload = {
      name: name.trim(),
      email: email || `${name.trim().toLowerCase()}@manual.local`,
      uid: myUid,
      photoURL: photoURL || ""
    };

    await set(roomRef, {
      host: hostPayload,
      visibility: visibility,
      password: visibility === "private" ? roomPassword : "",
      moodLabel: mood.label,
      moodEmoji: mood.emoji,
      createdAt: Date.now()
    });

    router.push(`/room/${finalRoom}?role=host`);
  };

  const handleJoin = async () => {
    if (!name.trim()) {
      alert("Please enter your name.");
      return;
    }
    if (!room.trim()) {
      alert("Please enter a Room Code to join.");
      return;
    }

    localStorage.setItem("watchparty_name", name.trim());
    localStorage.setItem("watchparty_email", email || `${name.trim().toLowerCase()}@manual.local`);
    localStorage.setItem("watchparty_room", room.trim());
    localStorage.setItem("watchparty_mode", mode);
    localStorage.setItem("watchparty_mood_id", mood.id);
    localStorage.setItem("watchparty_mood_emoji", mood.emoji);
    localStorage.setItem("watchparty_mood_label", mood.label);

    router.push(`/room/${room.trim()}?role=viewer`);
  };

  const searchUsers = async () => {
    if (!searchQuery.trim()) return;
    const usersSnap = await get(ref(db, "users"));
    if (usersSnap.exists()) {
      const results: any[] = [];
      Object.entries(usersSnap.val()).forEach(([uid, val]: [string, any]) => {
        if (uid !== myUid && val.name?.toLowerCase().includes(searchQuery.toLowerCase())) {
          results.push({ uid, name: val.name, email: val.email });
        }
      });
      setSearchResults(results);
    }
  };

  const sendFriendRequest = async (targetUid: string) => {
    await set(ref(db, `friends/${myUid}/${targetUid}`), "outgoing");
    await set(ref(db, `friends/${targetUid}/${myUid}`), "incoming");
    alert("Friend request sent!");
    setSearchQuery("");
    setSearchResults([]);
  };

  const acceptFriendRequest = async (targetUid: string) => {
    await set(ref(db, `friends/${myUid}/${targetUid}`), "friend");
    await set(ref(db, `friends/${targetUid}/${myUid}`), "friend");
    alert("Friend request accepted!");
    listenToFriends(myUid);
    listenToNotifications(myUid);
  };

  const rejectFriendRequest = async (targetUid: string) => {
    await remove(ref(db, `friends/${myUid}/${targetUid}`));
    await remove(ref(db, `friends/${targetUid}/${myUid}`));
    listenToNotifications(myUid);
  };

  const inviteFriendToRoom = async (friendUid: string) => {
    if (!room.trim()) {
      alert("Please generate or enter a Room Code first.");
      return;
    }
    const inviteRef = push(ref(db, `invites/${friendUid}`));
    await set(inviteRef, {
      roomId: room.trim(),
      hostName: name,
      mood: mood.label,
      timestamp: Date.now()
    });
    alert("Invitation sent!");
  };

  const saveBio = async () => {
    if (!myUid) return;
    await set(ref(db, `users/${myUid}/bio`), bio);
    alert("Bio updated!");
  };

  if (loading) {
    return (
      <div className="dashboard-layout">
        <aside className="sidebar-nav">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">
              <span className="material-symbols-outlined">favorite</span>
            </div>
            <h2>Nova</h2>
          </div>
          <div className="sidebar-menu">
            <div className="shimmer-element" style={{ height: "44px", width: "100%", marginBottom: "8px" }}></div>
            <div className="shimmer-element" style={{ height: "44px", width: "100%", marginBottom: "8px" }}></div>
            <div className="shimmer-element" style={{ height: "44px", width: "100%" }}></div>
          </div>
        </aside>
        <main className="main-content" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="modal-card">
            <div className="modal-split">
              <div className="modal-left" style={{ pointerEvents: "none" }}>
                <div className="shimmer-element" style={{ width: "48px", height: "48px", borderRadius: "50%" }}></div>
                <div className="shimmer-element" style={{ width: "120px", height: "28px", marginTop: "12px" }}></div>
                <div className="shimmer-element" style={{ width: "100%", height: "36px", marginTop: "8px" }}></div>
              </div>
              <div className="modal-right" style={{ pointerEvents: "none", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="shimmer-element" style={{ width: "100%", height: "44px" }}></div>
                <div className="shimmer-element" style={{ width: "100%", height: "44px" }}></div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      {/* Left Sidebar Navigation */}
      <aside className="sidebar-nav">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">
            <span className="material-symbols-outlined">favorite</span>
          </div>
          <h2>Nova</h2>
        </div>

        <nav className="sidebar-menu">
          <button 
            className={`sidebar-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <span className="material-symbols-outlined">dashboard</span>
            Dashboard
          </button>
          <button 
            className={`sidebar-item ${activeTab === "friends" ? "active" : ""}`}
            onClick={() => setActiveTab("friends")}
          >
            <span className="material-symbols-outlined">groups</span>
            Friends
          </button>
          <button 
            className={`sidebar-item ${activeTab === "notifications" ? "active" : ""}`}
            onClick={() => setActiveTab("notifications")}
          >
            <span className="material-symbols-outlined">notifications</span>
            Invites & Notifs
            {notifications.length > 0 && (
              <span style={{ marginLeft: "auto", background: "#ef4444", color: "#fff", borderRadius: "50%", padding: "2px 6px", fontSize: "10px", fontWeight: "bold" }}>
                {notifications.length}
              </span>
            )}
          </button>
          <button 
            className={`sidebar-item ${activeTab === "profile" ? "active" : ""}`}
            onClick={() => setActiveTab("profile")}
          >
            <span className="material-symbols-outlined">person</span>
            Profile
          </button>
        </nav>

        <div className="sidebar-user">
          <div className="sidebar-user-info">
            <div className="sidebar-user-avatar">
              {photoURL ? (
                <img src={photoURL} alt={name} style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
              ) : (
                name.charAt(0).toUpperCase()
              )}
            </div>
            <div className="sidebar-user-details">
              <span className="sidebar-user-name">{name}</span>
            </div>
          </div>
          <button className="sidebar-user-logout" onClick={handleLogout}>
            <span className="material-symbols-outlined">logout</span>
          </button>
        </div>
      </aside>

      {/* Main View Container */}
      <main className="main-content">
        {activeTab === "dashboard" && (
          <div>
            <div className="dashboard-header-row">
              <h1>Active Rooms</h1>
              <button className="host-plus-btn" onClick={() => setShowHostModal(true)}>
                <span className="material-symbols-outlined">add</span>
              </button>
            </div>

            {roomsLoading ? (
              <div className="rooms-grid">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="shimmer-card">
                    <div className="shimmer-row">
                      <div className="shimmer-bar" style={{ width: "80px" }}></div>
                      <div className="shimmer-bar" style={{ width: "60px" }}></div>
                    </div>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "14px" }}>
                      <div className="shimmer-circle"></div>
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                        <div className="shimmer-bar" style={{ width: "100px" }}></div>
                        <div className="shimmer-bar" style={{ width: "60px" }}></div>
                      </div>
                    </div>
                    <div className="shimmer-row" style={{ marginTop: "auto" }}>
                      <div className="shimmer-bar" style={{ width: "70px" }}></div>
                      <div className="shimmer-bar" style={{ width: "80px", height: "30px", borderRadius: "8px" }}></div>
                    </div>
                  </div>
                ))}
              </div>
            ) : publicRooms.length === 0 ? (
              <div style={{ textAlign: "center", color: "#808290", padding: "80px 20px" }}>
                <span className="material-symbols-outlined" style={{ fontSize: "64px", marginBottom: "16px", color: "rgba(167, 139, 250, 0.4)" }}>
                  live_tv
                </span>
                <h2>No active watch rooms right now</h2>
                <p style={{ marginTop: "8px", fontSize: "14px" }}>Click the "+" button in the top right to host a watch party!</p>
              </div>
            ) : (
              <div className="rooms-grid">
                {publicRooms.map((r) => (
                  <div key={r.roomId} className="room-card">
                    <div className="room-card-header">
                      <span className="room-mood-badge">
                        {r.moodEmoji} {r.moodLabel}
                      </span>
                      <span className={`room-visibility-badge ${r.visibility}`}>
                        {r.visibility}
                      </span>
                    </div>

                    <div className="room-host-info">
                      <div className="room-host-avatar">
                        {r.hostPhoto ? (
                          <img src={r.hostPhoto} alt={r.hostName} style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
                        ) : (
                          r.hostName.charAt(0).toUpperCase()
                        )}
                      </div>
                      <div className="room-host-details">
                        <span className="room-host-name">{r.hostName}</span>
                        <span className="room-participant-count">
                          <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>groups</span>
                          {r.userCount} watching
                        </span>
                      </div>
                    </div>

                    <div className="room-card-footer">
                      <span className="room-code-display">Code: {r.roomId}</span>
                      <button 
                        className="room-join-btn" 
                        onClick={() => {
                          if (r.visibility === "private") {
                            const pwd = prompt("This room is private. Enter room password to join:");
                            if (pwd !== r.password) {
                              alert("Incorrect password.");
                              return;
                            }
                          }
                          // Save to local storage for the room session
                          localStorage.setItem("watchparty_name", name.trim() || "Viewer");
                          localStorage.setItem("watchparty_email", email || `${(name || "viewer").trim().toLowerCase()}@manual.local`);
                          localStorage.setItem("watchparty_room", r.roomId);
                          router.push(`/room/${r.roomId}?role=viewer`);
                        }}
                      >
                        Join Room
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Host Creation Modal */}
            {showHostModal && (
              <div className="modal-overlay-blur">
                <div className="modal-card" style={{ position: "relative", width: "90%", maxWidth: "760px", margin: "0 auto" }}>
                  <button className="modal-close-corner" onClick={() => setShowHostModal(false)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>

                  <div className="modal-split">
                    {/* Left Column: Branding and Actions */}
                    <div className="modal-left">
                      <div className="modal-header">
                        <div className="modal-logo">
                          <span className="material-symbols-outlined">favorite</span>
                        </div>
                        <h1>Nova 🎬</h1>
                        <p>Watch movies, shows & more — together in sync, in love.</p>
                      </div>
                      
                      {mode === "party" && (
                        <div className={`mic-option ${enableMic ? "active" : ""}`} onClick={() => setEnableMic(!enableMic)}>
                          <input 
                            type="checkbox" 
                            checked={enableMic} 
                            onChange={() => {}}
                            style={{ width: "18px", height: "18px", cursor: "pointer" }} 
                          />
                          <div>
                            <div className="mic-option-text-title">Enable Microphone</div>
                            <div className="mic-option-text-sub">Include live commentary while hosting</div>
                          </div>
                        </div>
                      )}

                      <div className="modal-actions" style={{ display: "grid", gap: "12px", marginTop: "20px" }}>
                        <button className="modal-btn host-btn" onClick={handleStartHost}>
                          <span className="material-symbols-outlined">cast</span>
                          Start Hosting
                        </button>
                      </div>
                    </div>

                    {/* Right Column: Settings & Details */}
                    <div className="modal-right">
                      <div>
                        <div className="modal-section-title">Your Name</div>
                        <input 
                          className="modal-input" 
                          value={name} 
                          onChange={(e) => setName(e.target.value)} 
                          placeholder="e.g. Akash" 
                          autoComplete="off" 
                          spellCheck="false" 
                        />
                      </div>
                      
                      <div>
                        <div className="modal-section-title">Your Special Room Code</div>
                        <div className="modal-room-row">
                          <input 
                            className="modal-input" 
                            value={room} 
                            onChange={(e) => setRoom(e.target.value)} 
                            placeholder="Enter or generate a code" 
                            maxLength={12} 
                            autoComplete="off" 
                            spellCheck="false" 
                          />
                          <button className="modal-gen-btn" onClick={generateRoomCode}>
                            <span className="material-symbols-outlined">autorenew</span>
                          </button>
                        </div>
                      </div>

                      {/* Room Visibility Selection */}
                      <div>
                        <div className="modal-section-title">Room Visibility</div>
                        <div className="visibility-selector">
                          <button 
                            className={`visibility-btn ${visibility === "public" ? "active" : ""}`}
                            onClick={() => setVisibility("public")}
                          >
                            <span className="material-symbols-outlined">public</span>
                            Public
                          </button>
                          <button 
                            className={`visibility-btn ${visibility === "private" ? "active" : ""}`}
                            onClick={() => setVisibility("private")}
                          >
                            <span className="material-symbols-outlined">lock</span>
                            Private
                          </button>
                          <button 
                            className={`visibility-btn ${visibility === "unlisted" ? "active" : ""}`}
                            onClick={() => setVisibility("unlisted")}
                          >
                            <span className="material-symbols-outlined">visibility_off</span>
                            Unlisted
                          </button>
                        </div>
                        {visibility === "private" && (
                          <input 
                            type="password"
                            className="modal-input"
                            placeholder="Set room password"
                            value={roomPassword}
                            onChange={(e) => setRoomPassword(e.target.value)}
                            style={{ marginTop: "8px" }}
                          />
                        )}
                      </div>

                      <div className="modal-host-settings">
                        <button className="modal-host-toggle" onClick={() => setShowHostSettings(!showHostSettings)}>
                          <span>⚙️ Host Settings (optional)</span>
                          <span className="material-symbols-outlined" style={{ transform: showHostSettings ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                            expand_more
                          </span>
                        </button>
                        
                        {showHostSettings && (
                          <div className="modal-host-body" style={{ display: "block" }}>
                            <div>
                              <div className="modal-section-title">Quality & FPS</div>
                              <div className="form-row">
                                <select className="form-select" value={quality} onChange={(e) => setQuality(e.target.value)}>
                                  <option value="2160p">4K (2160p)</option>
                                  <option value="1440p">2K (1440p)</option>
                                  <option value="1080p">1080p</option>
                                  <option value="720p">720p</option>
                                </select>
                                <select className="form-select" value={fps} onChange={(e) => setFps(e.target.value)}>
                                  <option value="60">60 fps</option>
                                  <option value="30">30 fps</option>
                                </select>
                              </div>
                              <div className="modal-section-title" style={{ marginTop: "10px" }}>Preferred Codec</div>
                              <select className="form-select" value={codec} onChange={(e) => setCodec(e.target.value)}>
                                <option value="av1">AV1 (Next-Gen Quality)</option>
                                <option value="h265">H.265 (HEVC)</option>
                                <option value="vp9">VP9 (High Quality)</option>
                                <option value="h264">H.264 (Universal Compatibility)</option>
                              </select>
                            </div>
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="modal-section-title">Session Type</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                          <div 
                            className={`mode-btn ${mode === "party" ? "active-mode" : ""}`} 
                            onClick={() => setMode("party")}
                          >
                            <span className="material-symbols-outlined">groups</span>
                            Watch Party
                          </div>
                          <div 
                            className={`mode-btn ${mode === "broadcast" ? "active-mode" : ""}`} 
                            onClick={() => setMode("broadcast")}
                          >
                            <span className="material-symbols-outlined">radio</span>
                            Broadcast
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="modal-section-title">Your Mood Tonight 🌙</div>
                        <div className="mood-bar">
                          <button 
                            className={`mood-btn ${mood.id === "movie" ? "active-mood" : ""}`} 
                            onClick={() => setMood({ id: "movie", emoji: "🎬", label: "Movie Night" })}
                          >
                            🎬 Movie
                          </button>
                          <button 
                            className={`mood-btn ${mood.id === "chill" ? "active-mood" : ""}`} 
                            onClick={() => setMood({ id: "chill", emoji: "🎵", label: "Chill Vibes" })}
                          >
                            🎵 Chill
                          </button>
                          <button 
                            className={`mood-btn ${mood.id === "study" ? "active-mood" : ""}`} 
                            onClick={() => setMood({ id: "study", emoji: "💻", label: "Study Mode" })}
                          >
                            💻 Study
                          </button>
                          <button 
                            className={`mood-btn ${mood.id === "game" ? "active-mood" : ""}`} 
                            onClick={() => setMood({ id: "game", emoji: "🎮", label: "Gaming" })}
                          >
                            🎮 Gaming
                          </button>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "friends" && (
          <div className="friends-container">
            <div className="friends-header">
              <h1>Friends List</h1>
            </div>
            
            {/* Search users */}
            <div className="search-bar-row">
              <input 
                type="text" 
                placeholder="Search usernames..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button onClick={searchUsers}>Search</button>
            </div>

            {searchResults.length > 0 && (
              <div className="search-results-box">
                <div className="search-results-title">Search Results</div>
                {searchResults.map((user) => (
                  <div key={user.uid} className="friend-item">
                    <div className="friend-user-info">
                      <div className="friend-avatar">{user.name.charAt(0).toUpperCase()}</div>
                      <div className="friend-details">
                        <span className="friend-name">{user.name}</span>
                        <span className="friend-status-text">{user.email}</span>
                      </div>
                    </div>
                    <button className="friend-action-btn" onClick={() => sendFriendRequest(user.uid)}>
                      <span className="material-symbols-outlined">person_add</span> Add
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Active friends */}
            <div>
              {friendsList.length === 0 ? (
                <div style={{ textAlign: "center", color: "#808290", padding: "40px" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: "48px", marginBottom: "8px" }}>group_off</span>
                  <p>No friends added yet.</p>
                </div>
              ) : (
                friendsList.map((friend) => (
                  <div key={friend.uid} className="friend-item">
                    <div className="friend-user-info">
                      <div className="friend-avatar">
                        {friend.photoURL ? (
                          <img src={friend.photoURL} alt={friend.name} style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
                        ) : (
                          friend.name.charAt(0).toUpperCase()
                        )}
                        <span className={`status-dot ${friend.status === "online" ? "online" : "offline"}`}></span>
                      </div>
                      <div className="friend-details">
                        <span className="friend-name">{friend.name}</span>
                        <span className="friend-status-text">{friend.status}</span>
                      </div>
                    </div>
                    <button className="friend-action-btn" onClick={() => inviteFriendToRoom(friend.uid)}>
                      <span className="material-symbols-outlined">send</span> Invite
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "notifications" && (
          <div className="notif-container">
            <div className="notif-header">
              <h1>Incoming Invitations</h1>
            </div>
            {notifications.length === 0 ? (
              <div style={{ textAlign: "center", color: "#808290", padding: "40px" }}>
                <span className="material-symbols-outlined" style={{ fontSize: "48px", marginBottom: "8px" }}>mail_outline</span>
                <p>All caught up! No notifications.</p>
              </div>
            ) : (
              notifications.map((notif) => (
                <div key={notif.id} className="notif-item">
                  <div className="notif-details">
                    {notif.type === "friend_request" ? (
                      <>
                        <span className="notif-title">Friend Request</span>
                        <span className="notif-sub">{notif.name} ({notif.email}) wants to add you</span>
                      </>
                    ) : (
                      <>
                        <span className="notif-title">Room Invitation</span>
                        <span className="notif-sub">{notif.hostName} invited you to watch together (Room: {notif.roomId})</span>
                      </>
                    )}
                  </div>
                  <div className="notif-actions">
                    {notif.type === "friend_request" ? (
                      <>
                        <button className="notif-btn accept" onClick={() => acceptFriendRequest(notif.id)}>Accept</button>
                        <button className="notif-btn reject" onClick={() => rejectFriendRequest(notif.id)}>Decline</button>
                      </>
                    ) : (
                      <>
                        <button className="notif-btn accept" onClick={() => router.push(`/room/${notif.roomId}?role=viewer`)}>Join</button>
                        <button className="notif-btn reject" onClick={() => remove(ref(db, `invites/${myUid}/${notif.id}`))}>Dismiss</button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "profile" && (
          <div className="profile-container">
            <div className="profile-card">
              <div className="profile-avatar-large">
                {photoURL ? (
                  <img src={photoURL} alt={name} style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
                ) : (
                  name.charAt(0).toUpperCase()
                )}
              </div>
              <span className="profile-name">{name}</span>
              <span className="profile-email">{email}</span>
              
              <div className="profile-bio-box">
                <div className="profile-bio-label">Bio</div>
                <textarea 
                  className="profile-bio-textarea"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Tell your friends about yourself..."
                />
                <button className="profile-bio-save" onClick={saveBio}>Save Bio</button>
              </div>
            </div>

            {/* Watch memories history */}
            <div>
              <h2 className="memories-title">Watch Memories</h2>
              {memories.length === 0 ? (
                <div style={{ textAlign: "center", color: "#808290", padding: "20px" }}>
                  <p>Memories of watch sessions will appear here.</p>
                </div>
              ) : (
                memories.map((m, idx) => (
                  <div key={idx} className="memory-item">
                    <div className="memory-details">
                      <span className="memory-room">Room {m.roomId} ({m.role})</span>
                      <span className="memory-meta">Played {m.mood} on {m.date}</span>
                    </div>
                    <span className="memory-meta" style={{ fontWeight: 600, color: "#10b981" }}>{m.duration}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
