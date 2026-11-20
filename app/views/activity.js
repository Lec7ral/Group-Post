import { state, subscribe } from "../state.js";
import { clearLog } from "../../shared/store.js";
import { escapeHtml, fmtDateTime, download, toast, confirmDialog } from "../ui.js";

const FILTERS = [
  ["all", "Todo"],
  ["posted", "Publicados"],
  ["failed", "Fallidos"],
  ["break", "Descansos"],
  ["info", "Info"]
];

const STATUS_LABEL = {
  posted: "publicado",
  pending: "pendiente",
  failed: "fallido",
  skipped: "omitido",
  break: "descanso",
  info: "info"
};

const csvCell = (value) => '"' + String(value ?? "").replace(/"/g, '""') + '"';

export async function mount(root) {
  root.innerHTML =
    '<div class="row row--spread">' +
    '<div class="row"><div class="tabs" id="actTabs">' +
    FILTERS.map(([key, label], index) => '<button class="tab' + (index === 0 ? " is-active" : "") + '" type="button" data-filter="' + key + '">' + label + "</button>").join("") +
    "</div></div>" +
    '<div class="row"><input class="input input--sm" id="actSearch" placeholder="Buscar grupo o mensaje…" style="width:220px" autocomplete="off">' +
    '<button class="btn btn--sm" id="actExport" type="button">Exportar CSV</button>' +
    '<button class="btn btn--sm btn--danger" id="actClear" type="button">Vaciar registro</button></div></div>' +
    '<section class="card"><div class="card__head"><div class="card__title" id="actSummary">0 entradas</div></div><div class="tablewrap" id="actTable"></div></section>';

  const tableHost = root.querySelector("#actTable");
  const summary = root.querySelector("#actSummary");
  const search = root.querySelector("#actSearch");
  let filter = "all";

  const filtered = () => {
    const query = (search.value || "").toLowerCase().trim();
    return (state.log || [])
      .filter((entry) => (filter === "all" ? true : entry.status === filter))
      .filter(
        (entry) =>
          !query ||
          String(entry.groupName || "").toLowerCase().includes(query) ||
          String(entry.message || "").toLowerCase().includes(query) ||
          String(entry.campaignName || "").toLowerCase().includes(query)
      )
      .slice()
      .reverse();
  };

  const render = () => {
    const entries = filtered();
    const posted = entries.filter((entry) => entry.status === "posted").length;
    const failed = entries.filter((entry) => entry.status === "failed").length;
    summary.textContent = entries.length + " entradas · " + posted + " publicados · " + failed + " fallidos";

    if (!entries.length) {
      tableHost.innerHTML = '<div class="empty">Aún no hay nada aquí. Lanza una campaña y cada publicación, fallo y descanso aparecerá en este registro.</div>';
      return;
    }

    tableHost.innerHTML =
      '<table class="table"><thead><tr><th>Cuándo</th><th>Estado</th><th>Grupo</th><th>Campaña</th><th>Detalles</th></tr></thead><tbody>' +
      entries
        .slice(0, 1500)
        .map(
          (entry) =>
            "<tr>" +
            '<td class="xs muted" style="white-space:nowrap">' + escapeHtml(fmtDateTime(entry.ts)) + "</td>" +
            '<td><span class="badge badge--' + escapeHtml(entry.status || "info") + '">' + escapeHtml(STATUS_LABEL[entry.status] || entry.status || "info") + "</span></td>" +
            "<td>" + (entry.groupName ? escapeHtml(entry.groupName) : '<span class="muted">—</span>') + "</td>" +
            '<td class="xs muted">' + escapeHtml(entry.campaignName || "—") + "</td>" +
            '<td class="small">' + escapeHtml(entry.message || "") +
            (entry.postUrl ? ' <a class="xs" href="' + escapeHtml(entry.postUrl) + '" target="_blank" rel="noopener">ver post</a>' : "") +
            (entry.raw ? '<div class="xs muted mono" style="white-space:pre-wrap;margin-top:4px">' + escapeHtml(String(entry.raw).slice(0, 240)) + "</div>" : "") +
            "</td></tr>"
        )
        .join("") +
      "</tbody></table>";
  };

  root.querySelector("#actTabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    filter = button.dataset.filter;
    root.querySelectorAll("#actTabs .tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
    render();
  });

  search.addEventListener("input", render);

  root.querySelector("#actExport").addEventListener("click", () => {
    const rows = filtered();
    if (!rows.length) {
      toast("No hay nada que exportar.", "error");
      return;
    }
    const header = ["hora", "estado", "grupo", "id_grupo", "campaña", "url_post", "detalles"];
    const lines = [header.map(csvCell).join(",")];
    for (const entry of rows) {
      lines.push(
        [
          new Date(entry.ts).toISOString(),
          entry.status,
          entry.groupName,
          entry.groupId,
          entry.campaignName,
          entry.postUrl,
          entry.message
        ]
          .map(csvCell)
          .join(",")
      );
    }
    download("group-poster-actividad-" + new Date().toISOString().slice(0, 10) + ".csv", lines.join("\r\n"), "text/csv");
    toast("CSV exportado.", "ok");
  });

  root.querySelector("#actClear").addEventListener("click", async () => {
    if (!(await confirmDialog("¿Borrar todo el registro de actividad? No se puede deshacer.", { title: "Vaciar registro", confirmLabel: "Vaciar" }))) return;
    await clearLog();
    toast("Registro vaciado.", "ok");
  });

  render();
  const unsub = subscribe((changes) => {
    if (changes.log || changes.all) render();
  });
  return unsub;
}
