/* Thin bridge between the dashboard page and the engine in the offscreen
   document (relayed by the service worker). */

import { getRun } from "../shared/store.js";

const hasExtensionRuntime = () =>
  typeof chrome !== "undefined" && Boolean(chrome.runtime && typeof chrome.runtime.sendMessage === "function");

export const api = async (action, payload = {}) => {
  if (hasExtensionRuntime()) {
    return chrome.runtime.sendMessage({ type: "gp:api", action, payload });
  }
  if (action === "run:status") {
    return { ok: true, run: await getRun() };
  }
  return {
    ok: false,
    error: "Esta acción requiere ejecutar Group Poster como extensión en Chrome (chrome://extensions) con una sesión activa de Facebook."
  };
};

export async function must(action, payload = {}) {
  let response;
  try {
    response = await api(action, payload);
  } catch (error) {
    throw new Error("El segundo plano de la extensión no responde. Recarga Group Poster en chrome://extensions.");
  }
  if (!response || response.ok === false) {
    throw new Error((response && response.error) || "La petición falló.");
  }
  return response;
}
