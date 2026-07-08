"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth, db, firestore } from "../lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { ref, set, get, push, onValue, remove, onDisconnect, query as rtdbQuery, limitToLast } from "firebase/database";
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, onSnapshot } from "firebase/firestore";
import CloudStickers from "../components/CloudStickers";

export default function DashboardPage() {
  const router = useRouter();

  // Navigation state
  const [activeTab, setActiveTab] = useState<"dashboard" | "friends" | "notifications" | "stickers" | "settings" | "profile">("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Appearance settings (global theme + font)
  const [appTheme, setAppTheme] = useState("gunmetal");
  const [appFont, setAppFont] = useState("inter");

  const THEMES = [
    { id: "gunmetal", name: "Gunmetal Emerald", sub: "Brushed steel, green glow", swatches: ["#16191e", "#10b981", "#e6ebf1"] },
    { id: "obsidian", name: "Obsidian Gold", sub: "Cinema luxury", swatches: ["#17140f", "#d4a944", "#f0e8d8"] },
    { id: "titanium", name: "Titanium Ice", sub: "Cold futuristic", swatches: ["#131820", "#2bb8d9", "#e3edf5"] },
    { id: "classic", name: "Nova Classic", sub: "The original look", swatches: ["#05070f", "#10b981", "#ffffff"] },
    { id: "rose", name: "Evening Rose", sub: "Warm and cozy", swatches: ["#1d0d15", "#e05586", "#f5e6ef"] }
  ];

  const FONTS = [
    { id: "inter", name: "Inter (Default)" },
    { id: "outfit", name: "Outfit" },
    { id: "poppins", name: "Poppins" },
    { id: "grotesk", name: "Space Grotesk" },
    { id: "manrope", name: "Manrope" },
    { id: "sora", name: "Sora" }
  ];

  useEffect(() => {
    try {
      setAppTheme(localStorage.getItem("nova_theme") || "gunmetal");
      setAppFont(localStorage.getItem("nova_font") || "inter");
      setSidebarCollapsed(localStorage.getItem("nova_sidebar_collapsed") === "true");
      const checkMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      setIsMobile(checkMobile);
      if (checkMobile) {
        setMode("youtube");
      }
    } catch {}
  }, []);

  const applyTheme = (id: string) => {
    setAppTheme(id);
    localStorage.setItem("nova_theme", id);
    if (id === "gunmetal") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", id);
  };

  const applyFont = (id: string) => {
    setAppFont(id);
    localStorage.setItem("nova_font", id);
    if (id === "inter") document.documentElement.removeAttribute("data-font");
    else document.documentElement.setAttribute("data-font", id);
  };

  // User details
  const [myUid, setMyUid] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [photoURL, setPhotoURL] = useState("");
  const [bio, setBio] = useState("");

  const [room, setRoom] = useState("");
  const [mode, setMode] = useState("party");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [isMobile, setIsMobile] = useState(false);
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
  const [friendStatuses, setFriendStatuses] = useState<Record<string, string>>({});
  const [notifications, setNotifications] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [publicRooms, setPublicRooms] = useState<any[]>([]);
  const [leftoverSessions, setLeftoverSessions] = useState<any[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [showHostModal, setShowHostModal] = useState(false);

  const PROFILE_KEY = "nova_user_profile";

  useEffect(() => {
    let unsubFriends: (() => void) | null = null;

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
      if (!user) {
        if (!localProfile) {
          router.push("/login");
        }
      } else {
        const uid = user.uid;
        setMyUid(uid);
        setLoading(false);
        syncUserData(uid);
        unsubFriends = listenToFriendsAndNotifs(uid);
        syncOnlineStatus(uid);

        // Auto-fix: if database/local storage has a fallback email, but Firebase Auth has the real email, update it!
        try {
          const parsed = localProfile ? JSON.parse(localProfile) : {};
          if (user.email && (!parsed.email || parsed.email.endsWith("@google.local"))) {
            console.log(">>> [Dashboard] Auto-syncing real Google email:", user.email);
            const updatedProfile = {
              uid: user.uid,
              name: user.displayName || user.email.split("@")[0] || "Nova User",
              email: user.email,
              provider: user.providerData?.[0]?.providerId || "google",
              photoURL: user.photoURL || ""
            };
            localStorage.setItem(PROFILE_KEY, JSON.stringify(updatedProfile));
            localStorage.setItem("watchparty_name", updatedProfile.name);
            localStorage.setItem("watchparty_email", updatedProfile.email);
            
            // Sync to RTDB
            set(ref(db, `users/${user.uid}`), {
              name: updatedProfile.name,
              email: updatedProfile.email,
              photoURL: updatedProfile.photoURL,
              provider: updatedProfile.provider,
              lastActive: Date.now()
            }).catch(err => console.error("Auto-sync RTDB fail:", err));
            
            // Sync to Firestore
            setDoc(doc(firestore, "users", user.uid), {
              name: updatedProfile.name,
              email: updatedProfile.email,
              photoURL: updatedProfile.photoURL,
              provider: updatedProfile.provider,
              lastActive: Date.now()
            }, { merge: true }).catch(err => console.error("Auto-sync Firestore fail:", err));
          }
        } catch (e) {
          console.warn("Auto-sync profile check failed:", e);
        }
      }
    });

    // Listen to active rooms limited to last 30 to conserve bandwidth
    const roomsRef = ref(db, "rooms");
    const roomsQuery = rtdbQuery(roomsRef, limitToLast(30));
    const unsubscribeRooms = onValue(roomsQuery, (snap) => {
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
              moodEmoji: val.moodEmoji || "🎬",
              mode: val.mode || "party",
              youtubeUrl: val.youtubeUrl || ""
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

    // Load leftover sessions
    try {
      const leftover = JSON.parse(localStorage.getItem("nova_leftover_sessions") || "[]");
      setLeftoverSessions(leftover);
    } catch {}

    return () => {
      unsubscribe();
      unsubscribeRooms();
      if (unsubFriends) unsubFriends();
    };
  }, [router]);

  // Listen to friends status in real-time from Realtime Database
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    friendsList.forEach((friend) => {
      const statusRef = ref(db, `status/${friend.uid}`);
      const unsub = onValue(statusRef, (snap) => {
        const val = snap.val();
        setFriendStatuses((prev) => ({
          ...prev,
          [friend.uid]: val?.state || "offline"
        }));
      });
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [friendsList]);

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
    const connectedRef = ref(db, ".info/connected");

    // Listen to Firebase connection state
    onValue(connectedRef, (snap) => {
      if (snap.val() === true) {
        // Automatically set status to offline when client disconnects (tab close, crash, internet drop)
        onDisconnect(statusRef)
          .set({ state: "offline", lastChanged: Date.now() })
          .then(() => {
            // Once onDisconnect is registered, set status to online
            set(statusRef, { state: "online", lastChanged: Date.now() });
          });
      }
    });

    // Fallback for clean tab close / navigation
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        set(statusRef, { state: "offline", lastChanged: Date.now() });
      });
    }
  };

  const listenToFriendsAndNotifs = (uid: string) => {
    const q = query(collection(firestore, "friendships"), where("uid", "==", uid));
    return onSnapshot(q, async (snapshot) => {
      const friendsListTemp: any[] = [];
      const notificationsTemp: any[] = [];

      for (const docItem of snapshot.docs) {
        const fData = docItem.data();
        const friendId = fData.friendId;
        const status = fData.status;

        if (status === "friend") {
          const friendSnap = await getDoc(doc(firestore, "users", friendId));
          const statusSnap = await get(ref(db, `status/${friendId}`));
          if (friendSnap.exists()) {
            friendsListTemp.push({
              uid: friendId,
              ...friendSnap.data(),
              status: statusSnap.exists() ? statusSnap.val().state : "offline"
            });
          }
        } else if (status === "incoming") {
          const friendSnap = await getDoc(doc(firestore, "users", friendId));
          if (friendSnap.exists()) {
            const data = friendSnap.data();
            notificationsTemp.push({
              id: friendId,
              type: "friend_request",
              name: data?.name || "User",
              email: data?.email || ""
            });
          }
        }
      }
      setFriendsList(friendsListTemp);

      // Also fetch room invites from Realtime Database
      const inviteSnap = await get(ref(db, `invites/${uid}`));
      if (inviteSnap.exists()) {
        Object.entries(inviteSnap.val()).forEach(([inviteId, val]: [string, any]) => {
          notificationsTemp.push({
            id: inviteId,
            type: "room_invite",
            roomId: val.roomId,
            hostName: val.hostName,
            mood: val.mood
          });
        });
      }
      setNotifications(notificationsTemp);
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
      mode: mode,
      youtubeUrl: mode === "youtube" ? youtubeUrl.trim() : "",
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
    try {
      const usersRef = collection(firestore, "users");
      const qSnap = await getDocs(usersRef);
      const results: any[] = [];
      qSnap.forEach((docItem) => {
        const val = docItem.data();
        const uid = docItem.id;
        if (uid !== myUid && val.name?.toLowerCase().includes(searchQuery.toLowerCase())) {
          results.push({ uid, name: val.name, email: val.email, photoURL: val.photoURL || "" });
        }
      });
      setSearchResults(results);
    } catch (err) {
      console.error("Search failed:", err);
      alert("Search failed due to database permissions.");
    }
  };

  const sendFriendRequest = async (targetUid: string) => {
    try {
      await setDoc(doc(firestore, "friendships", `${myUid}_${targetUid}`), {
        uid: myUid,
        friendId: targetUid,
        status: "outgoing",
        updatedAt: Date.now()
      });
      await setDoc(doc(firestore, "friendships", `${targetUid}_${myUid}`), {
        uid: targetUid,
        friendId: myUid,
        status: "incoming",
        updatedAt: Date.now()
      });
      alert("Friend request sent!");
      setSearchQuery("");
      setSearchResults([]);
    } catch (err) {
      console.error(err);
      alert("Failed to send friend request.");
    }
  };

  const acceptFriendRequest = async (targetUid: string) => {
    try {
      await setDoc(doc(firestore, "friendships", `${myUid}_${targetUid}`), {
        uid: myUid,
        friendId: targetUid,
        status: "friend",
        updatedAt: Date.now()
      });
      await setDoc(doc(firestore, "friendships", `${targetUid}_${myUid}`), {
        uid: targetUid,
        friendId: myUid,
        status: "friend",
        updatedAt: Date.now()
      });
      alert("Friend request accepted!");
    } catch (err) {
      console.error(err);
    }
  };

  const rejectFriendRequest = async (targetUid: string) => {
    try {
      await deleteDoc(doc(firestore, "friendships", `${myUid}_${targetUid}`));
      await deleteDoc(doc(firestore, "friendships", `${targetUid}_${myUid}`));
    } catch (err) {
      console.error(err);
    }
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
    try {
      // Save to RTDB
      await set(ref(db, `users/${myUid}/bio`), bio);
      // Save to Firestore as well
      await setDoc(doc(firestore, "users", myUid), { bio }, { merge: true });
      alert("Bio updated!");
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="dashboard-layout">
        <aside className={`sidebar-nav ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-brand">
            <div className="sidebar-brand-content">
              <div className="sidebar-brand-icon">
                <span className="material-symbols-outlined">favorite</span>
              </div>
              <h2>Nova</h2>
            </div>
          </div>
          <div className="sidebar-menu">
            <div className="shimmer-element" style={{ height: "44px", width: "100%", marginBottom: "8px" }}></div>
            <div className="shimmer-element" style={{ height: "44px", width: "100%", marginBottom: "8px" }}></div>
            <div className="shimmer-element" style={{ height: "44px", width: "100%" }}></div>
          </div>
        </aside>
        <main className="main-content">
          <div>
            <div className="dashboard-header-row">
              <h1>Active Rooms</h1>
              <div className="shimmer-element" style={{ width: "40px", height: "40px", borderRadius: "50%" }}></div>
            </div>

            <div className="rooms-grid" style={{ marginTop: "10px" }}>
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
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      {/* Left Sidebar Navigation */}
      <aside className={`sidebar-nav ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">
          <div className="sidebar-brand-content">
            <div className="sidebar-brand-icon">
              <span className="material-symbols-outlined">favorite</span>
            </div>
            <h2>Nova</h2>
          </div>
          <button 
            className="sidebar-collapse-btn" 
            onClick={() => {
              const newVal = !sidebarCollapsed;
              setSidebarCollapsed(newVal);
              localStorage.setItem("nova_sidebar_collapsed", String(newVal));
            }}
            title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            <span className="material-symbols-outlined">
              {sidebarCollapsed ? "menu" : "menu_open"}
            </span>
          </button>
        </div>

        <nav className="sidebar-menu">
          <button 
            className={`sidebar-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
            title={sidebarCollapsed ? "Dashboard" : undefined}
          >
            <span className="material-symbols-outlined">dashboard</span>
            <span className="sidebar-label">Dashboard</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === "friends" ? "active" : ""}`}
            onClick={() => setActiveTab("friends")}
            title={sidebarCollapsed ? "Friends" : undefined}
          >
            <span className="material-symbols-outlined">groups</span>
            <span className="sidebar-label">Friends</span>
          </button>
          <button 
            className={`sidebar-item ${activeTab === "notifications" ? "active" : ""}`}
            onClick={() => setActiveTab("notifications")}
            title={sidebarCollapsed ? "Invites & Notifications" : undefined}
          >
            <span className="material-symbols-outlined">notifications</span>
            <span className="sidebar-label">Invites & Notifs</span>
            {notifications.length > 0 && (
              <span style={{ marginLeft: "auto", background: "#ef4444", color: "#fff", borderRadius: "50%", padding: "2px 6px", fontSize: "10px", fontWeight: "bold" }}>
                {notifications.length}
              </span>
            )}
          </button>
          <button
            className={`sidebar-item ${activeTab === "stickers" ? "active" : ""}`}
            onClick={() => setActiveTab("stickers")}
            title={sidebarCollapsed ? "Stickers" : undefined}
          >
            <span className="material-symbols-outlined">emoji_emotions</span>
            <span className="sidebar-label">Stickers</span>
          </button>
          <button
            className={`sidebar-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
            title={sidebarCollapsed ? "Settings" : undefined}
          >
            <span className="material-symbols-outlined">tune</span>
            <span className="sidebar-label">Settings</span>
          </button>
          <button
            className={`sidebar-item ${activeTab === "profile" ? "active" : ""}`}
            onClick={() => setActiveTab("profile")}
            title={sidebarCollapsed ? "Profile" : undefined}
          >
            <span className="material-symbols-outlined">person</span>
            <span className="sidebar-label">Profile</span>
          </button>
        </nav>

        <div className="sidebar-user">
          <div className="sidebar-user-info">
            <div className="sidebar-user-avatar">
              {photoURL ? (
                <img src={photoURL} alt={name} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
              ) : (
                name.charAt(0).toUpperCase()
              )}
            </div>
            <div className="sidebar-user-details">
              <span className="sidebar-user-name">{name}</span>
            </div>
          </div>
          <button className="sidebar-user-logout" onClick={handleLogout} title={sidebarCollapsed ? "Logout" : undefined}>
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

            {(() => {
              const roomInvites = notifications.filter(n => n.type === "room_invite");
              if (roomInvites.length === 0) return null;
              return (
                <div style={{ marginBottom: "32px", background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "20px" }}>
                  <h2 style={{ fontSize: "16px", color: "var(--accent)", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px", fontWeight: "600" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>mail</span> Invited by Friends
                  </h2>
                  <div className="rooms-grid">
                    {roomInvites.map((invite) => (
                      <div key={invite.id} className="room-card" style={{ border: "1px dashed var(--accent)", background: "rgba(201, 75, 123, 0.03)" }}>
                        <div className="room-card-header">
                          <span className="room-mood-badge" style={{ background: "rgba(201, 75, 123, 0.12)", color: "var(--accent)" }}>
                            From {invite.hostName}
                          </span>
                        </div>
                        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                          <div style={{ fontSize: "14px", fontWeight: "600" }}>Room ID: {invite.roomId}</div>
                          <div style={{ fontSize: "11px", color: "var(--text-muted-2)" }}>Received {new Date(invite.timestamp || Date.now()).toLocaleTimeString()}</div>
                        </div>
                        <div className="room-card-footer" style={{ display: "flex", gap: "10px", marginTop: "auto" }}>
                          <button 
                            className="room-join-btn" 
                            style={{ flex: 1 }}
                            onClick={() => router.push(`/room/${invite.roomId}?role=viewer`)}
                          >
                            Join Room
                          </button>
                          <button 
                            className="room-join-btn" 
                            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text)", width: "auto" }}
                            onClick={() => remove(ref(db, `invites/${myUid}/${invite.id}`))}
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

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
              <div style={{ textAlign: "center", color: "var(--text-muted-2)", padding: "80px 20px" }}>
                <span className="material-symbols-outlined" style={{ fontSize: "64px", marginBottom: "16px", color: "rgba(var(--accent-rgb), 0.4)" }}>
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
                      {r.mode === "youtube" ? (
                        <span className="room-mood-badge youtube" style={{ display: "flex", alignItems: "center", gap: "6px", background: "rgba(239, 68, 68, 0.12)", color: "#ff4e4e", border: "1px solid rgba(239, 68, 68, 0.3)", padding: "4px 8px", borderRadius: "100px", fontSize: "11px", fontWeight: "600" }}>
                          <span style={{ color: "#ff4e4e", fontStyle: "normal", display: "flex", alignItems: "center" }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ marginRight: "4px" }}>
                              <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.107C19.522 3.5 12 3.5 12 3.5s-7.522 0-9.388.556a3.002 3.002 0 0 0-2.11 2.107C0 8.029 0 12 0 12s0 3.971.502 5.837a3.002 3.002 0 0 0 2.11 2.107C4.478 20.5 12 20.5 12 20.5s7.522 0 9.388-.556a3.002 3.002 0 0 0 2.11-2.107C24 15.971 24 12 24 12s0-3.971-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                            </svg>
                            YouTube
                          </span>
                        </span>
                      ) : (
                        <span className="room-mood-badge">
                          {r.moodEmoji} {r.moodLabel}
                        </span>
                      )}
                      <span className={`room-visibility-badge ${r.visibility}`}>
                        {r.visibility}
                      </span>
                    </div>

                    {r.mode === "youtube" && r.youtubeUrl && (() => {
                      const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
                      const match = r.youtubeUrl.match(regExp);
                      const vId = (match && match[2].length === 11) ? match[2] : r.youtubeUrl;
                      const thumbUrl = `https://img.youtube.com/vi/${vId}/mqdefault.jpg`;
                      return (
                        <div className="room-card-thumbnail" style={{ width: "100%", height: "130px", borderRadius: "10px", overflow: "hidden", marginTop: "8px", position: "relative", border: "1px solid rgba(255,255,255,0.06)" }}>
                          <img src={thumbUrl} alt="YouTube Stream" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 60%)" }}></div>
                          <span className="material-symbols-outlined" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", fontSize: "38px", color: "#fff", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))", opacity: 0.9 }}>
                            play_circle
                          </span>
                        </div>
                      );
                    })()}

                    <div className="room-host-info">
                      <div className="room-host-avatar">
                        {r.hostPhoto ? (
                          <img src={r.hostPhoto} alt={r.hostName} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
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
                          if (r.mode === "party" && isMobile) {
                            alert("Watch Party (WebRTC Screen Share) is desktop-only. You cannot join this room on mobile. Try hosting or joining a YouTube sync room!");
                            return;
                          }
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

            {/* Leftover Sessions Section */}
            {leftoverSessions.length > 0 && (
              <div style={{ marginTop: "40px", borderTop: "1px solid rgba(255, 255, 255, 0.05)", paddingTop: "30px" }}>
                <h2 style={{ fontSize: "18px", fontWeight: "700", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px", color: "#e2e8f0" }}>
                  <span className="material-symbols-outlined" style={{ color: "var(--accent)" }}>history</span>
                  Resume Leftover Sessions
                </h2>
                <div className="rooms-grid">
                  {leftoverSessions.map((session) => {
                    const remainingMin = Math.ceil((session.duration - session.currentTime) / 60);
                    const thumbUrl = `https://img.youtube.com/vi/${session.videoId}/mqdefault.jpg`;
                    return (
                      <div key={session.videoId} className="room-card" style={{ background: "rgba(255, 255, 255, 0.015)", border: "1px solid rgba(255,255,255,0.04)" }}>
                        <div style={{ position: "relative", height: "130px", borderRadius: "10px", overflow: "hidden", border: "1px solid rgba(255,255,255,0.06)" }}>
                          <img src={thumbUrl} alt="Thumbnail" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "4px", background: "rgba(255,255,255,0.15)" }}>
                            <div style={{ width: `${(session.currentTime / session.duration) * 100}%`, height: "100%", background: "var(--accent)" }}></div>
                          </div>
                          <span style={{ position: "absolute", bottom: "8px", right: "8px", background: "rgba(0,0,0,0.85)", padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600", color: "#fff" }}>
                            {remainingMin} min left
                          </span>
                        </div>
                        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                          <h3 style={{ fontSize: "13.5px", fontWeight: "600", color: "#f1f5f9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={session.title}>
                            {session.title}
                          </h3>
                          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                            Leftover Room Code: <strong style={{ color: "var(--accent)" }}>{session.roomId}</strong>
                          </span>
                        </div>
                        <div style={{ marginTop: "14px", display: "flex", gap: "10px" }}>
                          <button 
                            className="room-join-btn" 
                            style={{ flex: 1, padding: "8px" }}
                            onClick={() => {
                              setRoom(session.roomId);
                              setMode("youtube");
                              setYoutubeUrl(session.videoId);
                              try {
                                localStorage.setItem(`leftover_time_${session.roomId}`, session.currentTime.toString());
                              } catch (e) {}
                              setShowHostModal(true);
                            }}
                          >
                            Resume Session
                          </button>
                          <button
                            className="room-join-btn"
                            style={{ background: "rgba(239, 68, 68, 0.08)", color: "#f87171", border: "1px solid rgba(239, 68, 68, 0.15)", width: "38px", padding: 0 }}
                            onClick={() => {
                              const filtered = leftoverSessions.filter(item => item.videoId !== session.videoId);
                              setLeftoverSessions(filtered);
                              try {
                                localStorage.setItem("nova_leftover_sessions", JSON.stringify(filtered));
                              } catch (e) {}
                            }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>delete</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
                      <div className="modal-header" style={{ textAlign: "center", marginBottom: "12px" }}>
                        <div className="logo-container" style={{ margin: "0 auto 12px auto", width: "64px", height: "64px" }}>
                          <div className="logo-glow"></div>
                          <img src="/iconRm.png" alt="Nova" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        </div>
                        <h1 style={{ fontSize: "24px", fontWeight: "800", background: "linear-gradient(135deg, #ffffff 0%, var(--accent) 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginTop: "8px" }}>Nova</h1>
                        <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>Watch movies, shows & more — together in sync.</p>
                      </div>

                      <div style={{ marginTop: "10px" }}>
                        <div className="modal-section-title">Session Type</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                          <button 
                            className={`mode-btn ${mode === "party" ? "active-mode" : ""}`} 
                            onClick={() => !isMobile && setMode("party")}
                            disabled={isMobile}
                            style={{ opacity: isMobile ? 0.4 : 1, cursor: isMobile ? "not-allowed" : "pointer" }}
                            title={isMobile ? "Desktop Only" : ""}
                            type="button"
                          >
                            <span className="material-symbols-outlined">groups</span>
                            Watch Party {isMobile && "💻"}
                          </button>
                          <button 
                            className={`mode-btn ${mode === "youtube" ? "active-mode" : ""}`} 
                            onClick={() => setMode("youtube")}
                            type="button"
                            style={mode === "youtube" ? {
                              background: "rgba(239, 68, 68, 0.08)",
                              color: "#ff4e4e",
                              borderColor: "rgba(239, 68, 68, 0.35)",
                              boxShadow: "0 0 10px rgba(239, 68, 68, 0.12)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: "6px"
                            } : {
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: "6px"
                            }}
                          >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style={{ color: mode === "youtube" ? "#ff4e4e" : "var(--text-muted)" }}>
                              <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.107C19.522 3.5 12 3.5 12 3.5s-7.522 0-9.388.556a3.002 3.002 0 0 0-2.11 2.107C0 8.029 0 12 0 12s0 3.971.502 5.837a3.002 3.002 0 0 0 2.11 2.107C4.478 20.5 12 20.5 12 20.5s7.522 0 9.388-.556a3.002 3.002 0 0 0 2.11-2.107C24 15.971 24 12 24 12s0-3.971-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                            </svg>
                            YouTube
                          </button>
                        </div>
                      </div>

                      {mode === "youtube" && (
                        <div style={{ marginTop: "12px" }}>
                          <div className="modal-section-title">YouTube URL / Video ID</div>
                          <input 
                            className="modal-input" 
                            value={youtubeUrl} 
                            onChange={(e) => setYoutubeUrl(e.target.value)} 
                            placeholder="Paste YouTube Video URL or ID" 
                            required
                          />
                        </div>
                      )}

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
                      
                      <div className="modal-actions" style={{ display: "grid", gap: "12px", marginTop: "16px" }}>
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
                      <div className="friend-avatar">
                        {user.photoURL ? (
                          <img src={user.photoURL} alt={user.name} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
                        ) : (
                          user.name.charAt(0).toUpperCase()
                        )}
                      </div>
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
                <div style={{ textAlign: "center", color: "var(--text-muted-2)", padding: "40px" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: "48px", marginBottom: "8px" }}>group_off</span>
                  <p>No friends added yet.</p>
                </div>
              ) : (
                friendsList.map((friend) => (
                   <div key={friend.uid} className="friend-item">
                     <div className="friend-user-info">
                       <div className="friend-avatar">
                         {friend.photoURL ? (
                           <img src={friend.photoURL} alt={friend.name} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
                         ) : (
                           friend.name.charAt(0).toUpperCase()
                         )}
                         <span className={`status-dot ${(friendStatuses[friend.uid] || friend.status) === "online" ? "online" : "offline"}`}></span>
                       </div>
                       <div className="friend-details">
                         <span className="friend-name">{friend.name}</span>
                         <span className="friend-status-text">{friendStatuses[friend.uid] || friend.status}</span>
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
              <div style={{ textAlign: "center", color: "var(--text-muted-2)", padding: "40px" }}>
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

        {activeTab === "stickers" && (
          <div className="stickers-container">
            <div className="dashboard-header-row">
              <h1>Cloud Stickers</h1>
            </div>
            <p className="stickers-hint">
              Save your favourite stickers in folders — they sync to the cloud and are ready to use in any room chat.
            </p>
            {myUid ? (
              <CloudStickers uid={myUid} mode="manage" />
            ) : (
              <div style={{ color: "var(--text-muted-2)", padding: "40px", textAlign: "center" }}>Sign in to manage stickers.</div>
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <div className="settings-container">
            <div className="dashboard-header-row">
              <h1>Appearance</h1>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">
                <span className="material-symbols-outlined">palette</span>
                Theme
              </div>
              <div className="theme-cards-grid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-card ${appTheme === t.id ? "active" : ""}`}
                    onClick={() => applyTheme(t.id)}
                  >
                    <div className="theme-card-swatches">
                      {t.swatches.map((c) => (
                        <span key={c} className="theme-swatch" style={{ background: c }} />
                      ))}
                    </div>
                    <div className="theme-card-name">
                      {t.name}
                      {appTheme === t.id && <span className="material-symbols-outlined">check_circle</span>}
                    </div>
                    <div className="theme-card-sub">{t.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">
                <span className="material-symbols-outlined">text_fields</span>
                Font
              </div>
              <div className="font-select-row">
                <select className="font-select" value={appFont} onChange={(e) => applyFont(e.target.value)}>
                  {FONTS.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
                <span className="font-preview">The quick brown fox watches movies at night 🍿</span>
              </div>
            </div>

            <p className="stickers-hint">Theme and font apply everywhere — dashboard and inside rooms — and are saved on this device.</p>
          </div>
        )}

        {activeTab === "profile" && (
          <div className="profile-container">
            <div className="profile-card">
              <div className="profile-avatar-large">
                {photoURL ? (
                  <img src={photoURL} alt={name} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
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
                <div style={{ textAlign: "center", color: "var(--text-muted-2)", padding: "20px" }}>
                  <p>Memories of watch sessions will appear here.</p>
                </div>
              ) : (
                memories.map((m, idx) => (
                  <div key={idx} className="memory-item">
                    <div className="memory-details">
                      <span className="memory-room">Room {m.roomId} ({m.role})</span>
                      <span className="memory-meta">Played {m.mood} on {m.date}</span>
                    </div>
                    <span className="memory-meta" style={{ fontWeight: 600, color: "var(--accent)" }}>{m.duration}</span>
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
