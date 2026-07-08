"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { storage } from "../lib/firebase";
import {
  ref as sRef,
  listAll,
  getDownloadURL,
  uploadBytes,
  uploadString,
  deleteObject
} from "firebase/storage";

type Sticker = { name: string; fullPath: string; url: string };

type Props = {
  uid: string;
  mode: "manage" | "picker";
  onSelect?: (url: string) => void;
};

// Simple in-memory cache so the picker opens instantly after first load
const stickerCache: Record<string, Sticker[]> = {};
let folderCache: string[] | null = null;

export default function CloudStickers({ uid, mode, onSelect }: Props) {
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>("");
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [loadingStickers, setLoadingStickers] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rootPath = "stickers/global";

  const loadFolders = useCallback(async (force = false) => {
    // Read from localStorage cache first for instant load
    try {
      const cached = localStorage.getItem("nova_folders_cache");
      if (cached && !force) {
        const parsed = JSON.parse(cached);
        setFolders(parsed);
        setLoadingFolders(false);
        if (parsed.length > 0) setActiveFolder((f) => f || parsed[0]);
      }
    } catch (e) {}

    try {
      const res = await listAll(sRef(storage, rootPath));
      const names = res.prefixes.map((p) => p.name);
      
      const cached = localStorage.getItem("nova_folders_cache");
      if (force || !cached || JSON.stringify(names) !== cached) {
        localStorage.setItem("nova_folders_cache", JSON.stringify(names));
        setFolders(names);
        if (names.length > 0) setActiveFolder((f) => f || names[0]);
      }
    } catch (err) {
      console.error("Failed to list sticker folders:", err);
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  const loadStickers = useCallback(async (folder: string, force = false) => {
    if (!folder) return;
    const cacheKey = `nova_stickers_cache_${folder}`;

    // Read from localStorage cache first for instant load
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached && !force) {
        const parsed = JSON.parse(cached);
        setStickers(parsed);
      }
    } catch (e) {}

    // Show loading spinner only if we don't have cached data to avoid flicker
    if (!localStorage.getItem(cacheKey)) {
      setLoadingStickers(true);
    }
    
    try {
      const res = await listAll(sRef(storage, `${rootPath}/${folder}`));
      const items = res.items.filter((i) => i.name !== ".keep");
      const list: Sticker[] = await Promise.all(
        items.map(async (item) => ({
          name: item.name,
          fullPath: item.fullPath,
          url: await getDownloadURL(item)
        }))
      );
      
      const cached = localStorage.getItem(cacheKey);
      if (force || !cached || JSON.stringify(list) !== cached) {
        localStorage.setItem(cacheKey, JSON.stringify(list));
        setStickers(list);
      }
    } catch (err) {
      console.error("Failed to load stickers:", err);
      setStickers([]);
    } finally {
      setLoadingStickers(false);
    }
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);
  useEffect(() => {
    if (activeFolder) loadStickers(activeFolder);
    else setStickers([]);
  }, [activeFolder, loadStickers]);

  const createFolder = async () => {
    const name = newFolderName.trim().replace(/[\/\\.#$\[\]]/g, "");
    if (!name) return;
    if (folders.includes(name)) { setActiveFolder(name); setShowNewFolder(false); return; }
    try {
      // Storage has no empty folders — a .keep placeholder makes it exist in the cloud
      await uploadString(sRef(storage, `${rootPath}/${name}/.keep`), "");
      await loadFolders(true);
      setActiveFolder(name);
      setNewFolderName("");
      setShowNewFolder(false);
    } catch (err) {
      console.error("Failed to create folder:", err);
      alert("Folder create nahi hua. Check Firebase Storage rules.");
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !activeFolder) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 2_000_000) { alert(`${file.name} is too large (max 2MB)`); continue; }
        const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "")}`;
        await uploadBytes(sRef(storage, `${rootPath}/${activeFolder}/${safeName}`), file);
      }
      await loadStickers(activeFolder, true);
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Sticker upload failed. Check Firebase Storage rules.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const deleteSticker = async (sticker: Sticker) => {
    if (!confirm(`Delete sticker "${sticker.name}"?`)) return;
    try {
      await deleteObject(sRef(storage, sticker.fullPath));
      await loadStickers(activeFolder, true);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const deleteFolder = async (folder: string) => {
    if (!confirm(`Delete folder "${folder}" and all its stickers?`)) return;
    try {
      const res = await listAll(sRef(storage, `${rootPath}/${folder}`));
      await Promise.all(res.items.map((item) => deleteObject(item)));
      localStorage.removeItem(`nova_stickers_cache_${folder}`);
      setActiveFolder("");
      await loadFolders(true);
    } catch (err) {
      console.error("Folder delete failed:", err);
    }
  };

  const isPicker = mode === "picker";

  return (
    <div className={`stk-panel ${isPicker ? "stk-picker" : "stk-manage"}`}>
      {/* Folder tabs */}
      <div className="stk-folder-bar">
        {loadingFolders ? (
          <span className="stk-muted">Loading folders…</span>
        ) : (
          <>
            {folders.map((f) => (
              <button
                key={f}
                className={`stk-folder-chip ${activeFolder === f ? "active" : ""}`}
                onClick={() => setActiveFolder(f)}
              >
                <span className="material-symbols-outlined">folder</span>
                {f}
                {!isPicker && activeFolder === f && (
                  <span
                    className="material-symbols-outlined stk-folder-del"
                    title="Delete folder"
                    onClick={(e) => { e.stopPropagation(); deleteFolder(f); }}
                  >
                    delete
                  </span>
                )}
              </button>
            ))}
            {!isPicker && (
              showNewFolder ? (
                <span className="stk-newfolder-row">
                  <input
                    autoFocus
                    className="stk-newfolder-input"
                    placeholder="Folder name"
                    value={newFolderName}
                    maxLength={30}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
                  />
                  <button className="stk-mini-btn" onClick={createFolder}>
                    <span className="material-symbols-outlined">check</span>
                  </button>
                </span>
              ) : (
                <button className="stk-folder-chip stk-add" onClick={() => setShowNewFolder(true)}>
                  <span className="material-symbols-outlined">create_new_folder</span>
                  New
                </button>
              )
            )}
          </>
        )}
      </div>

      {/* Sticker grid */}
      <div className="stk-grid-wrap">
        {!activeFolder && !loadingFolders ? (
          <div className="stk-empty">
            <span className="material-symbols-outlined">emoji_emotions</span>
            <p>{isPicker ? "No sticker folders yet. Create them from the Dashboard → Stickers tab." : "Create a folder to start saving stickers."}</p>
          </div>
        ) : loadingStickers ? (
          <div className="stk-grid">
            {[1, 2, 3, 4, 5, 6].map((n) => <div key={n} className="stk-item shimmer-element" />)}
          </div>
        ) : stickers.length === 0 && activeFolder ? (
          <div className="stk-empty">
            <span className="material-symbols-outlined">add_photo_alternate</span>
            <p>{isPicker ? "This folder is empty." : "Upload PNG / GIF / WebP stickers to this folder."}</p>
          </div>
        ) : (
          <div className="stk-grid">
            {stickers.map((s) => (
              <div key={s.fullPath} className="stk-item" onClick={() => isPicker && onSelect?.(s.url)}>
                <img src={s.url} alt={s.name} loading="lazy" />
                {!isPicker && (
                  <button className="stk-del" title="Delete" onClick={() => deleteSticker(s)}>
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload row (manage mode only) */}
      {!isPicker && activeFolder && (
        <div className="stk-upload-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/gif,image/webp,image/jpeg"
            multiple
            style={{ display: "none" }}
            onChange={(e) => handleUpload(e.target.files)}
          />
          <button className="stk-upload-btn" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <span className="material-symbols-outlined">{uploading ? "hourglass_top" : "upload"}</span>
            {uploading ? "Uploading…" : `Upload to "${activeFolder}"`}
          </button>
        </div>
      )}
    </div>
  );
}
