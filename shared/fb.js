/* Facebook client.
   - Reads the session tokens from the Facebook HTML shell.
   - Loads the joined groups list.
   - Publishes text posts through the classic AJAX endpoint, with an
     optional GraphQL transport (operation ids are configurable because
     Facebook rotates them).
   - Every request can fall back to a hidden Facebook tab when the direct
     extension request is rejected or comes back as a login page. */

import { normalizeGroupUrl } from "./util.js";
import { pushDiagnostic } from "./store.js";

const ORIGIN = "https://www.facebook.com";
const RESERVED = new Set([
  "joins", "feed", "discover", "create", "your_groups", "invites", "search",
  "categories", "mine", "joined", "notifications", "permalink", "posts", "members",
  "settings", "about", "media", "files", "buy_sell", "learn", "polls", "events",
  "video", "photos", "user", "admin", "requests", "pending", "suggested"
]);

let sessionCache = { at: 0, data: null };
const numericIdCache = new Map();
const LOGIN_HINTS = [/id="login_form"/i, /name="login_form"/i, /\/login\/\?next=/i, /"login_page"/i];

export class FbError extends Error {
  constructor(message, kind = "error", detail = "") {
    super(message);
    this.name = "FbError";
    this.kind = kind; // auth | checkpoint | blocked | network | parse | unknown
    this.detail = detail;
  }
}

const firstMatch = (text, patterns, groupIndex = 1) => {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[groupIndex]) return m[groupIndex];
  }
  return "";
};

const looksLikeLogin = (text) => LOGIN_HINTS.some((re) => re.test(text));

const stripPrefix = (text) => String(text || "").replace(/^\s*for\s*\(;;\);/, "").trim();

const parseJson = (text) => {
  const clean = stripPrefix(text);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const snippet = (text, size = 300) => String(text || "").replace(/\s+/g, " ").slice(0, size);

async function directFetch(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    credentials: "include",
    redirect: "follow",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      ...(options.headers || {})
    },
    body: options.body
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url, text, via: "direct" };
}

async function tabFetch(url, options = {}) {
  const res = await chrome.runtime.sendMessage({
    type: "gp:fetchTab",
    url,
    method: options.method || "GET",
    body: options.body || null,
    headers: options.headers || {}
  });
  if (!res || !res.ok) {
    throw new FbError((res && res.error) || "Falló la petición desde la pestaña oculta de Facebook", "network");
  }
  return { ok: res.status >= 200 && res.status < 400, status: res.status, url: res.url, text: res.text, via: "tab" };
}

/* Direct request first (fast, silent). If Facebook answers with the login
   shell or we cannot reach it, retry from a hidden tab where the request is
   same-origin and always carries the session cookies. */
export async function fbFetch(url, options = {}) {
  let result;
  try {
    result = await directFetch(url, options);
  } catch (error) {
    await pushDiagnostic({ scope: "fetch", url, error: String(error && error.message) });
    result = await tabFetch(url, options);
  }
  if (looksLikeLogin(result.text) && result.via === "direct") {
    const fallback = await tabFetch(url, options);
    if (!looksLikeLogin(fallback.text)) result = fallback;
  }
  return result;
}

/* ---------------- session ---------------- */

export async function getSession({ force = false } = {}) {
  if (!force && sessionCache.data && Date.now() - sessionCache.at < 10 * 60 * 1000) {
    return sessionCache.data;
  }
  const res = await fbFetch(ORIGIN + "/");
  if (looksLikeLogin(res.text)) {
    throw new FbError("No estás firmado en Facebook con este perfil de Chrome.", "auth");
  }
  const html = res.text;
  const dtsg = firstMatch(html, [
    /"DTSGInitData",\[\],\{"token":"([^"]+)"/,
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
    /name="fb_dtsg"\s+value="([^"]+)"/
  ]);
  const lsd = firstMatch(html, [/"LSD",\[\],\{"token":"([^"]+)"/, /name="lsd"\s+value="([^"]+)"/]);
  const userId = firstMatch(html, [/"USER_ID":"(\d+)"/, /"actorID":"(\d+)"/, /"userID":"(\d+)"/]);
  const userName = firstMatch(html, [/"NAME":"([^"]+)"/, /"short_name":"([^"]+)"/]);
  const checkpoint = /checkpoint|"is_checkpointed_user"/i.test(html);

  if (!dtsg) {
    throw new FbError(
      "No se pudo leer el token de formulario de Facebook (fb_dtsg). Abre facebook.com en este navegador, termina cualquier verificación de seguridad y vuelve a intentarlo.",
      checkpoint ? "checkpoint" : "parse"
    );
  }

  const session = {
    dtsg,
    lsd,
    userId,
    userName,
    jazoest: "2" + Array.from(dtsg).reduce((sum, ch) => sum + ch.charCodeAt(0), 0),
    fetchedAt: Date.now(),
    via: res.via
  };
  sessionCache = { at: Date.now(), data: session };
  return session;
}

export const clearSessionCache = () => {
  sessionCache = { at: 0, data: null };
};

/* ---------------- groups ---------------- */

const parseCount = (text) => {
  const match = String(text || "").match(/([\d.,]+\s*[KMB])?\s*(members|miembros|mitglieder|membres|membros)/i);
  if (!match) return "";
  return match[0].trim();
};

function groupIdFromHref(href) {
  if (!href) return null;
  /* Facebook sometimes renders absolute URLs and sometimes relative ones. */
  const match = String(href).match(/groups\/([^/?#]+)/);
  if (!match) return null;
  const id = decodeURIComponent(match[1] || "").replace(/\/+$/, "");
  if (!id) return null;
  if (/^(joins|discover|feed|create)$/i.test(id)) return null;
  if (RESERVED.has(id)) return null;
  return id;
}

function parseGroupsHtml(html, base = ORIGIN) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return [];
  }
  const found = new Map();
  const anchors = doc.querySelectorAll('a[href*="/groups/"]');
  anchors.forEach((anchor) => {
    const id = groupIdFromHref(anchor.getAttribute("href"));
    if (!id) return;
    const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
    const img = anchor.querySelector("img");
    let name = text;
    if (!name || name.length < 2) name = anchor.getAttribute("aria-label") || "";
    if (!name || name.length < 2) name = img ? img.getAttribute("alt") || "" : "";
    name = name.replace(/\s+/g, " ").trim();
    if (!name || name.length < 2) return;

    const card = anchor.closest('div[role="listitem"], li, div');
    const cardText = card ? card.textContent || "" : "";
    const existing = found.get(id);
    const candidate = {
      id,
      name,
      url: base + "/groups/" + id + "/",
      pic: img ? img.getAttribute("src") || "" : "",
      members: parseCount(cardText),
      lastVisited: 0,
      numericId: /^\d+$/.test(id) ? id : ""
    };
    if (!existing) found.set(id, candidate);
    else {
      if (!existing.name && candidate.name) existing.name = candidate.name;
      if (!existing.pic && candidate.pic) existing.pic = candidate.pic;
      if (!existing.members && candidate.members) existing.members = candidate.members;
    }
  });
  return Array.from(found.values());
}

export async function loadGroups() {
  const sources = [
    { url: ORIGIN + "/groups/joins/?nav_source=tab", base: ORIGIN },
    { url: "https://mbasic.facebook.com/groups/", base: "https://mbasic.facebook.com" },
    { url: ORIGIN + "/groups/feed/", base: ORIGIN }
  ];
  const errors = [];
  for (const source of sources) {
    try {
      const res = await fbFetch(source.url);
      if (looksLikeLogin(res.text)) {
        throw new FbError("No estás firmado en Facebook con este perfil de Chrome.", "auth");
      }
      const groups = parseGroupsHtml(res.text, source.base).map((group) => ({
        ...group,
        url: ORIGIN + "/groups/" + group.id + "/"
      }));
      if (groups.length) return { groups, source: source.url, via: res.via };
      errors.push({ url: source.url, error: "No se encontraron grupos en la página" });
    } catch (error) {
      errors.push({ url: source.url, error: String(error && error.message) });
      if (error instanceof FbError && error.kind === "auth") throw error;
    }
  }
  await pushDiagnostic({ scope: "groups", errors, detail: "No se pudo extraer ningún grupo de ninguna fuente" });
  throw new FbError(
    "Facebook no devolvió una lista de grupos legible. Añade grupos a mano desde la página Grupos o abre facebook.com/groups/joins en una pestaña y reinténtalo.",
    "parse",
    JSON.stringify(errors)
  );
}

export async function resolveNumericId(group) {
  if (group.numericId) return group.numericId;
  if (/^\d+$/.test(group.id)) return group.id;
  if (numericIdCache.has(group.id)) return numericIdCache.get(group.id);
  try {
    const res = await fbFetch(ORIGIN + "/groups/" + group.id + "/");
    const html = res.text;
    const numeric = firstMatch(html, [
      /"groupID":"(\d+)"/,
      /"group_id":"(\d+)"/,
      /\\"groupID\\":\\"(\d+)\\"/,
      /\/groups\/(\d+)\/(?:posts|permalink|members)/
    ]);
    if (numeric) {
      numericIdCache.set(group.id, numeric);
      return numeric;
    }
  } catch (error) {
    await pushDiagnostic({ scope: "resolve-id", group: group.id, error: String(error && error.message) });
  }
  return "";
}

/* ---------------- posting ---------------- */

function extractPostId(text) {
  const clean = stripPrefix(text);
  const patterns = [
    /"post_id":"(\d+)"/,
    /"story_id":"(\d+)"/,
    /\/groups\/\d+\/posts\/(\d+)/,
    /"legacy_story_hideable_id":"(\d+)"/
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) return m[1];
  }
  return "";
}

function postUrlFor(groupId, postId) {
  if (groupId && postId) return ORIGIN + "/groups/" + groupId + "/posts/" + postId + "/";
  if (groupId) return ORIGIN + "/groups/" + groupId + "/";
  return "";
}

function readError(json, text) {
  if (!json) return snippet(text, 200) || "Respuesta vacía";
  const direct = json.error || json.errorSummary || json.errorDescription;
  if (direct) return String(direct);
  if (json.errors && json.errors.length) {
    return json.errors.map((e) => e.message || e.summary || "GraphQL error").join("; ");
  }
  if (json.payload && json.payload.error) return String(json.payload.error);
  return "";
}

/* Classic endpoint: the one the old share dialog used. Still the simplest
   text-only path and needs no operation ids. */
export async function postViaAjax({ groupId, message }) {
  const session = await getSession();
  const body = new URLSearchParams({
    av: session.userId,
    __user: session.userId,
    __a: "1",
    fb_dtsg: session.dtsg,
    jazoest: session.jazoest,
    xhpc_message: message,
    xhpc_message_text: message,
    target: groupId,
    prn_source: "dialog",
    ref: "group"
  });
  const res = await fbFetch(ORIGIN + "/ajax/updatestatus.php", {
    method: "POST",
    body: body.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest"
    }
  });
  const json = parseJson(res.text);
  const error = readError(json, res.text);
  if (looksLikeLogin(res.text)) {
    throw new FbError("Facebook asked for a login while posting.", "auth");
  }
  if (/checkpoint/i.test(res.text) && !json) {
    throw new FbError("Facebook is showing a security check. Open Facebook, clear it, then resume.", "checkpoint");
  }
  if (error) {
    const kind = /limit|too many|temporar|try again|checkpoint|restricted|blocked/i.test(error) ? "blocked" : "unknown";
    return { ok: false, error, kind, raw: snippet(res.text, 600), via: res.via };
  }
  const postId = extractPostId(res.text);
  return { ok: true, postId, postUrl: postUrlFor(groupId, postId), raw: snippet(res.text, 300), via: res.via };
}

/* GraphQL transport. Facebook rotates operation ids, so the id and the
   variables template live in Settings and can be updated without touching
   the code. Placeholders: {{groupId}}, {{message}}, {{userId}}. */
export async function postViaGraphQL({ groupId, message, settings }) {
  const session = await getSession();
  const docId = String(settings.graphqlDocId || "").trim();
  if (!docId) {
    return { ok: false, error: "No hay operation id de GraphQL configurado.", kind: "config", raw: "", via: "graphql" };
  }
  let variables;
  const template = String(settings.graphqlTemplate || "").trim();
  if (template) {
    variables = template
      .replaceAll("{{groupId}}", JSON.stringify(groupId).slice(1, -1))
      .replaceAll("{{message}}", JSON.stringify(message).slice(1, -1))
      .replaceAll("{{userId}}", JSON.stringify(session.userId).slice(1, -1));
    try {
      variables = JSON.stringify(JSON.parse(variables));
    } catch {
      return { ok: false, error: "La plantilla de variables GraphQL no es JSON válido.", kind: "config", raw: "", via: "graphql" };
    }
  } else {
    variables = JSON.stringify({
      input: {
        composer_entry_point: "inline_composer",
        composer_source_surface: "group",
        logging_id: String(Date.now()),
        message: { ranges: [], text: message },
        source: "WWW",
        target_group_id: String(groupId)
      }
    });
  }

  const body = new URLSearchParams({
    av: session.userId,
    __user: session.userId,
    __a: "1",
    fb_dtsg: session.dtsg,
    jazoest: session.jazoest,
    lsd: session.lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: settings.graphqlFriendlyName || "CometGroupDiscussionComposerCreateMutation",
    variables,
    server_timestamps: "true",
    doc_id: docId
  });

  const res = await fbFetch(ORIGIN + "/api/graphql/", {
    method: "POST",
    body: body.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest"
    }
  });
  const json = parseJson(res.text);
  const error = readError(json, res.text);
  if (error) {
    const kind = /checkpoint|limit|too many|blocked/i.test(error) ? "blocked" : "unknown";
    return { ok: false, error, kind, raw: snippet(res.text, 600), via: "graphql" };
  }
  const postId = extractPostId(res.text);
  return { ok: true, postId, postUrl: postUrlFor(groupId, postId), raw: snippet(res.text, 300), via: "graphql" };
}

export async function publishToGroup({ group, message, settings }) {
  const numericId = await resolveNumericId(group);
  if (!numericId) {
    return {
      ok: false,
      kind: "resolve",
      error: "No se pudo resolver el id numérico del grupo. Abre el grupo una vez en Facebook y reinténtalo.",
      raw: ""
    };
  }
  const transport = String(settings.transport || "ajax");
  if (transport === "graphql") {
    return await postViaGraphQL({ groupId: numericId, message, settings });
  }
  const first = await postViaAjax({ groupId: numericId, message });
  if (!first.ok && first.kind === "config") {
    return await postViaGraphQL({ groupId: numericId, message, settings });
  }
  return first;
}

/* ---------------- diagnostics ---------------- */

export async function describeGroup(rawUrl) {
  const url = normalizeGroupUrl(rawUrl);
  if (!url) throw new FbError("Eso no parece un enlace de grupo de Facebook.", "parse");
  const res = await fbFetch(url);
  if (looksLikeLogin(res.text)) {
    throw new FbError("No estás firmado en Facebook con este perfil de Chrome.", "auth");
  }
  const html = res.text;
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    doc = null;
  }
  const meta = (property) => {
    if (!doc) return "";
    const node = doc.querySelector('meta[property="' + property + '"]');
    return node ? node.getAttribute("content") || "" : "";
  };
  const titleTag = doc && doc.querySelector("title") ? doc.querySelector("title").textContent || "" : "";
  let name = meta("og:title") || titleTag || "";
  name = name
    .replace(/\s*[|·-]\s*(Facebook|Groups?|Meta)\s*$/i, "")
    .replace(/\s*[|·]\s*Facebook\s*$/i, "")
    .trim();
  const pic = meta("og:image");
  const numericId = firstMatch(html, [/"groupID":"(\d+)"/, /"group_id":"(\d+)"/, /"id":"(\d+)"/]);
  const members = firstMatch(html, [/"member_count":(\d+)/, /"memberCount":(\d+)/]);
  const idMatch = url.match(/\/groups\/([^/]+)/);
  const id = idMatch ? idMatch[1] : numericId;
  if (!id) throw new FbError("No se pudo leer el grupo de esa página.", "parse");
  return {
    id,
    name: name || id,
    url: ORIGIN + "/groups/" + id + "/",
    pic: pic || "",
    members: members ? Number(members).toLocaleString() : "",
    lastVisited: 0,
    numericId: numericId || (/^\d+$/.test(id) ? id : "")
  };
}

export async function checkSession() {
  clearSessionCache();
  try {
    const session = await getSession({ force: true });
    return {
      ok: true,
      userId: session.userId,
      userName: session.userName,
      hasDtsg: Boolean(session.dtsg),
      hasLsd: Boolean(session.lsd),
      via: session.via
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message),
      kind: error && error.kind ? error.kind : "unknown"
    };
  }
}
