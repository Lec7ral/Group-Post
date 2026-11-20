/* Thin bridge between the dashboard page and the engine in the offscreen
   document (relayed by the service worker). */

export const api = (action, payload = {}) =>
  chrome.runtime.sendMessage({ type: "gp:api", action, payload });

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
