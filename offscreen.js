/* Offscreen host: message router for everything that needs Facebook access
   or the run loop. The app never talks to Facebook directly. */

import {
  loadGroups,
  describeGroup,
  checkSession,
  resolveNumericId
} from "./shared/fb.js";
import { publish } from "./shared/publish.js";
import { readGroups, saveGroups, getSettings, pushDiagnostic } from "./shared/store.js";
import {
  startRun,
  pauseRun,
  resumeRun,
  stopRun,
  resetRun,
  getStatus,
  resolveImageDataUrl,
  recoverOnBoot
} from "./shared/engine.js";

function mergeGroups(existing, incoming) {
  const map = new Map((existing || []).map((group) => [group.id, group]));
  for (const group of incoming || []) {
    const previous = map.get(group.id) || {};
    map.set(group.id, {
      ...previous,
      ...group,
      lastVisited: previous.lastVisited || group.lastVisited || 0,
      numericId: group.numericId || previous.numericId || ""
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function handle(action, payload = {}) {
  switch (action) {
    case "session:check": {
      return await checkSession();
    }

    case "groups:load": {
      const settings = await getSettings();
      if (settings.transport === "auto" || settings.transport === "ui") {
        const ui = await chrome.runtime.sendMessage({ type: "gp:uiScanGroups" });
        if (ui && ui.ok && ui.result && ui.result.ok && ui.result.groups.length) {
          const merged = mergeGroups(await readGroups(), ui.result.groups);
          await saveGroups(merged);
          return {
            ok: true,
            groups: merged,
            source: "facebook-ui",
            via: "ui",
            count: ui.result.groups.length
          };
        }
        if (settings.transport === "ui") {
          if (ui && ui.result && ui.result.checkpoint) throw new Error(ui.result.error);
          throw new Error((ui && ui.error) || "El navegador no devolvió ningún grupo.");
        }
      }
      const result = await loadGroups();
      const merged = mergeGroups(await readGroups(), result.groups);
      await saveGroups(merged);
      return { ok: true, groups: merged, source: result.source, via: result.via, count: result.groups.length };
    }

    case "groups:add": {
      const group = await describeGroup(payload.url || payload.groupId || "");
      const merged = mergeGroups(await readGroups(), [group]);
      await saveGroups(merged);
      return { ok: true, group, groups: merged };
    }

    case "groups:save": {
      const merged = mergeGroups(payload.groups || [], []);
      await saveGroups(merged);
      return { ok: true, groups: merged };
    }

    case "test:post": {
      const settings = await getSettings();
      const groups = await readGroups();
      const group = payload.group || groups.find((item) => item.id === payload.groupId);
      if (!group) return { ok: false, error: "Grupo no encontrado." };
      if (!String(payload.message || "").trim()) return { ok: false, error: "El mensaje de prueba está vacío." };
      let target = group;
      const numeric = await resolveNumericId(group);
      if (numeric && !/^\d+$/.test(String(group.id || ""))) {
        target = { ...group, url: "https://www.facebook.com/groups/" + numeric + "/", numericId: numeric };
      }
      const image = await resolveImageDataUrl(String(payload.imageUrl || ""));
      const rawImages = Array.isArray(payload.images) && payload.images.length
        ? payload.images
        : image ? [String(payload.imageUrl)] : [];
      const images = await Promise.all(rawImages.map((value) => resolveImageDataUrl(String(value))));
      const result = await publish({
        group: target,
        message: payload.message,
        settings,
        options: { presence: settings.scrollPresence !== false, images }
      });
      await pushDiagnostic({
        scope: "test-post",
        group: group.id,
        ok: Boolean(result.ok),
        error: result.error || "",
        raw: result.raw || ""
      });
      return { ok: true, result };
    }

    case "run:start": {
      const run = await startRun({ campaign: payload.campaign, groups: payload.groups });
      return { ok: true, run };
    }

    case "run:pause": {
      return { ok: true, run: await pauseRun() };
    }

    case "run:resume": {
      return { ok: true, run: await resumeRun() };
    }

    case "run:stop": {
      return { ok: true, run: await stopRun() };
    }

    case "run:reset": {
      return { ok: true, run: await resetRun() };
    }

    case "run:status": {
      return { ok: true, run: await getStatus() };
    }

    case "engine:ping": {
      await recoverOnBoot();
      return { ok: true, pong: Date.now() };
    }

    default:
      return { ok: false, error: "Acción desconocida: " + action };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "gp:engine") return;
  handle(message.action, message.payload || {}).then(
    (data) => sendResponse(data),
    (error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
  );
  return true;
});

recoverOnBoot().catch(() => {});
