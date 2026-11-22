/* Persistence layer. Everything lives in chrome.storage.local so the app,
   the offscreen engine and the service worker all read the same state. */

import { todayKey, uid } from "./util.js";

export const KEYS = {
  settings: "settings",
  groups: "groups",
  lists: "lists",
  campaigns: "campaigns",
  log: "log",
  run: "run",
  diagnostics: "diagnostics",
  groupStats: "groupStats"
};

export const DEFAULT_SETTINGS = {
  theme: "system",
  minDelaySec: 120,
  maxDelaySec: 300,
  safetyEvery: 0,
  safetySec: 300,
  retryOnce: true,
  maxLogEntries: 5000,

  /* auto = UI primero, API como respaldo. ui = solo navegador real.
     ajax = endpoint clasico. graphql = mutacion configurable. */
  transport: "auto",
  windowMode: "hidden", // legado: ya no se abren ventanas, manda workTarget
  workTarget: "tab", // tab = pestaña de Facebook ya abierta | window = ventana propia
  dailyLimit: 30, // 0 = sin limite
  safetyPreset: "balanced", // maximum | balanced | turbo | custom
  scrollPresence: true,
  shareButton: true,
  shuffleGroups: false, // barajar el orden de los grupos al lanzar
  focusWorker: false, // no robar el foco; la ventana queda en segundo plano
  debugLogs: false, // trazas detalladas de cada post (solo para diagnóstico)

  /* IA opcional. Por defecto viene activada con el worker de IA del repo de
     referencia (preconfigurado) y el usuario puede cambiar a un endpoint propio
     compatible con OpenAI o desactivarla. */
  aiEnabled: false,
  aiProvider: "worker", // worker | custom | off
  aiWorkerUrl: "https://fb-smart-poster.0amaal89.workers.dev",
  aiTone: "engaging", // engaging | enthusiastic | professional | casual
  aiStyle: "moderate", // moderate | subtle | creative
  aiLanguage: "auto", // darija | arabic | french | english | auto
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",

  graphqlDocId: "",
  graphqlFriendlyName: "CometGroupDiscussionComposerCreateMutation",
  graphqlTemplate: ""
};

export const EMPTY_RUN = {
  id: null,
  status: "idle", // idle | running | paused | stopping | done | error
  campaignId: null,
  campaignName: "",
  queue: [],
  cursor: 0,
  okCount: 0,
  failCount: 0,
  skipCount: 0,
  consecutiveFails: 0,
  current: null,
  nextAt: 0,
  breakUntil: 0,
  startedAt: 0,
  finishedAt: 0,
  lastError: "",
  pauseReason: "",
  heartbeat: 0
};

const isExtensionContext = () =>
  typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id);

const getArea = () => (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null);

const LS_PREFIX = "gp_store:";

const lsRead = (key, fallback) => {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const lsWrite = (values) => {
  try {
    if (typeof localStorage === "undefined") return;
    const changes = {};
    for (const [key, newValue] of Object.entries(values || {})) {
      const oldValue = lsRead(key, undefined);
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(newValue));
      changes[key] = { oldValue, newValue };
    }
    if (typeof window !== "undefined" && Object.keys(changes).length) {
      window.dispatchEvent(new CustomEvent("gp:storage-changed", { detail: changes }));
    }
  } catch {
    /* ignore */
  }
};

const lsRemove = (keys) => {
  try {
    if (typeof localStorage === "undefined") return;
    const changes = {};
    for (const key of keys || []) {
      const oldValue = lsRead(key, undefined);
      localStorage.removeItem(LS_PREFIX + key);
      changes[key] = { oldValue, newValue: undefined };
    }
    if (typeof window !== "undefined" && Object.keys(changes).length) {
      window.dispatchEvent(new CustomEvent("gp:storage-changed", { detail: changes }));
    }
  } catch {
    /* ignore */
  }
};

/* Offscreen documents do not always expose chrome.storage. In that case the
   service worker relays the read/write, so every context shares the same data. */
const relay = (message) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (data) => resolve(data));
    } catch {
      resolve(null);
    }
  });

export const get = (key, fallback) =>
  new Promise((resolve) => {
    const area = getArea();
    if (!area || typeof area.get !== "function") {
      if (!isExtensionContext()) {
        resolve(lsRead(key, fallback));
        return;
      }
      relay({ type: "gp:storageGet", keys: [key] }).then((data) => {
        const value = data ? data[key] : undefined;
        resolve(value === undefined ? fallback : value);
      });
      return;
    }
    area.get([key], (data) => {
      const value = data ? data[key] : undefined;
      resolve(value === undefined ? fallback : value);
    });
  });

export const set = (values) =>
  new Promise((resolve) => {
    const area = getArea();
    if (!area || typeof area.set !== "function") {
      if (!isExtensionContext()) {
        lsWrite(values);
        resolve(true);
        return;
      }
      relay({ type: "gp:storageSet", values }).then(() => resolve(true));
      return;
    }
    area.set(values, () => resolve(true));
  });

export const remove = (keys) =>
  new Promise((resolve) => {
    const area = getArea();
    if (!area || typeof area.remove !== "function") {
      if (!isExtensionContext()) {
        lsRemove(keys);
        resolve(true);
        return;
      }
      relay({ type: "gp:storageRemove", keys }).then(() => resolve(true));
      return;
    }
    area.remove(keys, () => resolve(true));
  });

export const getSettings = async () => {
  const saved = await get(KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
};

export const saveSettings = async (patch) => {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set({ [KEYS.settings]: next });
  return next;
};

export const getRun = async () => {
  const saved = await get(KEYS.run, null);
  return { ...EMPTY_RUN, ...(saved || {}) };
};

export const saveRun = (run) => set({ [KEYS.run]: run });

export const onChanged = (callback) => {
  const listener = (changes, area) => {
    if (area !== "local") return;
    callback(changes);
  };
  try {
    /* The event lives on chrome.storage, NOT on chrome.storage.local. */
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
      chrome.storage.onChanged.addListener(listener);
      return () => {
        try {
          chrome.storage.onChanged.removeListener(listener);
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") {
    const localListener = (event) => {
      if (event && event.detail) callback(event.detail);
    };
    window.addEventListener("gp:storage-changed", localListener);
    return () => window.removeEventListener("gp:storage-changed", localListener);
  }
  return () => {};
};

/* ---------- log ---------- */

export const readLog = async () => {
  const log = await get(KEYS.log, []);
  return Array.isArray(log) ? log : [];
};

export const appendLog = async (entries) => {
  const list = Array.isArray(entries) ? entries : [entries];
  if (!list.length) return;
  const log = await readLog();
  const settings = await getSettings();
  const merged = log.concat(list);
  const capped = merged.slice(-Math.max(100, Number(settings.maxLogEntries) || 5000));
  await set({ [KEYS.log]: capped });
};

export const clearLog = () => set({ [KEYS.log]: [] });

export const countPostedToday = async () => {
  const log = await readLog();
  const today = todayKey();
  return log.filter((entry) => (entry.status === "posted" || entry.status === "pending") && entry.day === today).length;
};

export const makeLogEntry = (patch) => ({
  id: uid("log"),
  ts: Date.now(),
  day: todayKey(),
  campaignId: null,
  campaignName: "",
  groupId: "",
  groupName: "",
  status: "info", // posted | pending | failed | skipped | break | info
  postUrl: "",
  message: ""
  ,
  ...patch
});

/* ---------- groups / lists / campaigns / stats ---------- */

export const readGroups = async () => {
  const groups = await get(KEYS.groups, []);
  return Array.isArray(groups) ? groups : [];
};

export const saveGroups = (groups) => set({ [KEYS.groups]: groups });

export const readGroupStats = async () => {
  const stats = await get(KEYS.groupStats, {});
  return stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
};

export const saveGroupStats = (stats) => set({ [KEYS.groupStats]: stats || {} });

export const recordGroupOutcome = async ({
  groupId,
  status,
  ts = Date.now(),
  postUrl = "",
  error = "",
  requiresApproval = false
}) => {
  const id = String(groupId || "").trim();
  if (!id) return;
  const stats = await readGroupStats();
  const prev = stats[id] || {
    posted: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    lastPostAt: 0,
    lastStatus: "",
    lastPostUrl: "",
    lastError: "",
    requiresApproval: false
  };
  const next = {
    ...prev,
    posted: prev.posted + (status === "posted" ? 1 : 0),
    pending: prev.pending + (status === "pending" ? 1 : 0),
    failed: prev.failed + (status === "failed" ? 1 : 0),
    skipped: (prev.skipped || 0) + (status === "skipped" ? 1 : 0),
    lastPostAt: ts,
    lastStatus: status,
    lastPostUrl: postUrl || prev.lastPostUrl || "",
    lastError: status === "failed" || status === "skipped" ? String(error || "") : "",
    requiresApproval: Boolean(prev.requiresApproval || requiresApproval || status === "pending")
  };
  await saveGroupStats({ ...stats, [id]: next });

  if (next.requiresApproval) {
    const groups = await readGroups();
    let changed = false;
    const updated = groups.map((g) => {
      if (g.id !== id || g.requiresApproval) return g;
      changed = true;
      return { ...g, requiresApproval: true };
    });
    if (changed) await saveGroups(updated);
  }
};

export const buildGroupMetrics = (groupStats = {}, log = []) => {
  const result = {};
  for (const [id, entry] of Object.entries(groupStats || {})) {
    if (entry && typeof entry === "object") result[id] = { ...entry };
  }
  for (const item of log || []) {
    const id = item && item.groupId ? String(item.groupId) : "";
    if (!id) continue;
    if (!["posted", "pending", "failed", "skipped"].includes(item.status)) continue;
    if (groupStats && groupStats[id]) continue;
    const cur = result[id] || {
      posted: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
      lastPostAt: 0,
      lastStatus: "",
      lastPostUrl: "",
      lastError: "",
      requiresApproval: false
    };
    if (item.status === "posted") cur.posted += 1;
    if (item.status === "pending") {
      cur.pending += 1;
      cur.requiresApproval = true;
    }
    if (item.status === "failed") cur.failed += 1;
    if (item.status === "skipped") cur.skipped += 1;
    if ((item.ts || 0) >= cur.lastPostAt) {
      cur.lastPostAt = item.ts || 0;
      cur.lastStatus = item.status;
      if (item.postUrl) cur.lastPostUrl = item.postUrl;
      if (item.status === "failed" || item.status === "skipped") cur.lastError = item.message || "";
    }
    if (/pendiente de aprobación/i.test(String(item.message || ""))) {
      cur.requiresApproval = true;
    }
    result[id] = cur;
  }
  return result;
};

export const readLists = async () => {
  const lists = await get(KEYS.lists, []);
  return Array.isArray(lists) ? lists : [];
};

export const saveLists = (lists) => set({ [KEYS.lists]: lists });

export const readCampaigns = async () => {
  const campaigns = await get(KEYS.campaigns, []);
  return Array.isArray(campaigns) ? campaigns : [];
};

export const saveCampaigns = (campaigns) => set({ [KEYS.campaigns]: campaigns });

export const readDiagnostics = async () => {
  const diag = await get(KEYS.diagnostics, []);
  return Array.isArray(diag) ? diag : [];
};

export const pushDiagnostic = async (entry) => {
  const diag = await readDiagnostics();
  const next = diag.concat({ ts: Date.now(), ...entry }).slice(-200);
  await set({ [KEYS.diagnostics]: next });
};
