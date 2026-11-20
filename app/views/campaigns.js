import { state, subscribe } from "../state.js";
import { saveCampaigns } from "../../shared/store.js";
import { launchCampaign } from "../launch.js";
import { api } from "../api.js";
import { escapeHtml, fmtDateTime, toast, confirmDialog, fmtDelay } from "../ui.js";
import { uid } from "../../shared/util.js";

const delayLabel = (campaign) => {
  const min = Number(campaign.minDelaySec) || 0;
  const max = Number(campaign.maxDelaySec) || 0;
  if (!min && !max) return "Por defecto";
  return fmtDelay(min, max);
};

export async function mount(root) {
  root.innerHTML =
    '<div class="row row--spread">' +
    '<div class="row"><a class="btn btn--primary" href="#/editor/new">Nueva campaña</a></div>' +
    '<span class="muted small" id="campCount"></span>' +
    "</div>" +
    '<section class="card"><div class="tablewrap" id="campWrap"></div></section>';

  const wrap = root.querySelector("#campWrap");
  const count = root.querySelector("#campCount");

  const render = () => {
    const campaigns = state.campaigns || [];
    count.textContent = campaigns.length + " guardadas";
    if (!campaigns.length) {
      wrap.innerHTML =
        '<div class="empty">Todavía no hay campañas.<br><a href="#/editor/new">Crea la primera</a> para escribir un post una vez y enviarlo a muchos grupos.</div>';
      return;
    }
    wrap.innerHTML =
      '<table class="table"><thead><tr><th>Campaña</th><th>Grupos</th><th>Retardo</th><th>Actualizada</th><th style="width:1%"></th></tr></thead><tbody>' +
      campaigns
        .map(
          (campaign) =>
            "<tr>" +
            '<td><div class="strong">' + escapeHtml(campaign.name || "Sin título") + "</div>" +
            '<div class="xs muted">' + escapeHtml((campaign.message || "").slice(0, 90)) + "</div></td>" +
            "<td>" + (campaign.groupIds || []).length + "</td>" +
            "<td>" + escapeHtml(delayLabel(campaign)) + "</td>" +
            '<td class="muted xs">' + escapeHtml(fmtDateTime(campaign.updatedAt)) + "</td>" +
            '<td><div class="row" style="flex-wrap:nowrap">' +
            '<button class="btn btn--sm btn--primary" data-act="run" data-id="' + escapeHtml(campaign.id) + '">Lanzar</button>' +
            '<a class="btn btn--sm" href="#/editor/' + escapeHtml(campaign.id) + '">Editar</a>' +
            '<button class="btn btn--sm btn--ghost" data-act="duplicate" data-id="' + escapeHtml(campaign.id) + '">Duplicar</button>' +
            '<button class="btn btn--sm btn--danger" data-act="delete" data-id="' + escapeHtml(campaign.id) + '">Borrar</button>' +
            "</div></td></tr>"
        )
        .join("") +
      "</tbody></table>";
  };

  const onClick = async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const campaign = state.campaigns.find((item) => item.id === button.dataset.id);
    if (!campaign) return;

    if (button.dataset.act === "run") {
      try {
        button.disabled = true;
        await launchCampaign(campaign);
      } catch (error) {
        toast(String(error.message || error), "error");
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (button.dataset.act === "duplicate") {
      const copy = {
        ...campaign,
        id: uid("cmp"),
        name: (campaign.name || "Sin título") + " (copia)",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await saveCampaigns([...state.campaigns, copy]);
      toast("Campaña duplicada.", "ok");
      return;
    }

    if (button.dataset.act === "delete") {
      const ok = await confirmDialog('¿Borrar "' + (campaign.name || "Sin título") + '"? No se puede deshacer.', {
        title: "Borrar campaña",
        confirmLabel: "Borrar"
      });
      if (!ok) return;
      const run = state.run || {};
      if (run.campaignId === campaign.id && ["running", "paused", "stopping"].includes(run.status)) {
        try {
          await api("run:reset");
        } catch {
          /* the engine will clear the stale run on the next launch */
        }
      }
      await saveCampaigns(state.campaigns.filter((item) => item.id !== campaign.id));
      toast("Campaña borrada.", "ok");
    }
  };

  wrap.addEventListener("click", onClick);
  render();
  const unsub = subscribe((changes) => {
    if (changes.campaigns || changes.all) render();
  });
  return () => {
    wrap.removeEventListener("click", onClick);
    unsub();
  };
}
