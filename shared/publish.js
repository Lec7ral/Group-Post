/* Transport router.

   "auto" (default) posts through the real Facebook page first, because a
   real browser session is far more robust than an internal endpoint, and
   falls back to the API transports when the page automation cannot finish.
   "ui" uses only the browser, "ajax" and "graphql" use only the API. */

import { publishToGroup } from "./fb.js";

const UI_TIMEOUT_MS = 150000;

const uiRequest = (payload) =>
  Promise.race([
    chrome.runtime.sendMessage({ type: "gp:uiPost", payload }),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: "La ventana de Facebook no respondió a tiempo.", code: "ui_timeout" }),
        UI_TIMEOUT_MS
      )
    )
  ]);

const describeUiFailure = (result) => {
  if (!result) return "La ventana de Facebook no devolvió nada.";
  if (result.error) return result.error;
  if (result.code) return "La automatización de la página se detuvo (" + result.code + ").";
  return "No se pudo confirmar la publicación en la página.";
};

export async function publish({ group, message, settings = {}, options = {} }) {
  const mode = String(settings.transport || "auto");

  const hasImages = Boolean(options.image) || (Array.isArray(options.images) && options.images.some(Boolean));

  if (mode === "ajax" || mode === "graphql") {
    if (hasImages) {
      return { ok: false, kind: "config", error: "Las fotos requieren el transporte «Navegador real» o «Automático».", via: mode };
    }
    return publishToGroup({ group, message, settings });
  }

  const attemptUi = async () => {
    let response;
    try {
      response = await uiRequest({ group, message, options: { ...options, debug: settings.debugLogs === true } });
    } catch (error) {
      return {
        ok: false,
        via: "ui",
        kind: "ui",
        code: "ui_bridge",
        error: String(error && error.message ? error.message : error)
      };
    }
    if (response && response.ok && response.result) {
      const result = response.result;
      if (result.ok) {
        return {
          ok: true,
          via: "ui",
          pending: Boolean(result.pending),
          requiresApproval: Boolean(result.requiresApproval || result.pending),
          imageAttached: Boolean(result.image),
          debug: result.debug || [],
          postUrl: result.url || group.url || ""
        };
      }
      if (result.checkpoint) {
        return { ok: false, via: "ui", kind: "checkpoint", code: result.code || "checkpoint", error: result.error };
      }
      return {
        ok: false,
        via: "ui",
        kind: result.code === "bad_group_page" ? "config" : "ui",
        code: result.code || "ui_failed",
        skip: Boolean(result.skip),
        error: describeUiFailure(result),
        debug: result.debug || []
      };
    }
    return {
      ok: false,
      via: "ui",
      kind: "ui",
      code: (response && response.code) || "ui_failed",
      error: (response && response.error) || "La ventana de Facebook no aceptó la petición."
    };
  };

  const uiResult = await attemptUi();
  if (uiResult.ok) return uiResult;
  if (
    mode === "ui" ||
    hasImages ||
    uiResult.kind === "checkpoint" ||
    uiResult.kind === "config" ||
    uiResult.skip === true ||
    ["cannot_post", "group_paused", "buy_sell_only", "submit_disabled", "dialog_open", "no_image"].includes(uiResult.code)
  ) {
    return uiResult;
  }

  /* auto: the page could not do it, try the API before giving up. */
  const apiResult = await publishToGroup({ group, message, settings });
  if (apiResult.ok) return { ...apiResult, fellBackFrom: uiResult.code || uiResult.error };
  return {
    ...apiResult,
    error: apiResult.error + " · Navegador: " + uiResult.error,
    debug: uiResult.debug || []
  };
}
