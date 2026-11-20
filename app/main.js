import { state, loadAll, handleStorageChanges, subscribe } from "./state.js";
import { onChanged } from "../shared/store.js";
import { api } from "./api.js";
import { toast, fmtDuration } from "./ui.js";
import * as dashboard from "./views/dashboard.js";
import * as campaigns from "./views/campaigns.js";
import * as editor from "./views/editor.js";
import * as groups from "./views/groups.js";
import * as activity from "./views/activity.js";
import * as settings from "./views/settings.js";

const registry = { dashboard, campaigns, editor, groups, activity, settings };

const TITLES = {
  dashboard: ["Panel", "Lanza, vigila y revisa tus publicaciones en grupos."],
  campaigns: ["Campañas", "Escribe una vez, elige grupos y lanza cuando quieras."],
  editor: ["Editor de campaña", "Mensaje, audiencia, retardos y revisión."],
  groups: ["Grupos", "Tus grupos y listas guardadas."],
  activity: ["Actividad", "Cada publicación, fallo y descanso en un solo registro."],
  settings: ["Ajustes", "Sesión, transporte, preferencias y copia de seguridad."]
};

const viewHost = document.getElementById("view");
const pageTitle = document.getElementById("pageTitle");
const pageSub = document.getElementById("pageSub");
const sideRun = document.getElementById("sideRun");

let cleanup = null;
let renderToken = 0;
let tickTimer = null;

const parseHash = () => {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, param] = raw.split("/");
  return { name: registry[name] ? name : "dashboard", param: param || "" };
};

function applyTheme() {
  const choice = state.settings.theme || "system";
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = choice === "system" ? (dark ? "dark" : "light") : choice;
}

function setActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.nav === name);
  });
}

function runProgress(run) {
  const total = Array.isArray(run.queue) ? run.queue.length : 0;
  if (!total) return 0;
  return Math.min(100, Math.round(((run.okCount + run.failCount) / total) * 100));
}

function updateRunbar() {
  const run = state.run || {};
  const status = run.status || "idle";
  const total = Array.isArray(run.queue) ? run.queue.length : 0;
  const done = (run.okCount || 0) + (run.failCount || 0);

  const stateEl = document.getElementById("runState");
  const stateText = document.getElementById("runStateText");
  const fill = document.getElementById("runFill");
  const meta = document.getElementById("runMeta");
  const btnPause = document.getElementById("btnPause");
  const btnResume = document.getElementById("btnResume");
  const btnStop = document.getElementById("btnStop");

  stateEl.className = "runbar__state is-" + status;
  const labels = {
    idle: "Inactivo",
    running: "En marcha",
    paused: "En pausa",
    stopping: "Deteniendo",
    done: "Terminado",
    error: "Error"
  };
  stateText.textContent = labels[status] || status;
  fill.style.width = runProgress(run) + "%";

  if (total) {
    const left = total - done;
    let detail = done + "/" + total;
    if (status === "running" && run.breakUntil && run.breakUntil > Date.now()) {
      detail = "descanso · " + fmtDuration(run.breakUntil - Date.now());
    } else if (status === "running" && run.nextAt) {
      detail = "siguiente en " + fmtDuration(Math.max(0, run.nextAt - Date.now()));
    } else if (left > 0 && (status === "paused" || status === "stopping")) {
      detail = "quedan " + left;
    }
    meta.textContent = detail;
  } else {
    meta.textContent = "—";
  }

  btnPause.hidden = status !== "running";
  btnResume.hidden = status !== "paused";
  btnStop.hidden = ["running", "paused", "stopping"].includes(status) === false;
  btnStop.disabled = false;
  btnStop.textContent = status === "stopping" || status === "paused" ? "Descartar ejecución" : "Detener";

  if (run.status === "running" || run.status === "paused") {
    sideRun.textContent = (run.campaignName || "Campaña") + " · " + done + "/" + total;
  } else {
    sideRun.textContent = "Sin campaña activa";
  }
}

async function render() {
  const { name, param } = parseHash();
  setActiveNav(name === "editor" ? "campaigns" : name);
  const [title, sub] = TITLES[name] || TITLES.dashboard;
  pageTitle.textContent = name === "editor" && param ? "Editor de campaña" : title;
  pageSub.textContent = sub;

  const token = ++renderToken;
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
  }
  cleanup = null;
  viewHost.innerHTML = "";

  try {
    const result = await registry[name].mount(viewHost, param);
    if (token === renderToken && typeof result === "function") cleanup = result;
  } catch (error) {
    if (token !== renderToken) return;
    const box = document.createElement("div");
    box.className = "card";
    const body = document.createElement("div");
    body.className = "card__body";
    const title2 = document.createElement("div");
    title2.className = "strong";
    title2.textContent = "Esta página no se pudo cargar";
    const msg = document.createElement("p");
    msg.className = "muted";
    msg.textContent = String(error && error.message ? error.message : error);
    body.append(title2, msg);
    box.appendChild(body);
    viewHost.appendChild(box);
    toast("Algo falló en esta página.", "error");
  }
}

function wireRunButtons() {
  const runAction = async (action, successMessage) => {
    try {
      const res = await api(action);
      if (!res || res.ok === false) throw new Error((res && res.error) || "La acción falló");
      let message = successMessage;
      if (action === "run:stop" && res.run && ["done", "error", "idle"].includes(res.run.status)) {
        message = "La campaña ya había terminado.";
      }
      if (message) toast(message, "ok");
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  };
  document.getElementById("btnPause").addEventListener("click", () => runAction("run:pause", "En pausa."));
  document.getElementById("btnResume").addEventListener("click", () => runAction("run:resume", "Reanudada."));
  document.getElementById("btnStop").addEventListener("click", () => {
    const status = (state.run && state.run.status) || "idle";
    if (status === "stopping" || status === "paused") {
      runAction("run:reset", "Ejecución descartada.");
    } else {
      runAction("run:stop", "Se detendrá al terminar el grupo actual…");
    }
  });
}

async function boot() {
  try {
    await loadAll();
  } catch (error) {
    toast("No se pudieron leer los datos guardados: " + (error.message || error), "error");
  }
  applyTheme();
  wireRunButtons();
  updateRunbar();
  await render();

  onChanged(handleStorageChanges);
  subscribe((changes) => {
    if (changes.settings || changes.all) applyTheme();
    if (changes.run || changes.all) updateRunbar();
  });

  window.addEventListener("hashchange", render);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((state.settings.theme || "system") === "system") applyTheme();
  });

  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(updateRunbar, 1000);
}

boot();
