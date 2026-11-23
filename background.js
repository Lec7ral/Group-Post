/* Service worker: owns the app tab, the offscreen document, the hidden tab
   used when a Facebook request needs real page cookies, and the small work
   window that drives the Facebook UI. */

import {
  getRun,
  getSettings,
  readCampaigns,
  saveCampaigns,
  readGroups,
  appendLog,
  makeLogEntry
} from "./shared/store.js";
import { sleep } from "./shared/util.js";

const APP_PATH = "app/index.html";
const OFFSCREEN_PATH = "offscreen.html";
const BRIDGE_URL = "https://www.facebook.com/robots.txt";
const GROUPS_URL = "https://www.facebook.com/groups/joins/?nav_source=tab";
const WORKER_KEY = "gpWorker";
const SCHED_PREFIX = "gp-sched:";

let creatingOffscreen = null;
let workerMemory = null;

/* ---------------- offscreen document ---------------- */

async function hasOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      return contexts.length > 0;
    }
  } catch {
    /* fall through */
  }
  try {
    return typeof chrome.offscreen.hasDocument === "function" ? await chrome.offscreen.hasDocument() : false;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return true;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Parse Facebook group pages and keep the posting schedule running in the background."
    })
    .catch((error) => {
      const message = String(error && error.message ? error.message : error);
      if (!/single offscreen|already/i.test(message)) throw error;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
  return true;
}

async function sendToEngine(action, payload) {
  await ensureOffscreen();
  /* A test post or an on-page group scan drives the real Facebook page, so it
     needs minutes, not seconds. Everything else is a quick read/write. */
  const timeout = action === "test:post" ? 240000 : action === "groups:load" ? 180000 : 25000;
  const attempt = async () =>
    Promise.race([
      chrome.runtime.sendMessage({ type: "gp:engine", action, payload }),
      sleep(timeout).then(() => ({ ok: false, error: "El motor en segundo plano no respondió a tiempo." }))
    ]);
  try {
    const response = await attempt();
    if (response && response.ok !== false) return response;
    if (response && /receiving end does not exist|Could not establish/i.test(String(response.error || ""))) {
      await sleep(400);
      return (await attempt()) || { ok: false, error: "El motor devolvió una respuesta vacía." };
    }
    return response || { ok: false, error: "El motor devolvió una respuesta vacía." };
  } catch {
    await sleep(400);
    return (await attempt()) || { ok: false, error: "El motor devolvió una respuesta vacía." };
  }
}

/* ---------------- app tab ---------------- */

async function openApp() {
  const url = chrome.runtime.getURL(APP_PATH);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url && tab.url.startsWith(url));
  if (existing && existing.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url });
  return tab.id;
}

/* ---------------- hidden-tab fetch bridge ---------------- */

/* Inspects DOM stability in the page (self-contained so it can be injected). */
function pageIsQuiet() {
  const node = document.querySelector('[role="main"]') || document.body;
  const busy = Array.from(document.querySelectorAll('[aria-busy="true"]')).some((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  return document.readyState === "complete" && !busy && Boolean(node);
}

async function waitForPageQuiet(tabId, timeoutMs = 20000) {
  const started = Date.now();
  let quietSince = 0;
  let lastSize = -1;
  while (Date.now() - started < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: pageIsQuiet });
      const html = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const main = document.querySelector('[role="main"]');
          return main ? main.innerHTML.length : (document.body ? document.body.innerHTML.length : 0);
        }
      });
      const size = (html && html.result) || 0;
      if (result && result.result && size === lastSize) {
        if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince >= 1000) return true;
      } else {
        quietSince = 0;
      }
      lastSize = size;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return false;
}

async function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") done();
      })
      .catch(() => done());
    setTimeout(done, timeoutMs);
  });
}

async function fetchViaHiddenTab({ url, method = "GET", body = null, headers = {} }) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: BRIDGE_URL, active: false });
    tabId = tab.id;
    await waitForTabReady(tabId, 20000);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, method, body, headers],
      func: async (targetUrl, httpMethod, requestBody, requestHeaders) => {
        try {
          const res = await fetch(targetUrl, {
            method: httpMethod,
            credentials: "include",
            redirect: "follow",
            headers: requestHeaders || {},
            body: requestBody || undefined
          });
          const text = await res.text();
          return { status: res.status, url: res.url, text };
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      }
    });
    const result = injection && injection.result;
    if (!result || result.error) {
      return { ok: false, error: (result && result.error) || "La pestaña oculta no devolvió nada." };
    }
    return { ok: true, status: result.status, url: result.url, text: result.text };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* tab already gone */
      }
    }
  }
}

/* ---------------- Facebook work window ---------------- */

async function readWorker() {
  try {
    if (chrome.storage.session) {
      const data = await chrome.storage.session.get(WORKER_KEY);
      return data[WORKER_KEY] || null;
    }
  } catch {
    /* fall back to memory */
  }
  return workerMemory;
}

async function writeWorker(state) {
  workerMemory = state;
  try {
    if (chrome.storage.session) await chrome.storage.session.set({ [WORKER_KEY]: state });
  } catch {
    /* memory only */
  }
}

async function dropWorker() {
  workerMemory = null;
  try {
    if (chrome.storage.session) await chrome.storage.session.remove(WORKER_KEY);
  } catch {
    /* ignore */
  }
}

async function getLiveWorker() {
  const stored = await readWorker();
  if (!stored || !stored.windowId || !stored.tabId) return null;
  try {
    await chrome.windows.get(stored.windowId);
    const tab = await chrome.tabs.get(stored.tabId);
    return { ...stored, tab };
  } catch {
    await dropWorker();
    return null;
  }
}

async function closeWorker() {
  const worker = await getLiveWorker();
  if (worker) {
    if (worker.mode === "tab" || worker.mode === "newtab") {
      /* Never close the user's own tab: just restore the normal UI state. */
      try {
        await sendUi(worker.tabId, "configure", { role: "normal" });
      } catch {
        /* gone or reloaded */
      }
    } else {
      try {
        await chrome.windows.remove(worker.windowId);
      } catch {
        try {
          await chrome.tabs.remove(worker.tabId);
        } catch {
          /* gone */
        }
      }
    }
  }
  await dropWorker();
}

async function createWorker(url, settings) {
  const hidden = settings.windowMode !== "visible";
  /* A popup window keeps the desktop layout (smaller windows make Facebook
     collapse the composer) while staying unfocused and parked off-screen. */
  const options = hidden
    ? { url, type: "popup", focused: false, width: 560, height: 720, left: 10000, top: 10000 }
    : { url, type: "normal", focused: true, width: 1180, height: 880 };

  const win = await chrome.windows.create(options);
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  await writeWorker({ windowId: win.id, tabId, hidden });
  return { windowId: win.id, tabId, hidden };
}

/* Facebook redirects and canonicalises group URLs (trailing slash, query,
   host). Compare only origin + pathname so we do not reload the same page
   before every post. */
function samePage(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const normHost = (host) => host.replace(/^(?:www|web|m|mbasic)\./i, "");
    const strip = (path) => path.replace(/\/+$/, "");
    return normHost(left.hostname) === normHost(right.hostname) && strip(left.pathname) === strip(right.pathname);
  } catch {
    return a === b;
  }
}

/* Finds an already-open Facebook tab so the extension works on the page the
   user has in front of them instead of opening a new window. */
async function findFacebookTab(url) {
  try {
    const tabs = await chrome.tabs.query({});
    const fb = tabs.filter(
      (tab) => tab.url && /^https?:\/\/(?:www\.|web\.|mbasic\.|m\.)?facebook\.com\//i.test(tab.url)
    );
    if (!fb.length) return null;
    const wanted = (() => {
      try {
        return new URL(url).pathname.replace(/\/+$/, "");
      } catch {
        return "";
      }
    })();
    const same = fb.find((tab) => {
      try {
        return new URL(tab.url).pathname.replace(/\/+$/, "") === wanted;
      } catch {
        return false;
      }
    });
    const onGroups = fb.find((tab) => /\/groups\//i.test(tab.url));
    return same || onGroups || fb[0];
  } catch {
    return null;
  }
}

async function createTabWorker(url, mode = "tab", active = false) {
  const tab = await chrome.tabs.create({ url, active });
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch {
    /* ignore */
  }
  const state = { windowId: tab.windowId, tabId: tab.id, mode };
  await writeWorker(state);
  return state;
}

async function ensureWorker(url, settings) {
  const newTab = settings.workTarget === "newtab";
  const wantedMode = newTab ? "newtab" : "tab";
  const shouldFocus = settings.focusWorker === true;
  let worker = await getLiveWorker();

  if (worker && worker.mode !== wantedMode) {
    await closeWorker();
    worker = null;
  }

  if (!worker && !newTab) {
    const existing = await findFacebookTab(url);
    if (existing) {
      const state = { windowId: existing.windowId, tabId: existing.id, mode: "tab" };
      await writeWorker(state);
      worker = state;
    }
  }
  if (!worker) worker = await createTabWorker(url, wantedMode, shouldFocus);

  let live = await chrome.tabs.get(worker.tabId).catch(() => null);
  if (!live) {
    await dropWorker();
    worker = await createTabWorker(url, wantedMode, shouldFocus);
    live = await chrome.tabs.get(worker.tabId).catch(() => null);
  }
  try {
    await chrome.tabs.update(worker.tabId, { autoDiscardable: false });
  } catch {
    /* ignore */
  }
  if (live && !samePage(live.url || "", url)) {
    await chrome.tabs.update(worker.tabId, { url });
    /* Wait for the real navigation to commit before looking for the composer. */
    await waitForTabReady(worker.tabId, 20000);
    await sleep(1800);
  }

  if (shouldFocus) {
    try {
      await chrome.tabs.update(worker.tabId, { active: true });
      await chrome.windows.update(worker.windowId, { focused: true });
    } catch {
      /* ignore */
    }
  }

  await waitForTabReady(worker.tabId, 35000);
  await waitForPageQuiet(worker.tabId, 15000);
  return worker;
}

async function sendUi(tabId, task, payload = {}) {
  return chrome.tabs.sendMessage(tabId, { type: "gp:ui", task, payload });
}

async function ensureContentScript(tabId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const pong = await sendUi(tabId, "ping");
      if (pong && pong.ok) return true;
    } catch {
      /* not ready yet */
    }
    await sleep(400);
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/fb_ui.js"] });
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/fb_ui.css"] });
    } catch {
      /* styles already injected or blocked */
    }
    await sleep(700);
    const pong = await sendUi(tabId, "ping");
    return Boolean(pong && pong.ok);
  } catch {
    return false;
  }
}

async function prepareWorker(url, settings) {
  const worker = await ensureWorker(url, settings);
  const ready = await ensureContentScript(worker.tabId);
  if (!ready) {
    return { worker, ready: false, error: "La página de Facebook no cargó el automatizador. Comprueba la sesión y vuelve a intentarlo." };
  }
  try {
    await sendUi(worker.tabId, "configure", { role: "worker" });
  } catch {
    /* the flag is optional */
  }
  await sleep(900);
  return { worker, ready: true };
}

async function uiPost({ group, message, options }) {
  if (!group || !group.url) return { ok: false, error: "El grupo no tiene URL." };
  const settings = await getSettings();

  let prepared;
  try {
    prepared = await prepareWorker(group.url, settings);
  } catch (error) {
    return { ok: false, error: "No se pudo abrir la ventana de Facebook: " + String(error && error.message ? error.message : error) };
  }
  if (!prepared.ready) return { ok: false, error: prepared.error };

  try {
    const result = await sendUi(prepared.worker.tabId, "post", { text: message, options: options || {} });
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: "La ventana de Facebook se cerró o no respondió: " + String(error && error.message ? error.message : error)
    };
  }
}

/* Reads the full joined-groups list through Facebook's own GraphQL query,
   executed inside a facebook.com tab so it inherits the session cookies. */
async function fetchJoinedGroupsGraphql(tabId) {
  const groups = new Map();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (args) => {
        const html = document.documentElement.outerHTML || "";
        const dtsg =
          (html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/) || [])[1] ||
          (document.querySelector('input[name="fb_dtsg"]') || {}).value || "";
        const lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || "";
        const uid = (html.match(/"USER_ID":"(\d+)"/) || [])[1] || "";
        const friendly = "GroupsCometAllJoinedGroupsSectionPaginationQuery";
        const params = new URLSearchParams({
          av: uid,
          __user: uid,
          __a: "1",
          dpr: "1",
          __comet_req: "15",
          fb_dtsg: dtsg,
          jazoest: "2",
          lsd,
          fb_api_req_friendly_name: friendly,
          variables: JSON.stringify({ count: 20, cursor: args.cursor, ordering: ["name"], scale: 1 })
        });
        const res = await fetch("https://web.facebook.com/api/graphql/", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": friendly },
          body: params.toString()
        });
        return await res.text();
      },
      args: [{ cursor }]
    });
    const json = JSON.parse(String(result || "").replace(/^\s*for\s*\(;;\);/, ""));
    const list = json && json.data && json.data.viewer && json.data.viewer.all_joined_groups;
    const tabList = list && list.tab_groups_list;
    const edges = (tabList && tabList.edges) || (Array.isArray(tabList) ? tabList : []);
    for (const edge of edges) {
      const group = edge.node || edge;
      const id = group.id || ((group.url || "").match(/\/groups\/(\d+)/) || [])[1];
      if (!id) continue;
      groups.set(id, {
        id: String(id),
        name: group.name || group.title || String(id),
        url: "https://www.facebook.com/groups/" + id + "/"
      });
    }
    const info = tabList && tabList.page_info;
    if (!info || !info.has_next_page || !info.end_cursor) break;
    cursor = info.end_cursor;
  }
  return Array.from(groups.values());
}

async function uiScanGroups() {
  const run = await getRun();
  if (["running", "paused", "stopping"].includes(run.status)) {
    return { ok: false, error: "Hay una campaña activa. Espera a que termine para sincronizar grupos." };
  }
  const settings = await getSettings();
  let prepared;
  try {
    prepared = await prepareWorker(GROUPS_URL, settings);
  } catch (error) {
    return { ok: false, error: "No se pudo abrir la ventana de Facebook: " + String(error && error.message ? error.message : error) };
  }
  if (!prepared.ready) return { ok: false, error: prepared.error };

  try {
    /* Prefer Facebook's own paginated query; fall back to DOM scrolling. */
    let result = null;
    try {
      const groups = await fetchJoinedGroupsGraphql(prepared.worker.tabId);
      if (groups.length) result = { ok: true, groups, via: "graphql" };
    } catch {
      /* query changed or was blocked: use the DOM scan */
    }
    if (!result) result = await sendUi(prepared.worker.tabId, "scanGroups", { rounds: 28 });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: "El escaneo falló: " + String(error && error.message ? error.message : error) };
  }
}

/* ---------------- badge ---------------- */

function paintBadge(run) {
  const status = (run && run.status) || "idle";
  const total = Array.isArray(run && run.queue) ? run.queue.length : 0;
  const done = ((run && run.okCount) || 0) + ((run && run.failCount) || 0) + ((run && run.skipCount) || 0);

  let text = "";
  let color = "#5b8cff";

  if (status === "running") {
    if (run.breakUntil && run.breakUntil > Date.now()) {
      text = "II";
      color = "#8b5cf6";
    } else {
      text = total ? done + "/" + total : "ON";
    }
  } else if (status === "paused") {
    text = "II";
    color = "#eab308";
  } else if (status === "stopping") {
    text = "…";
    color = "#eab308";
  } else if (status === "error") {
    text = "!";
    color = "#ef4444";
  }

  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } catch {
    /* ignore */
  }
}

async function refreshBadge() {
  try {
    paintBadge(await getRun());
  } catch {
    /* ignore */
  }
}

/* ---------------- routing ---------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "gp:fetchTab") {
    fetchViaHiddenTab(message).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "gp:openApp") {
    openApp().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "gp:storageGet") {
    try {
      chrome.storage.local.get(message.keys || null, (data) => sendResponse(data || {}));
    } catch (error) {
      sendResponse({});
    }
    return true;
  }

  if (message.type === "gp:storageSet") {
    try {
      chrome.storage.local.set(message.values || {}, () => sendResponse({ ok: true }));
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    }
    return true;
  }

  if (message.type === "gp:storageRemove") {
    try {
      chrome.storage.local.remove(message.keys || [], () => sendResponse({ ok: true }));
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    }
    return true;
  }

  if (message.type === "gp:api") {
    sendToEngine(message.action, message.payload).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "gp:uiPost") {
    uiPost(message.payload || {}).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "gp:uiScanGroups") {
    uiScanGroups().then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }

  if (message.type === "gp:uiClose") {
    (async () => {
      await closeWorker();
      return { ok: true };
    })().then(sendResponse, () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "gp:uiFocus") {
    (async () => {
      const worker = await getLiveWorker();
      if (!worker) return { ok: false, error: "No hay ninguna ventana de Facebook abierta." };
      if (worker.mode === "tab" || worker.mode === "newtab") {
        await chrome.tabs.update(worker.tabId, { active: true });
        await chrome.windows.update(worker.windowId, { focused: true });
        return { ok: true };
      }
      /* Bring the dedicated work window on screen so it can be inspected. */
      await chrome.windows.update(worker.windowId, {
        focused: true,
        left: 120,
        top: 80,
        width: 1180,
        height: 880,
        state: "normal"
      });
      return { ok: true };
    })().then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
    );
    return true;
  }
});

async function syncScheduledAlarms() {
  try {
    const campaigns = await readCampaigns();
    const wanted = new Map();
    const nowTs = Date.now();
    for (const campaign of campaigns) {
      const when = Number(campaign && campaign.scheduledAt) || 0;
      if (when > 0 && campaign.id) {
        wanted.set(SCHED_PREFIX + campaign.id, Math.max(nowTs + 2000, when));
      }
    }
    const alarms = await chrome.alarms.getAll();
    for (const alarm of alarms) {
      if (alarm.name.startsWith(SCHED_PREFIX) && !wanted.has(alarm.name)) {
        await chrome.alarms.clear(alarm.name);
      }
    }
    for (const [name, when] of wanted.entries()) {
      await chrome.alarms.create(name, { when });
    }
  } catch {
    /* ignore */
  }
}

async function runScheduledCampaign(campaignId) {
  const campaigns = await readCampaigns();
  const target = campaigns.find((item) => item.id === campaignId);
  if (!target || !Number(target.scheduledAt)) return;

  /* Clear scheduledAt immediately so a restart cannot double-fire it. */
  const cleared = campaigns.map((item) =>
    item.id === campaignId ? { ...item, scheduledAt: 0 } : item
  );
  await saveCampaigns(cleared);

  const run = await getRun();
  if (["running", "paused", "stopping"].includes(run.status)) {
    await appendLog(
      makeLogEntry({
        campaignId: target.id,
        campaignName: target.name || "Campaña programada",
        status: "info",
        message: "La programación llegó a su hora pero ya hay otra campaña en curso. Lánzala manualmente cuando termine."
      })
    );
    return;
  }

  const allGroups = await readGroups();
  const byId = new Map(allGroups.map((g) => [g.id, g]));
  const groups = (target.groupIds || []).map((id) => byId.get(id)).filter(Boolean);
  if (!groups.length) {
    await appendLog(
      makeLogEntry({
        campaignId: target.id,
        campaignName: target.name || "Campaña programada",
        status: "failed",
        message: "No se pudo lanzar la campaña programada: ninguno de sus grupos está guardado."
      })
    );
    return;
  }

  await appendLog(
    makeLogEntry({
      campaignId: target.id,
      campaignName: target.name || "Campaña programada",
      status: "info",
      message: "Iniciando campaña programada (" + groups.length + " grupo(s))."
    })
  );
  const res = await sendToEngine("run:start", { campaign: { ...target, scheduledAt: 0 }, groups });
  if (!res || res.ok === false) {
    await appendLog(
      makeLogEntry({
        campaignId: target.id,
        campaignName: target.name || "Campaña programada",
        status: "failed",
        message: "Error al iniciar campaña programada: " + ((res && res.error) || "desconocido")
      })
    );
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.run) paintBadge(changes.run.newValue || {});
  if (area === "local" && changes.campaigns) syncScheduledAlarms();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("gp-watchdog", { periodInMinutes: 1 });
  refreshBadge();
  syncScheduledAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("gp-watchdog", { periodInMinutes: 1 });
  refreshBadge();
  syncScheduledAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(SCHED_PREFIX)) {
    const campaignId = alarm.name.slice(SCHED_PREFIX.length);
    try {
      await runScheduledCampaign(campaignId);
    } catch {
      /* ignore */
    }
    return;
  }
  if (alarm.name !== "gp-watchdog") return;
  try {
    const run = await getRun();
    if (["running", "paused", "stopping"].includes(run.status)) {
      await ensureOffscreen();
      /* A live offscreen document may have lost its loop; recoverOnBoot
         restarts it and finishes runs stuck in "stopping". */
      await sendToEngine("engine:ping");
    }
    paintBadge(run);
  } catch {
    /* nothing to do */
  }
});

chrome.alarms.create("gp-watchdog", { periodInMinutes: 1 });
refreshBadge();
syncScheduledAlarms();
