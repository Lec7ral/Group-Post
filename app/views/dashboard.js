import { state, subscribe } from "../state.js";
import { api } from "../api.js";
import { escapeHtml, fmtDuration, fmtTime, toast, confirmDialog } from "../ui.js";
import { launchCampaign } from "../launch.js";
import { todayKey } from "../../shared/util.js";

const DAY = 24 * 60 * 60 * 1000;

const TRANSPORT_LABEL = {
  auto: "Automático · navegador real y API de respaldo",
  ui: "Solo navegador real (UI de Facebook)",
  ajax: "Solo API clásica (sin ventana)",
  graphql: "Solo GraphQL"
};

function stats() {
  const log = state.log || [];
  const today = todayKey();
  const week = Date.now() - 7 * DAY;
  const isOk = (entry) => entry.status === "posted" || entry.status === "pending";
  const postedToday = log.filter((entry) => isOk(entry) && entry.day === today).length;
  const failedToday = log.filter((entry) => entry.status === "failed" && entry.day === today).length;
  const weekPosted = log.filter((entry) => isOk(entry) && entry.ts >= week).length;
  const weekFailed = log.filter((entry) => entry.status === "failed" && entry.ts >= week).length;
  const rate = weekPosted + weekFailed ? Math.round((weekPosted / (weekPosted + weekFailed)) * 100) : 0;
  return {
    postedToday,
    failedToday,
    rate,
    weekPosted,
    groups: state.groups.length,
    totalPosted: log.filter(isOk).length
  };
}

function statCard(label, value, sub) {
  return (
    '<div class="stat"><div class="stat__label">' +
    escapeHtml(label) +
    '</div><div class="stat__value">' +
    escapeHtml(String(value)) +
    '</div><div class="stat__sub">' +
    escapeHtml(sub) +
    "</div></div>"
  );
}

export async function mount(root) {
  root.innerHTML =
    '<div class="grid--stats" id="dashStats"></div>' +
    '<div class="grid grid--2">' +
    '<section class="card"><div class="card__head"><div class="card__title">Estado de la campaña</div><span class="badge" id="dashRunBadge">Inactivo</span></div><div class="card__body" id="dashRun"></div></section>' +
    '<section class="card"><div class="card__head"><div class="card__title">Lanzamiento rápido</div></div><div class="card__body" id="dashQuick"></div></section>' +
    "</div>" +
    '<section class="card"><div class="card__head"><div class="card__title">Registro en vivo</div><a class="btn btn--sm btn--ghost" href="#/activity">Abrir Actividad</a></div><div class="card__body" id="dashLog"></div></section>';

  const statsHost = root.querySelector("#dashStats");
  const runHost = root.querySelector("#dashRun");
  const badge = root.querySelector("#dashRunBadge");
  const quickHost = root.querySelector("#dashQuick");
  const logHost = root.querySelector("#dashLog");

  const renderStats = () => {
    const s = stats();
    statsHost.innerHTML = [
      statCard("Publicados hoy", s.postedToday, s.failedToday + " fallidos hoy"),
      statCard("Éxito 7 días", s.rate + "%", s.weekPosted + " ok / " + s.weekFailed + " fallidos"),
      statCard("Grupos guardados", s.groups, "en tu lista local"),
      statCard("Posts totales", s.totalPosted, "desde este navegador")
    ].join("");
  };

  const renderRun = () => {
    const run = state.run || {};
    const total = Array.isArray(run.queue) ? run.queue.length : 0;
    const done = (run.okCount || 0) + (run.failCount || 0) + (run.skipCount || 0);
    const active = ["running", "paused", "stopping"].includes(run.status);

    const statusLabel = {
      idle: "Inactivo",
      running: "En marcha",
      paused: "En pausa",
      stopping: "Deteniendo",
      done: "Terminado",
      error: "Error"
    };
    badge.className = "badge " + (run.status === "error" ? "badge--failed" : active ? "badge--info" : "badge--posted");
    badge.textContent = statusLabel[run.status] || "Inactivo";

    if (!active) {
      runHost.innerHTML =
        '<p class="muted small">No hay ninguna campaña en curso.</p>' +
        (run.status === "done" || run.status === "error"
          ? '<div class="inset" style="margin-top:10px">' +
            escapeHtml(run.finishedReason || "La última campaña ha terminado.") +
            (run.finishedAt ? '<div class="xs muted" style="margin-top:4px">' + escapeHtml(fmtTime(run.finishedAt)) + "</div>" : "") +
            "</div>"
          : "");
      return;
    }

    const pct = total ? Math.round((done / total) * 100) : 0;
    const next = run.breakUntil && run.breakUntil > Date.now()
      ? "Descanso de seguridad · " + fmtDuration(run.breakUntil - Date.now())
      : run.nextAt
        ? "Siguiente post en " + fmtDuration(Math.max(0, run.nextAt - Date.now()))
        : "Publicando ahora";

    runHost.innerHTML =
      '<div class="runpanel">' +
      '<div class="runpanel__row"><span class="strong">' + escapeHtml(run.campaignName || "Campaña") + '</span><span class="muted">' + done + " / " + total + "</span></div>" +
      '<div class="progress"><div class="progress__fill" style="width:' + pct + '%"></div></div>' +
      '<div class="runpanel__row"><span class="muted">' + escapeHtml(next) + "</span><span>" +
      '<span class="badge badge--posted">' + (run.okCount || 0) + " ok</span> " +
      ((run.skipCount || 0) ? '<span class="badge badge--skipped">' + run.skipCount + " omitidos</span> " : "") +
      '<span class="badge badge--failed">' + (run.failCount || 0) + " fallidos</span>" +
      "</span></div>" +
      (run.pauseReason === "daily-limit"
        ? '<div class="inset" style="border-color:var(--warn, #eab308)">Límite diario alcanzado. Reanuda mañana o súbelo en Ajustes.</div>'
        : "") +
      (run.current
        ? '<div class="inset">Grupo actual: <a href="' + escapeHtml(run.current.url || "#") + '" target="_blank" rel="noopener">' + escapeHtml(run.current.name || run.current.id) + "</a></div>"
        : "") +
      (run.lastError ? '<div class="inset" style="border-color:var(--bad)">' + escapeHtml(run.lastError) + "</div>" : "") +
      '<div class="row">' +
      (run.status === "running" ? '<button class="btn btn--sm" id="dashPause">Pausar</button>' : "") +
      (run.status === "paused" ? '<button class="btn btn--sm btn--primary" id="dashResume">Reanudar</button>' : "") +
      (["running", "paused", "stopping"].includes(run.status)
        ? '<button class="btn btn--sm btn--danger" id="dashStop">' + (run.status === "stopping" || run.status === "paused" ? "Descartar" : "Detener") + "</button>"
        : "") +
      "</div></div>";

    runHost.querySelector("#dashPause")?.addEventListener("click", () => act("run:pause", "En pausa."));
    runHost.querySelector("#dashResume")?.addEventListener("click", () => act("run:resume", "Reanudada."));
    runHost.querySelector("#dashStop")?.addEventListener("click", async () => {
      const discard = run.status === "stopping" || run.status === "paused";
      const message = discard ? "¿Descartar esta ejecución?" : "¿Detener esta campaña cuando acabe el grupo actual?";
      if (await confirmDialog(message, { title: discard ? "Descartar ejecución" : "Detener campaña", confirmLabel: discard ? "Descartar" : "Detener" })) {
        act(discard ? "run:reset" : "run:stop", discard ? "Ejecución descartada." : "Deteniendo…");
      }
    });
  };

  const act = async (action, message) => {
    const res = await api(action);
    if (!res || res.ok === false) toast((res && res.error) || "La acción falló", "error");
    else if (message) toast(message, "ok");
  };

  const renderQuick = () => {
    const options = state.campaigns
      .map((campaign) => {
        const count = (campaign.groupIds || []).length;
        return '<option value="' + escapeHtml(campaign.id) + '">' + escapeHtml(campaign.name) + " (" + count + " grupos)</option>";
      })
      .join("");
    const settings = state.settings || {};
    const mode = TRANSPORT_LABEL[settings.transport] || TRANSPORT_LABEL.auto;
    const windowNote = settings.workTarget === "newtab" ? "pestaña nueva de Facebook" : "pestaña de Facebook abierta";
    quickHost.innerHTML =
      (state.campaigns.length
        ? '<div class="field"><label class="label" for="quickCampaign">Campaña</label><select class="select" id="quickCampaign">' + options + "</select></div>" +
          '<div class="row" style="margin-top:12px"><button class="btn btn--primary" id="quickLaunch">Lanzar</button><a class="btn btn--ghost" href="#/campaigns">Gestionar campañas</a></div>' +
          '<p class="hint" style="margin-top:12px">La campaña sigue aunque esta pestaña esté en segundo plano. Modo: ' +
          escapeHtml(mode) + " · " + escapeHtml(windowNote) + ".</p>"
        : '<p class="muted small">Todavía no hay campañas.</p><div class="row" style="margin-top:10px"><a class="btn btn--primary" href="#/campaigns">Crear una campaña</a></div>');

    quickHost.querySelector("#quickLaunch")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const campaign = state.campaigns.find((item) => item.id === quickHost.querySelector("#quickCampaign").value);
      try {
        button.disabled = true;
        await launchCampaign(campaign);
      } catch (error) {
        toast(String(error.message || error), "error");
      } finally {
        button.disabled = false;
      }
    });
  };

  const renderLog = () => {
    const entries = (state.log || []).slice(-8).reverse();
    if (!entries.length) {
      logHost.innerHTML = '<div class="empty">Aún no hay nada. Aquí aparecerán los grupos publicados, los fallos y los descansos.</div>';
      return;
    }
    logHost.innerHTML =
      '<div class="list">' +
      entries
        .map(
          (entry) =>
            '<div class="list__row"><span class="muted xs mono">' + escapeHtml(fmtTime(entry.ts)) + "</span>" +
            '<span class="badge badge--' + escapeHtml(entry.status || "info") + '">' + escapeHtml(entry.status || "info") + "</span>" +
            '<span class="small">' + escapeHtml(entry.groupName || entry.message || "") + "</span>" +
            (entry.postUrl ? '<a class="right xs" href="' + escapeHtml(entry.postUrl) + '" target="_blank" rel="noopener">abrir</a>' : "") +
            "</div>"
        )
        .join("") +
      "</div>";
  };

  const renderAll = () => {
    renderStats();
    renderRun();
    renderQuick();
    renderLog();
  };

  renderAll();
  const unsub = subscribe((changes) => {
    if (changes.all) {
      renderAll();
      return;
    }
    if (changes.log) {
      renderStats();
      renderLog();
    }
    if (changes.run) renderRun();
    if (changes.campaigns || changes.groups || changes.settings) renderQuick();
  });

  const tick = setInterval(() => {
    if (["running", "paused", "stopping"].includes((state.run || {}).status)) renderRun();
  }, 1000);

  return () => {
    unsub();
    clearInterval(tick);
  };
}
