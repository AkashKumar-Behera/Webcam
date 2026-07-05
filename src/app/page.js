"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "../lib/firebase";
import { onAuthStateChanged } from "firebase/auth";

export default function DashboardPage() {
  const router = useRouter();

  // State inputs
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [mode, setMode] = useState("party");
  const [mood, setMood] = useState({ id: "movie", emoji: "🎬", label: "Movie Night" });
  const [enableMic, setEnableMic] = useState(true);
  const [showHostSettings, setShowHostSettings] = useState(false);

  // Host stream options
  const [quality, setQuality] = useState("1080p");
  const [fps, setFps] = useState("30");
  const [codec, setCodec] = useState("h264");

  const [loading, setLoading] = useState(true);

  const PROFILE_KEY = "nova_user_profile";

  useEffect(() => {
    // Check local profile caching
    try {
      const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      if (profile) {
        setName(profile.name || "");
      }
    } catch (e) {
      console.warn("Could not read local profile:", e);
    }

    // Verify authentication
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const localProfile = localStorage.getItem(PROFILE_KEY);
      if (!user && !localProfile) {
        router.push("/login");
      } else {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [router]);

  const generateRoomCode = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoom(code);
  };

  const handleStartHost = () => {
    if (!name.trim()) {
      alert("Please enter your name.");
      return;
    }
    const finalRoom = room.trim() || Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Save to local storage for the room session
    localStorage.setItem("watchparty_name", name.trim());
    localStorage.setItem("watchparty_email", emailFromProfile() || `${name.trim().toLowerCase()}@manual.local`);
    localStorage.setItem("watchparty_room", finalRoom);
    localStorage.setItem("watchparty_mode", mode);
    localStorage.setItem("watchparty_mood_id", mood.id);
    localStorage.setItem("watchparty_mood_emoji", mood.emoji);
    localStorage.setItem("watchparty_mood_label", mood.label);
    localStorage.setItem("watchparty_host_mic", enableMic ? "true" : "false");
    localStorage.setItem("watchparty_stream_quality", quality);
    localStorage.setItem("watchparty_stream_fps", fps);
    localStorage.setItem("watchparty_stream_codec", codec);

    router.push(`/room/${finalRoom}?role=host`);
  };

  const handleJoin = () => {
    if (!name.trim()) {
      alert("Please enter your name.");
      return;
    }
    if (!room.trim()) {
      alert("Please enter a Room Code to join.");
      return;
    }

    localStorage.setItem("watchparty_name", name.trim());
    localStorage.setItem("watchparty_email", emailFromProfile() || `${name.trim().toLowerCase()}@manual.local`);
    localStorage.setItem("watchparty_room", room.trim());
    localStorage.setItem("watchparty_mode", mode);
    localStorage.setItem("watchparty_mood_id", mood.id);
    localStorage.setItem("watchparty_mood_emoji", mood.emoji);
    localStorage.setItem("watchparty_mood_label", mood.label);

    router.push(`/room/${room.trim()}?role=viewer`);
  };

  const emailFromProfile = () => {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      return p?.email;
    } catch {
      return null;
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#05070f] text-white">
        <div className="text-center">
          <span className="material-symbols-outlined text-4xl animate-spin text-[#ec4899]">autorenew</span>
          <p className="mt-2 text-sm text-[#94a3b8]">Loading Nova Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="page" style={{ background: "linear-gradient(135deg, #0e0a1a 0%, #05050a 100%)" }}>
      <div className="modal-card" style={{ display: "block", position: "relative" }}>
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
                  onChange={() => {}} // Controlled via parent click
                  style={{ width: "18px", height: "18px", cursor: "pointer" }} 
                />
                <div>
                  <div className="mic-option-text-title">Enable Microphone</div>
                  <div className="mic-option-text-sub">Include live commentary while hosting</div>
                </div>
              </div>
            )}

            <div className="modal-actions" style={{ display: "grid", gap: "12px", marginTop: "10px" }}>
              <button className="modal-btn host-btn" onClick={handleStartHost}>
                <span className="material-symbols-outlined">cast</span>
                Start Hosting
              </button>
              <button className="modal-btn join-btn" onClick={handleJoin}>
                <span className="material-symbols-outlined">login</span>
                Join Session
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
    </main>
  );
}
