"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithPopup, signInWithRedirect, getRedirectResult } from "firebase/auth";
import { ref, set, get } from "firebase/database";
import { auth, db, googleProvider } from "../../lib/firebase";

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPage = searchParams.get("next") || "/";

  const [activeSignUp, setActiveSignUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const PROFILE_KEY = "nova_user_profile";

  useEffect(() => {
    // Read profile on mount
    try {
      const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      if (saved) {
        setName(saved.name || "");
        setEmail(saved.email || "");
      }
    } catch (e) {
      console.warn("Failed to load cached profile:", e);
    }

    // Handle Google Redirect login results
    getRedirectResult(auth)
      .then(async (result) => {
        if (result?.user) {
          setStatus("Completing Google sign-in...");
          await finishLogin(profileFromGoogle(result.user));
        }
      })
      .catch((err) => {
        console.error(err);
        setStatus("Google redirect login failed. Try again.");
      });
  }, []);

  const saveProfile = (profile) => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    localStorage.setItem("watchparty_name", profile.name);
    localStorage.setItem("watchparty_email", profile.email);
    localStorage.setItem("nova_auth_provider", profile.provider);
  };

  const saveUserRecord = async (profile) => {
    try {
      await set(ref(db, `users/${profile.uid}`), {
        name: profile.name,
        email: profile.email,
        provider: profile.provider,
        photoURL: profile.photoURL || "",
        lastLogin: Date.now()
      });
    } catch (err) {
      console.warn("User profile save skipped:", err);
    }
  };

  const finishLogin = async (profile) => {
    saveProfile(profile);
    await saveUserRecord(profile);
    router.push(nextPage);
  };

  const profileFromGoogle = (user) => {
    return {
      uid: user.uid,
      name: user.displayName || user.email?.split("@")[0] || "Nova User",
      email: user.email || "",
      provider: "google",
      photoURL: user.photoURL || ""
    };
  };

  const profileFromManual = (nameInput, emailInput) => {
    const safeEmail = emailInput.toLowerCase().trim();
    return {
      uid: `manual_${safeEmail.replace(/[^a-z0-9]/g, "_").slice(0, 48)}`,
      name: nameInput.trim(),
      email: safeEmail,
      provider: "manual",
      photoURL: ""
    };
  };

  const handleGoogleLogin = async () => {
    setStatus("Opening Google sign-in...");
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      await finishLogin(profileFromGoogle(result.user));
    } catch (err) {
      if (["auth/popup-blocked", "auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) {
        setStatus("Popup blocked. Redirecting to Google...");
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      console.error(err);
      setStatus("Google login failed. Check Firebase settings.");
      setLoading(false);
    }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (activeSignUp) {
      // Sign Up Mode
      if (!name || !email) return setStatus("Name and email are required.");
      setStatus("Creating profile...");
      await finishLogin(profileFromManual(name, email));
    } else {
      // Sign In Mode
      if (!email) return setStatus("Email is required.");
      setStatus("Verifying profile...");
      const tempUid = `manual_${email.toLowerCase().trim().replace(/[^a-z0-9]/g, "_").slice(0, 48)}`;
      try {
        const snapshot = await get(ref(db, `users/${tempUid}`));
        if (snapshot.exists()) {
          const userData = snapshot.val();
          await finishLogin({
            uid: tempUid,
            name: userData.name || "Nova User",
            email: email.toLowerCase().trim(),
            provider: "manual",
            photoURL: ""
          });
        } else {
          // Check local cache fallback
          const cached = readProfileFallback();
          if (cached && cached.email.toLowerCase().trim() === email.toLowerCase().trim() && cached.name) {
            await finishLogin(cached);
          } else {
            setStatus("Profile not found. Please Register first (New to Nova?).");
          }
        }
      } catch (err) {
        console.warn("DB lookup failed, logging in with fallback name...", err);
        const fallbackName = email.split("@")[0];
        await finishLogin(profileFromManual(fallbackName, email));
      }
    }
  };

  const readProfileFallback = () => {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); }
    catch { return null; }
  };

  return (
    <section className={`login-shell ${activeSignUp ? "active-signup" : ""}`} id="loginShell" aria-label="Login">
      {/* Left Panel: Logo & Features */}
      <div className="left-panel">
        <svg className="curved-lines-bg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M-10 100 C15 70, 45 60, 110 90" stroke="rgba(16,185,129,0.06)" strokeWidth="1" />
          <path d="M-10 100 C20 60, 50 50, 110 80" stroke="rgba(16,185,129,0.08)" strokeWidth="1.5" />
          <path d="M-10 100 C25 50, 55 40, 110 70" stroke="rgba(16,185,129,0.04)" strokeWidth="1" />
          <path d="M0 -10 C30 25, 70 35, 110 10" stroke="rgba(16,185,129,0.06)" strokeWidth="1" />
          <path d="M0 -10 C35 35, 75 45, 110 20" stroke="rgba(16,185,129,0.04)" strokeWidth="1.2" />
        </svg>
        <div className="dot-grid"></div>
        
        <div className="brand-hero">
          <div className="logo-container">
            <div className="logo-glow"></div>
            <img src="/icon.png" alt="Nova" />
          </div>
          <h2>Nova</h2>
          <p>Sign in to coordinate media rooms and sync streams.</p>
        </div>

        <div className="badge-row">
          <div className="badge-item">
            <span className="material-symbols-outlined">security</span>
            Secure
          </div>
          <div className="badge-item">
            <span className="material-symbols-outlined">sync</span>
            Sync
          </div>
          <div className="badge-item">
            <span className="material-symbols-outlined">groups</span>
            Together
          </div>
        </div>
      </div>

      {/* Right Panel: Sign In Form (Default visible) */}
      <div className="form-container signin-container">
        <div className="header-text">
          <h1>Welcome Back</h1>
          <p>Sign in to continue to your account.</p>
        </div>

        <div className="auth-stack">
          <button className="google-btn" onClick={handleGoogleLogin} disabled={loading} type="button">
            <span className="google-mark">
              <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            </span>
            Continue with Google
          </button>

          <div className="divider">or continue manually</div>

          <form className="form" onSubmit={handleManualSubmit}>
            <label className="field" aria-label="Email">
              <span className="material-symbols-outlined">mail</span>
              <input 
                id="emailInput" 
                name="email" 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address" 
                required 
              />
            </label>
            <label className="field" aria-label="Password">
              <span className="material-symbols-outlined">lock</span>
              <input 
                id="passwordInput" 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password" 
              />
            </label>
            
            <div className="options-row">
              <label className="remember-me">
                <input type="checkbox" id="rememberMeCheckbox" defaultChecked />
                <span className="custom-checkbox"></span>
                Remember me
              </label>
              <a href="#" className="forgot-link" onClick={() => alert("Manual profiles do not use passwords. Just enter your email to connect.")}>Forgot password?</a>
            </div>

            <button className="primary-btn" type="submit" disabled={loading}>
              Continue to Dashboard
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </form>
        </div>

        <div className="status" id="statusText">{status}</div>

        <p className="footer-text">
          New to Nova?{" "}
          <span className="switch-link" onClick={() => setActiveSignUp(true)}>Register Profile</span>
        </p>
      </div>

      {/* Right Panel: Sign Up Form (Swapped view via slide) */}
      <div className="form-container signup-container">
        <div className="header-text">
          <h1>Create Account</h1>
          <p>Register a new manual user profile.</p>
        </div>

        <div className="auth-stack">
          <button className="google-btn" onClick={handleGoogleLogin} disabled={loading} type="button">
            <span className="google-mark">
              <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            </span>
            Continue with Google
          </button>

          <div className="divider">or register manually</div>

          <form className="form" onSubmit={handleManualSubmit}>
            <label className="field" aria-label="Name">
              <span className="material-symbols-outlined">person</span>
              <input 
                id="nameInputSignUp" 
                name="name" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name" 
                required 
              />
            </label>
            <label className="field" aria-label="Email">
              <span className="material-symbols-outlined">mail</span>
              <input 
                id="emailInputSignUp" 
                name="email" 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address" 
                required 
              />
            </label>
            <label className="field" aria-label="Password">
              <span className="material-symbols-outlined">lock</span>
              <input 
                id="passwordInputSignUp" 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create password" 
                required 
              />
            </label>
            
            <button className="primary-btn" type="submit" disabled={loading}>
              Create Profile & Continue
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </form>
        </div>

        <p className="footer-text">
          Already have a profile?{" "}
          <span className="switch-link" onClick={() => setActiveSignUp(false)}>Sign In</span>
        </p>
      </div>
    </section>
  );
}

export default function LoginPage() {
  return (
    <main className="page">
      <Suspense fallback={<div className="status">Loading...</div>}>
        <LoginFormContent />
      </Suspense>
    </main>
  );
}
