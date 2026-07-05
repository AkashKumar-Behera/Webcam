import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBhJ96UNB5hvXuPC1c6F3pP1lMgvtLcijw",
  authDomain: "nova-meet-a8089.firebaseapp.com",
  databaseURL: "https://nova-meet-a8089-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nova-meet-a8089",
  storageBucket: "nova-meet-a8089.firebasestorage.app",
  messagingSenderId: "96662292995",
  appId: "1:96662292995:web:c0530653c04f6cfd54dc36"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getDatabase(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export { app, auth, db, googleProvider };
