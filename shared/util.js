/* Small helpers shared by the app, the engine and the service worker. */

export const uid = (prefix = "id") =>
  prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randInt = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
};

/* Delays clustered around the middle of the range instead of a flat
   distribution, which looks less mechanical to Facebook. */
export const jitterInt = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (hi - lo < 2) return Math.round(lo + Math.random() * (hi - lo));
  const mean = (lo + hi) / 2;
  const stdDev = (hi - lo) / 6;
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(Math.min(hi, Math.max(lo, mean + normal * stdDev)));
};

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const now = () => Date.now();

export const todayKey = (ts = Date.now()) => {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

export const fmtTime = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export const fmtDateTime = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
};

export const fmtDuration = (ms) => {
  if (!ms || ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return m + "m " + String(rs).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
};

/* Human label for a delay range: seconds when both ends are short,
   otherwise whole minutes. Keeps "25–50 s" from becoming "0–1 min". */
export const fmtDelay = (minSec, maxSec) => {
  const min = Math.max(0, Math.round(Number(minSec) || 0));
  const max = Math.max(0, Math.round(Number(maxSec) || 0));
  if (!min && !max) return "por defecto";
  if (max < 90) return Math.min(min, max) + "–" + max + " s";
  return Math.round(min / 60) + "–" + Math.round(max / 60) + " min";
};

export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const download = (filename, content, mime = "application/json") => {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

export const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });

export const pickFile = (accept) =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files && input.files[0] ? input.files[0] : null), { once: true });
    input.click();
  });

export const normalizeGroupUrl = (raw) => {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return "https://www.facebook.com/groups/" + value + "/";
  try {
    const url = new URL(value.startsWith("http") ? value : "https://www.facebook.com/" + value.replace(/^\/+/, ""));
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/groups\/([^/]+)/);
    if (!match) return null;
    return "https://www.facebook.com/groups/" + match[1] + "/";
  } catch {
    return null;
  }
};
