import { state, groupById } from "./state.js";
import { api } from "./api.js";
import { confirmDialog, toast, fmtDelay } from "./ui.js";

export async function launchCampaign(campaign) {
  if (!campaign) throw new Error("Campaña no encontrada.");
  const ids = Array.isArray(campaign.groupIds) ? campaign.groupIds : [];
  if (!ids.length) throw new Error("Esta campaña no tiene grupos. Ábrela y elige una audiencia primero.");

  const groups = ids.map(groupById).filter(Boolean);
  if (!groups.length) {
    throw new Error("Ninguno de los grupos seleccionados existe ya. Abre la campaña y elige grupos de nuevo.");
  }
  const missing = ids.length - groups.length;

  const minSec = Number(campaign.minDelaySec) || state.settings.minDelaySec || 60;
  const maxSec = Number(campaign.maxDelaySec) || state.settings.maxDelaySec || 120;
  const limit = Number(state.settings.dailyLimit) || 0;
  const ok = await confirmDialog(
    `¿Publicar «${campaign.name}» en ${groups.length} grupo(s) con un retardo de ${fmtDelay(minSec, maxSec)} entre posts?` +
      (limit > 0 ? ` Si se alcanza el límite diario de ${limit}, la campaña se pausará sola.` : "") +
      (missing ? ` ${missing} grupo(s) guardados ya no están disponibles y se omitirán.` : ""),
    { title: "Lanzar campaña", confirmLabel: "Lanzar ahora" }
  );
  if (!ok) return null;

  const response = await api("run:start", { campaign, groups });
  if (!response || response.ok === false) {
    throw new Error((response && response.error) || "La campaña no pudo arrancar.");
  }
  toast("Campaña iniciada. Puedes dejar esta pestaña en segundo plano.", "ok");
  return response.run;
}
