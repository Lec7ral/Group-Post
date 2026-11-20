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
  diagnostics: "diagnostics"
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
  aiEnabled: true,
  aiProvider: "worker", // worker | custom | off
  aiWorkerUrl: "https://fb-smart-poster.0amaal89.workers.dev",
  aiTone: "engaging", // engaging | enthusiastic | professional | casual
  aiStyle: "moderate", // moderate | subtle | creative
  aiLanguage: "darija", // darija | arabic | french | english | auto
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

const getArea = () => (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null);

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
      relay({ type: "gp:storageSet", values }).then(() => resolve(true));
      return;
    }
    area.set(values, () => resolve(true));
  });

export const remove = (keys) =>
  new Promise((resolve) => {
    const area = getArea();
    if (!area || typeof area.remove !== "function") {
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
  return log.filter((entry) => entry.status === "posted" && entry.day === today).length;
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

/* ---------- groups / lists / campaigns ---------- */

export const readGroups = async () => {
  const groups = await get(KEYS.groups, []);
  return Array.isArray(groups) ? groups : [];
};

export const saveGroups = (groups) => set({ [KEYS.groups]: groups });

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
