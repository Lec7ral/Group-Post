/* Run engine. Lives in the offscreen document so timers keep running at full
   speed while the dashboard tab is in the background and no Facebook tab is
   needed on screen.

   The engine only orchestrates: when it is time to post it asks the service
   worker, which drives the real Facebook page (or the API transports) and
   returns the result. */

import {
  getRun,
  saveRun,
  getSettings,
  appendLog,
  makeLogEntry,
  countPostedToday,
  recordGroupOutcome,
  EMPTY_RUN
} from "./store.js";
import { FbError, clearSessionCache, resolveNumericId } from "./fb.js";
import { publish } from "./publish.js";
import { rewriteWithAi } from "./ai.js";
import { renderTemplate } from "./spintax.js";
import { jitterInt, sleep, uid } from "./util.js";

const POLL_MS = 500;
const TOUCH_MS = 10000;
const RETRY_MS = 8000;
const MAX_CONSECUTIVE_FAILS = 5;

let active = false;

const isRetryable = (result) => {
  if (!result || result.ok) return false;
  if (["auth", "checkpoint", "resolve", "config"].includes(result.kind)) return false;
  return true;
};

const pickMessage = (campaign, index) => {
  const variations = Array.isArray(campaign.variations)
    ? campaign.variations.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const base = String(campaign.message || "").trim();
  const pool = variations.length ? variations : base ? [base] : [];
  if (!pool.length) return "";
  return pool[index % pool.length];
};

async function patchRun(runId, patch) {
  const run = await getRun();
  if (run.id !== runId) return run;
  const next = { ...run, ...patch, heartbeat: Date.now() };
  await saveRun(next);
  return next;
}

async function touch(runId) {
  const run = await getRun();
  if (run.id !== runId) return run;
  const next = { ...run, heartbeat: Date.now() };
  await saveRun(next);
  return next;
}

async function readControl(runId) {
  const run = await getRun();
  if (run.id !== runId) return { status: "stopping" };
  return run;
}

async function waitWhilePaused(runId) {
  let run = await readControl(runId);
  let lastTouch = Date.now();
  while (run.status === "paused") {
    await sleep(POLL_MS);
    if (Date.now() - lastTouch > TOUCH_MS) {
      await touch(runId);
      lastTouch = Date.now();
    }
    run = await readControl(runId);
  }
  return run;
}

/* Waits ms while honoring pause and stop. Returns "ok" or "stop". */
async function waitDelay(runId, ms) {
  let remaining = Math.max(0, ms);
  let lastTouch = Date.now();
  while (remaining > 0) {
    const run = await readControl(runId);
    if (run.status === "stopping") return "stop";
    if (run.status === "paused") {
      await sleep(POLL_MS);
      if (Date.now() - lastTouch > TOUCH_MS) {
        await touch(runId);
        lastTouch = Date.now();
      }
      continue;
    }
    const step = Math.min(POLL_MS, remaining);
    await sleep(step);
    remaining -= step;
    if (Date.now() - lastTouch > TOUCH_MS) {
      await touch(runId);
      lastTouch = Date.now();
    }
  }
  return "ok";
}

async function logAndSave(entry) {
  await appendLog(makeLogEntry(entry));
}

async function doPost(group, message, settings, campaign, images = []) {
  try {
    const targetImages = Array.isArray(images) && images.length
      ? images
      : (campaign && campaign.imageUrl ? [campaign.imageUrl] : []);
    /* A slug-based group URL can 404 on the real page. Resolve the numeric
       id when possible so the browser lands on the right group. */
    let target = group;
    const numeric = await resolveNumericId(group);
    if (numeric && !/^\d+$/.test(String(group.id || ""))) {
      target = { ...group, url: "https://www.facebook.com/groups/" + numeric + "/", numericId: numeric };
    }
    return await publish({
      group: target,
      message,
      settings,
      options: { presence: settings.scrollPresence !== false, images: targetImages }
    });
  } catch (error) {
    if (error instanceof FbError) {
      return { ok: false, kind: error.kind, error: error.message, raw: error.detail || "" };
    }
    return { ok: false, kind: "unknown", error: String(error && error.message ? error.message : error), raw: "" };
  }
}

/* Turns a campaign image URL into a base64 data URL so the content script
   can attach it to the real Facebook composer. Returns "" on any failure and
   the post proceeds with text only. */
let imageCache = new Map();

export async function resolveImageDataUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (imageCache.has(value)) return imageCache.get(value);
  let dataUrl = "";
  try {
    const res = await fetch(value);
    if (res.ok) {
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      dataUrl = "data:" + (blob.type || "image/jpeg") + ";base64," + (typeof btoa === "function" ? btoa(binary) : btoa(String.fromCharCode.apply(null, bytes)));
      imageCache.set(value, dataUrl);
    }
  } catch {
    /* ignore */
  }
  return dataUrl;
}

/* Builds the final text for one group: optional AI rewrite, then the
   template variables and spintax. */
async function buildMessage(campaign, index, group, settings, run) {
  const base = pickMessage(campaign, index);
  if (!base) return "";
  let text = renderTemplate(base, {
    group_name: group.name,
    group_id: group.id,
    group_url: group.url
  }).trim();

  const isOnlyUrl = /^https?:\/\/[^\s]+$/i.test(text);
  const aiActive =
    !isOnlyUrl && settings.aiEnabled === true && String(settings.aiProvider || "worker") !== "off";
  if (aiActive) {
    const rewritten = await rewriteWithAi({ text, settings });
    if (rewritten.ok) {
      text = String(rewritten.text).trim();
    } else {
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        groupId: group.id,
        groupName: group.name,
        status: "info",
        message: "IA no disponible (" + rewritten.error + "). Se usa el texto original."
      });
    }
  }

  return text;
}

async function closeWorkWindow() {
  try {
    await chrome.runtime.sendMessage({ type: "gp:uiClose" });
  } catch {
    /* the service worker may be asleep; the window is closed next time */
  }
}

async function finalize(runId, status, reason) {
  const run = await patchRun(runId, {
    status,
    current: null,
    nextAt: 0,
    breakUntil: 0,
    finishedAt: Date.now(),
    finishedReason: reason || ""
  });
  if (reason) {
    await logAndSave({
      campaignId: run.campaignId,
      campaignName: run.campaignName,
      status: "info",
      message: reason
    });
  }
  /* A stale loop from an older run must not clear the flag of a new one. */
  const current = await getRun();
  if (!current.id || current.id === runId) active = false;
  await closeWorkWindow();
  return run;
}

async function loop(runId) {
  let run = await getRun();
  if (run.id !== runId) return;
  const snapshot = run.campaignSnapshot || {};
  const queue = Array.isArray(run.queue) ? run.queue : [];
  const total = queue.length;

  const initial = await readControl(runId);
  if (initial.status === "stopping") {
    await finalize(runId, "done", "Detenido por ti antes de empezar.");
    return;
  }
  await patchRun(runId, { status: "running", pauseReason: "", lastError: "" });

  const runImages = Array.isArray(snapshot.images) && snapshot.images.length
    ? await Promise.all(snapshot.images.map((value) => resolveImageDataUrl(String(value))))
    : [];
  let index = Number(run.cursor) || 0;
  loop: while (index < total) {
    run = await readControl(runId);
    if (run.status === "stopping") {
      await finalize(runId, "done", `Detenido por ti tras ${run.okCount} de ${total} grupos.`);
      return;
    }
    run = await waitWhilePaused(runId);
    if (run.status === "stopping") {
      await finalize(runId, "done", `Detenido por ti tras ${run.okCount} de ${total} grupos.`);
      return;
    }

    const settings = await getSettings();

    /* Daily safety limit. */
    const limit = Math.max(0, Number(settings.dailyLimit) || 0);
    if (limit > 0 && (await countPostedToday()) >= limit) {
      await patchRun(runId, { status: "paused", pauseReason: "daily-limit", nextAt: 0 });
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        status: "info",
        message: `Límite diario de ${limit} publicaciones alcanzado. La campaña queda en pausa; puedes reanudarla cuando quieras.`
      });
      run = await waitWhilePaused(runId);
      if (run.status === "stopping") {
        await finalize(runId, "done", "Detenido por ti.");
        return;
      }
      /* The daily limit pauses the campaign. The loop restarts from the same
         group when the user resumes, instead of skipping it. */
      active = false;
      break loop;
    }

    const group = queue[index];
    if (!group) {
      index += 1;
      continue;
    }

    const message = await buildMessage(snapshot, index, group, settings, run);
    if (!message) {
      await finalize(runId, "error", "La campaña no tiene ningún texto que publicar.");
      return;
    }

    run = await patchRun(runId, {
      cursor: index,
      current: group,
      nextAt: 0,
      breakUntil: 0,
      pauseReason: ""
    });

    let result = await doPost(group, message, settings, snapshot, runImages);

    if (!result.ok && settings.retryOnce && isRetryable(result)) {
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        groupId: group.id,
        groupName: group.name,
        status: "info",
        message: "Primer intento fallido (" + result.error + "). Reintento en 8 segundos."
      });
      const waited = await waitDelay(runId, RETRY_MS);
      if (waited === "stop") {
        await finalize(runId, "done", "Detenido por ti durante un reintento.");
        return;
      }
      result = await doPost(group, message, settings, snapshot, runImages);
    }

    const runAfter = await readControl(runId);
    if (runAfter.status === "stopping") {
      const stopStatus = result.ok ? (result.pending ? "pending" : "posted") : "failed";
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        groupId: group.id,
        groupName: group.name,
        status: stopStatus,
        postUrl: result.postUrl || "",
        message: result.ok
          ? (result.pending ? "Enviado (pendiente de aprobación) antes de detener." : "Publicado antes de la orden de parada.")
          : result.error || "Falló"
      });
      await recordGroupOutcome({
        groupId: group.id,
        status: stopStatus,
        postUrl: result.postUrl || "",
        error: result.ok ? "" : result.error || "Falló",
        requiresApproval: Boolean(result.requiresApproval || result.pending)
      });
      await finalize(runId, "done", "Detenido por ti.");
      return;
    }

    if (result.ok) {
      const logStatus = result.pending ? "pending" : "posted";
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        groupId: group.id,
        groupName: group.name,
        status: logStatus,
        postUrl: result.postUrl || "",
        message:
          (result.pending ? "Enviado (pendiente de aprobación del admin)" : "Publicado") +
          (result.imageAttached ? " · con foto" : "") +
          (result.via ? " vía " + result.via : ""),
        raw: Array.isArray(result.debug) ? result.debug.join("\n") : ""
      });
      await recordGroupOutcome({
        groupId: group.id,
        status: logStatus,
        postUrl: result.postUrl || "",
        requiresApproval: Boolean(result.requiresApproval || result.pending)
      });
      await patchRun(runId, {
        okCount: runAfter.okCount + 1,
        consecutiveFails: 0,
        lastError: ""
      });
    } else {
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        groupId: group.id,
        groupName: group.name,
        status: "failed",
        message: result.error || "Falló",
        raw: (result.raw || "") + (Array.isArray(result.debug) ? "\n" + result.debug.join("\n") : "")
      });
      await recordGroupOutcome({
        groupId: group.id,
        status: "failed",
        error: result.error || "Falló"
      });
      const fails = runAfter.consecutiveFails + 1;
      await patchRun(runId, {
        failCount: runAfter.failCount + 1,
        consecutiveFails: fails,
        lastError: result.error || "Falló"
      });

      if (result.kind === "auth") {
        clearSessionCache();
        await finalize(runId, "error", "Tu sesión de Facebook no está disponible. Inicia sesión en facebook.com y vuelve a lanzar.");
        return;
      }
      if (result.kind === "checkpoint" || result.kind === "blocked") {
        await finalize(runId, "error", "Facebook está pidiendo una verificación o limitando la cuenta. La campaña se detuvo para que puedas revisarlo.");
        return;
      }
      if (fails >= MAX_CONSECUTIVE_FAILS) {
        await patchRun(runId, { status: "paused", pauseReason: "failures" });
        await logAndSave({
          campaignId: run.campaignId,
          campaignName: run.campaignName,
          status: "info",
          message: fails + " fallos seguidos. La campaña está en pausa. Reanuda cuando quieras."
        });
        run = await waitWhilePaused(runId);
        if (run.status === "stopping") {
          await finalize(runId, "done", "Detenido por ti.");
          return;
        }
        index += 1;
        continue;
      }
    }

    run = await readControl(runId);
    if (run.status === "stopping") {
      await finalize(runId, "done", `Detenido por ti tras ${run.okCount} de ${total} grupos.`);
      return;
    }

    const safetyEvery = Math.max(0, Number(settings.safetyEvery) || 0);
    if (safetyEvery > 0 && run.okCount > 0 && run.okCount % safetyEvery === 0 && index < total - 1) {
      const breakMs = Math.max(1, Number(settings.safetySec) || 0) * 1000;
      await patchRun(runId, { breakUntil: Date.now() + breakMs });
      await logAndSave({
        campaignId: run.campaignId,
        campaignName: run.campaignName,
        status: "break",
        message: "Descanso de seguridad de " + Math.round(breakMs / 60000) + " minuto(s) tras " + run.okCount + " publicaciones."
      });
      const waited = await waitDelay(runId, breakMs);
      await patchRun(runId, { breakUntil: 0 });
      if (waited === "stop") {
        await finalize(runId, "done", "Detenido por ti durante un descanso.");
        return;
      }
    }

    if (index < total - 1) {
      const min = Math.max(1, Number(snapshot.minDelaySec) || Number(settings.minDelaySec) || 60);
      const max = Math.max(min, Number(snapshot.maxDelaySec) || Number(settings.maxDelaySec) || min);
      const delayMs = jitterInt(min, max) * 1000;
      await patchRun(runId, { nextAt: Date.now() + delayMs });
      const waited = await waitDelay(runId, delayMs);
      if (waited === "stop") {
        await finalize(runId, "done", "Detenido por ti.");
        return;
      }
    }

    index += 1;
  }

  run = await readControl(runId);
  await finalize(runId, "done", `Terminado. ${run.okCount} publicados, ${run.failCount} fallidos.`);
}

/* ---------------- public API used by the offscreen message router ---------------- */

export async function startRun({ campaign, groups }) {
  const current = await getRun();
  const busy = ["running", "paused", "stopping"].includes(current.status);
  const stale = !current.heartbeat || Date.now() - current.heartbeat > 60 * 1000;
  if (busy && stale) {
    /* A killed offscreen document can leave an old run stuck. Clear it so a
       new campaign can start without having to hunt for a hidden stop button. */
    active = false;
    await saveRun({ ...EMPTY_RUN });
  } else if (active || busy) {
    throw new Error("Ya hay una campaña activa. Deténla primero.");
  }
  if (!Array.isArray(groups) || !groups.length) throw new Error("Selecciona al menos un grupo.");
  if (
    !campaign ||
    (!String(campaign.message || "").trim() && !(campaign.variations || []).some((value) => String(value || "").trim()))
  ) {
    throw new Error("Escribe un mensaje antes de lanzar.");
  }

  const runId = uid("run");
  const queue = groups.map((group) => ({
    id: group.id,
    name: group.name,
    url: group.url,
    numericId: group.numericId || "",
    pic: group.pic || ""
  }));
  const launchSettings = await getSettings();
  if (launchSettings.shuffleGroups === true) {
    for (let i = queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }

  const run = {
    id: runId,
    status: "running",
    campaignId: campaign.id || "",
    campaignName: campaign.name || "Campaña sin título",
    campaignSnapshot: {
      message: campaign.message || "",
      variations: campaign.variations || [],
      imageUrl: campaign.imageUrl || "",
      images: campaign.images || [],
      minDelaySec: campaign.minDelaySec,
      maxDelaySec: campaign.maxDelaySec
    },
    queue,
    cursor: 0,
    okCount: 0,
    failCount: 0,
    skipCount: 0,
    consecutiveFails: 0,
    current: null,
    nextAt: 0,
    breakUntil: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    lastError: "",
    pauseReason: "",
    finishedReason: "",
    heartbeat: Date.now()
  };

  await saveRun(run);
  await logAndSave({
    campaignId: run.campaignId,
    campaignName: run.campaignName,
    status: "info",
    message: "Campaña iniciada con " + queue.length + " grupo(s)." +
      (launchSettings.shuffleGroups === true ? " Orden barajado." : "")
  });

  active = true;
  loop(runId).catch(async (error) => {
    await finalize(runId, "error", "Error inesperado: " + (error && error.message ? error.message : error));
  });
  return run;
}

export async function pauseRun() {
  const run = await getRun();
  if (run.status !== "running") return run;
  return patchRun(run.id, { status: "paused", pauseReason: "user", nextAt: 0 });
}

export async function resumeRun() {
  const run = await getRun();
  if (run.status !== "paused") return run;
  const next = await patchRun(run.id, { status: "running", pauseReason: "" });
  if (!active && run.id) {
    active = true;
    loop(run.id).catch(async (error) => {
      await finalize(run.id, "error", "Error inesperado: " + (error && error.message ? error.message : error));
    });
  }
  return next;
}

export async function stopRun() {
  const run = await getRun();
  if (run.status === "idle" || run.status === "done" || run.status === "error") return run;
  const next = await patchRun(run.id, { status: "stopping", nextAt: 0, breakUntil: 0 });
  /* If no loop is alive (e.g. the offscreen document was recreated), finish
     right away so the state never remains stuck in "stopping". */
  if (!active) return finalize(run.id, "done", "Detenido por ti.");
  return next;
}

export async function resetRun() {
  const run = await getRun();
  if (run.id && ["running", "paused", "stopping"].includes(run.status)) {
    await patchRun(run.id, { status: "stopping", nextAt: 0, breakUntil: 0 });
    /* Give the loop time to notice and finalize before clearing, otherwise
       its next patchRun can write the old run back over EMPTY_RUN. */
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(100);
      const current = await getRun();
      if (current.id !== run.id || !["running", "paused", "stopping"].includes(current.status)) break;
    }
  }
  active = false;
  await saveRun({ ...EMPTY_RUN });
  return getRun();
}

export async function getStatus() {
  return getRun();
}

/* Called once when the offscreen document boots. A run left as running by a
   killed browser is marked paused instead of surprising the user with posts. */
export async function recoverOnBoot() {
  const run = await getRun();
  if (run.status === "idle" || run.status === "done" || run.status === "error") return run;
  const stale = !run.heartbeat || Date.now() - run.heartbeat > 2 * 60 * 1000;

  if (run.status === "stopping") {
    return finalize(run.id, "done", "Detenido por ti.");
  }

  if (run.status === "running" && stale) {
    await logAndSave({
      campaignId: run.campaignId,
      campaignName: run.campaignName,
      status: "info",
      message: "La ejecución se interrumpió. Continuando desde el grupo actual."
    });
    await patchRun(run.id, { status: "running", nextAt: 0, breakUntil: 0, pauseReason: "", heartbeat: Date.now() });
  }

  if (run.status === "paused" && run.pauseReason !== "recovered") return run;
  if (!active && run.id && run.queue && run.cursor < run.queue.length) {
    active = true;
    loop(run.id).catch(async (error) => {
      await finalize(run.id, "error", "Error inesperado: " + (error && error.message ? error.message : error));
    });
  }
  return getRun();
}
