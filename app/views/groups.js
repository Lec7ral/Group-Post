import { state, subscribe } from "../state.js";
import { saveGroups, saveLists, readGroups, buildGroupMetrics } from "../../shared/store.js";
import { must } from "../api.js";
import { escapeHtml, fmtDateTime, toast, confirmDialog, promptDialog, textareaDialog, contentDialog, busy } from "../ui.js";
import { uid, normalizeGroupUrl } from "../../shared/util.js";

const listTemplate = (lists) =>
  lists.length
    ? lists
        .map(
          (list) =>
            '<div class="list__row">' +
            '<span class="strong">' + escapeHtml(list.name) + "</span>" +
            '<span class="muted xs">' + (list.groupIds || []).length + " grupos</span>" +
            '<span class="right row" style="flex-wrap:nowrap">' +
            '<button class="btn btn--sm btn--ghost" data-list-act="rename" data-id="' + escapeHtml(list.id) + '">Renombrar</button>' +
            '<button class="btn btn--sm btn--danger" data-list-act="delete" data-id="' + escapeHtml(list.id) + '">Borrar</button>' +
            "</span></div>"
        )
        .join("")
    : '<div class="empty" style="padding:20px">Todavía no hay listas. Marca grupos abajo y guárdalos como lista.</div>';

function extractGroupFromInput(line) {
  const url = normalizeGroupUrl(line);
  if (!url) return null;
  const match = url.match(/\/groups\/([^/]+)/);
  const id = match ? decodeURIComponent(match[1]) : "";
  if (!id) return null;
  return {
    id,
    name: id,
    url: "https://www.facebook.com/groups/" + id + "/",
    pic: "",
    members: "",
    lastVisited: 0,
    numericId: /^\d+$/.test(id) ? id : ""
  };
}

export async function mount(root) {
  root.innerHTML =
    '<div class="row row--spread">' +
    '<div class="row"><button class="btn btn--primary" id="grLoad" type="button">Cargar mis grupos</button>' +
    '<button class="btn" id="grAdd" type="button">Añadir por URL</button>' +
    '<button class="btn" id="grImportUrls" type="button">Importar lista de URLs</button></div>' +
    '<span class="muted small" id="grCount"></span>' +
    "</div>" +
    '<div id="grNotice"></div>' +
    '<section class="card"><div class="card__head"><div class="card__title">Grupos</div>' +
    '<div class="row">' +
    '<select class="select input--sm" id="grFilter" style="width:auto">' +
    '<option value="all">Todos</option>' +
    '<option value="active">Con historial</option>' +
    '<option value="approval">Requiere aprobación</option>' +
    '<option value="skipped">Omitidos</option>' +
    '<option value="failed">Con fallos</option>' +
    "</select>" +
    '<input class="input input--sm" id="grSearch" placeholder="Buscar grupos…" style="width:220px" autocomplete="off"></div></div>' +
    '<div class="tablewrap" id="grTable"></div></section>' +
    '<section class="card"><div class="card__head"><div class="card__title">Listas guardadas</div>' +
    '<button class="btn btn--sm" id="grSaveList" type="button">Guardar selección como lista</button></div>' +
    '<div class="card__body" id="grLists"></div></section>';

  const tableHost = root.querySelector("#grTable");
  const listsHost = root.querySelector("#grLists");
  const countHost = root.querySelector("#grCount");
  const noticeHost = root.querySelector("#grNotice");
  const searchInput = root.querySelector("#grSearch");
  const filterSelect = root.querySelector("#grFilter");
  const selected = new Set();

  const metricsMap = () => buildGroupMetrics(state.groupStats, state.log);

  const renderTable = () => {
    const query = (searchInput.value || "").toLowerCase().trim();
    const filterMode = filterSelect.value || "all";
    const metrics = metricsMap();
    const groups = (state.groups || []).filter((group) => {
      if (query && !group.name.toLowerCase().includes(query) && !String(group.id).toLowerCase().includes(query)) {
        return false;
      }
      const m = metrics[group.id];
      const needsApproval = Boolean(group.requiresApproval || (m && (m.requiresApproval || m.pending > 0)));
      const total = m ? (m.posted || 0) + (m.pending || 0) + (m.failed || 0) + (m.skipped || 0) : 0;
      if (filterMode === "active") return total > 0;
      if (filterMode === "approval") return needsApproval;
      if (filterMode === "skipped") return Boolean(m && m.skipped > 0);
      if (filterMode === "failed") return Boolean(m && m.failed > 0);
      return true;
    });
    countHost.textContent = state.groups.length + " grupo(s)";

    if (!groups.length) {
      tableHost.innerHTML = state.groups.length
        ? '<div class="empty">Ningún grupo coincide con la búsqueda o filtro.</div>'
        : '<div class="empty">Todavía no hay grupos.<br>Pulsa <strong>Cargar mis grupos</strong>, usa <strong>Añadir por URL</strong> o pega varias direcciones con <strong>Importar lista de URLs</strong>.</div>';
      return;
    }

    tableHost.innerHTML =
      '<table class="table"><thead><tr><th style="width:36px"></th><th>Grupo</th><th>Miembros</th><th>Métricas</th><th>Último envío / visita</th><th style="width:1%"></th></tr></thead><tbody>' +
      groups
        .map((group) => {
          const checked = selected.has(group.id) ? " checked" : "";
          const m = metrics[group.id] || { posted: 0, pending: 0, failed: 0, skipped: 0, lastPostAt: 0, requiresApproval: false };
          const okTotal = (m.posted || 0) + (m.pending || 0);
          const rateTotal = okTotal + (m.failed || 0);
          const total = rateTotal + (m.skipped || 0);
          const rate = rateTotal ? Math.round((okTotal / rateTotal) * 100) : 0;
          const needsApproval = Boolean(group.requiresApproval || m.requiresApproval || m.pending > 0);
          const avatar = group.pic
            ? '<img class="avatar" src="' + escapeHtml(group.pic) + '" alt="" loading="lazy">'
            : '<span class="avatar">' + escapeHtml((group.name || "?").slice(0, 2).toUpperCase()) + "</span>";
          const metricsHtml = total
            ? '<div class="row" style="gap:6px">' +
              '<span class="badge badge--posted">' + m.posted + " ok</span>" +
              (m.pending ? '<span class="badge badge--pending">' + m.pending + " pend.</span>" : "") +
              (m.skipped ? '<span class="badge badge--skipped">' + m.skipped + " omit.</span>" : "") +
              (m.failed ? '<span class="badge badge--failed">' + m.failed + " fallos</span>" : "") +
              (rateTotal ? '<span class="xs muted">' + rate + "%</span>" : "") +
              "</div>"
            : '<span class="xs muted">Sin envíos</span>';
          const lastActivity = m.lastPostAt || group.lastVisited || 0;
          return (
            '<tr data-id="' + escapeHtml(group.id) + '">' +
            '<td><input type="checkbox" data-pick="' + escapeHtml(group.id) + '"' + checked + ' style="accent-color:var(--accent)"></td>' +
            "<td><div class=\"row\" style=\"flex-wrap:nowrap\">" + avatar + '<div><div class="row" style="gap:6px"><span class="strong">' + escapeHtml(group.name) + "</span>" +
            (needsApproval ? '<span class="badge badge--pending" title="Se detectó aprobación de administrador en este grupo">Requiere aprobación</span>' : "") +
            "</div>" +
            '<div class="xs muted">' + escapeHtml(group.id) + "</div></div></div></td>" +
            "<td>" + escapeHtml(group.members || "—") + "</td>" +
            "<td>" + metricsHtml + "</td>" +
            '<td class="muted xs">' + (lastActivity ? escapeHtml(fmtDateTime(lastActivity)) : "—") + "</td>" +
            '<td><div class="row" style="flex-wrap:nowrap">' +
            '<button class="btn btn--sm btn--ghost" data-act="history" data-id="' + escapeHtml(group.id) + '">Historial</button>' +
            '<a class="btn btn--sm btn--ghost" href="' + escapeHtml(group.url) + '" target="_blank" rel="noopener">Abrir</a>' +
            '<button class="btn btn--sm btn--ghost" data-act="visit" data-id="' + escapeHtml(group.id) + '">Visitado</button>' +
            '<button class="btn btn--sm btn--danger" data-act="remove" data-id="' + escapeHtml(group.id) + '">Quitar</button>' +
            "</div></td></tr>"
          );
        })
        .join("") +
      "</tbody></table>";
    syncSelection();
  };

  const syncSelection = () => {
    tableHost.querySelectorAll("input[data-pick]").forEach((box) => {
      box.checked = selected.has(box.dataset.pick);
    });
  };

  const renderLists = () => {
    listsHost.innerHTML = listTemplate(state.lists || []);
  };

  const showNotice = (html, kind = "info") => {
    if (!html) {
      noticeHost.innerHTML = "";
      return;
    }
    const color = kind === "error" ? "var(--bad)" : "var(--line2)";
    noticeHost.innerHTML = '<div class="inset" style="border-color:' + color + '">' + html + "</div>";
  };

  const openGroupHistory = async (group) => {
    const metrics = metricsMap()[group.id] || { posted: 0, pending: 0, failed: 0, skipped: 0, lastPostAt: 0, requiresApproval: false };
    const entries = (state.log || [])
      .filter((item) => item.groupId === group.id)
      .slice()
      .reverse()
      .slice(0, 60);

    const wrap = document.createElement("div");
    wrap.className = "col";
    const summaryHtml =
      '<div class="row" style="gap:8px">' +
      '<span class="badge badge--posted">' + (metrics.posted || 0) + " publicados</span>" +
      '<span class="badge badge--pending">' + (metrics.pending || 0) + " pendientes</span>" +
      '<span class="badge badge--skipped">' + (metrics.skipped || 0) + " omitidos</span>" +
      '<span class="badge badge--failed">' + (metrics.failed || 0) + " fallidos</span>" +
      (group.requiresApproval || metrics.requiresApproval
        ? '<span class="badge badge--pending">Requiere aprobación de admin</span>'
        : "") +
      "</div>";

    const listHtml = entries.length
      ? '<div class="list" style="max-height:320px;overflow:auto">' +
        entries
          .map(
            (entry) =>
              '<div class="list__row">' +
              '<span class="xs muted mono">' + escapeHtml(fmtDateTime(entry.ts)) + "</span>" +
              '<span class="badge badge--' + escapeHtml(entry.status || "info") + '">' + escapeHtml(entry.status || "info") + "</span>" +
              '<span class="small" style="flex:1">' + escapeHtml(entry.campaignName ? entry.campaignName + " · " : "") + escapeHtml(entry.message || "") + "</span>" +
              (entry.postUrl ? '<a class="xs" href="' + escapeHtml(entry.postUrl) + '" target="_blank" rel="noopener">ver</a>' : "") +
              "</div>"
          )
          .join("") +
        "</div>"
      : '<div class="empty" style="padding:20px">Todavía no hay envíos registrados para este grupo.</div>';

    wrap.innerHTML = summaryHtml + listHtml;
    await contentDialog({ title: "Historial · " + (group.name || group.id), body: wrap, confirmLabel: "Cerrar", cancelLabel: "" });
  };

  const loadGroups = async (button) => {
    busy(button, true, "Cargando…");
    showNotice("");
    try {
      const response = await must("groups:load");
      const found = Number(response.count);
      const added = Number.isFinite(found) ? found : (response.groups || []).length;
      showNotice(
        "Cargados " + added + " grupo(s) desde Facebook" +
          (response.via === "ui" ? " con el navegador real" : response.via === "tab" ? " con una pestaña oculta" : "") +
          ". Total en tu lista: " + (response.groups || []).length + "."
      );
      toast("Grupos actualizados.", "ok");
      await readGroups().then((groups) => {
        state.groups = groups;
        renderTable();
      });
    } catch (error) {
      showNotice(
        "<strong>No se pudieron cargar los grupos.</strong> " + escapeHtml(String(error.message || error)) +
          '<div class="xs muted" style="margin-top:6px">Consejo: abre facebook.com/groups/joins en una pestaña normal, haz un poco de scroll y vuelve a pulsar Cargar. También puedes añadir grupos con <b>Añadir por URL</b> o <b>Importar lista de URLs</b>.</div>',
        "error"
      );
      toast("Falló la carga de grupos.", "error");
    } finally {
      busy(button, false);
    }
  };

  root.querySelector("#grLoad").addEventListener("click", (event) => loadGroups(event.currentTarget));

  root.querySelector("#grAdd").addEventListener("click", async () => {
    const url = await promptDialog("URL del grupo o id numérico", "", { placeholder: "https://www.facebook.com/groups/123456789/" });
    if (!url) return;
    try {
      const response = await must("groups:add", { url });
      toast('Añadido "' + (response.group ? response.group.name : "grupo") + '".', "ok");
      await readGroups().then((groups) => {
        state.groups = groups;
        renderTable();
      });
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  });

  root.querySelector("#grImportUrls").addEventListener("click", async () => {
    const raw = await textareaDialog("Importar lista plana de URLs", {
      hint: "Pega una URL de grupo o un ID numérico por línea. Se normalizan y añaden al instante sin saturar Facebook; el ID numérico se resolverá automáticamente al publicar si hace falta.",
      placeholder: "https://www.facebook.com/groups/123456789012345/\nhttps://www.facebook.com/groups/mi.grupo.favorito/\n987654321098765",
      confirmLabel: "Importar grupos"
    });
    if (!raw) return;

    const lines = raw
      .split(/[\r\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    const existingMap = new Map((state.groups || []).map((g) => [g.id, g]));
    let added = 0;
    let skippedExisting = 0;
    let invalid = 0;
    const seenInBatch = new Set();

    for (const line of lines) {
      const parsed = extractGroupFromInput(line);
      if (!parsed) {
        invalid += 1;
        continue;
      }
      if (seenInBatch.has(parsed.id)) continue;
      seenInBatch.add(parsed.id);
      if (existingMap.has(parsed.id)) {
        skippedExisting += 1;
      } else {
        existingMap.set(parsed.id, parsed);
        added += 1;
      }
    }

    if (!added && !skippedExisting) {
      toast("No se reconoció ninguna URL o ID de grupo válido.", "error");
      return;
    }

    const merged = Array.from(existingMap.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    await saveGroups(merged);
    state.groups = merged;
    renderTable();
    showNotice(
      "Importación completada: <strong>" + added + "</strong> nuevo(s), " +
        skippedExisting + " ya estaban en tu lista" +
        (invalid ? ", " + invalid + " línea(s) no válidas omitidas" : "") + "."
    );
    toast(added ? "Importados " + added + " grupo(s)." : "Todos los grupos ya estaban guardados.", "ok");
  });

  searchInput.addEventListener("input", renderTable);
  filterSelect.addEventListener("change", renderTable);

  tableHost.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-pick]");
    if (!box) return;
    if (box.checked) selected.add(box.dataset.pick);
    else selected.delete(box.dataset.pick);
  });

  tableHost.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.act === "history") {
      const group = state.groups.find((item) => item.id === id);
      if (group) await openGroupHistory(group);
      return;
    }
    if (button.dataset.act === "remove") {
      const group = state.groups.find((item) => item.id === id);
      if (!(await confirmDialog('¿Quitar "' + (group ? group.name : id) + '" de tu lista local? En Facebook sigue estando.', { title: "Quitar grupo", confirmLabel: "Quitar" }))) return;
      const next = state.groups.filter((item) => item.id !== id);
      await saveGroups(next);
      selected.delete(id);
      toast("Grupo quitado.", "ok");
    }
    if (button.dataset.act === "visit") {
      const next = state.groups.map((group) => (group.id === id ? { ...group, lastVisited: Date.now() } : group));
      await saveGroups(next);
      toast("Marcado como visitado.", "ok");
    }
  });

  listsHost.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-list-act]");
    if (!button) return;
    const list = (state.lists || []).find((item) => item.id === button.dataset.id);
    if (!list) return;

    if (button.dataset.listAct === "delete") {
      if (!(await confirmDialog('¿Borrar la lista "' + list.name + '"? Los grupos no se eliminan.', { title: "Borrar lista", confirmLabel: "Borrar" }))) return;
      await saveLists((state.lists || []).filter((item) => item.id !== list.id));
      toast("Lista borrada.", "ok");
    }
    if (button.dataset.listAct === "rename") {
      const name = await promptDialog("Nuevo nombre de la lista", list.name);
      if (!name) return;
      const next = (state.lists || []).map((item) => (item.id === list.id ? { ...item, name } : item));
      await saveLists(next);
      toast("Lista renombrada.", "ok");
    }
  });

  root.querySelector("#grSaveList").addEventListener("click", async () => {
    if (!selected.size) {
      toast("Marca al menos un grupo primero.", "error");
      return;
    }
    const name = await promptDialog("Ponle nombre a la lista", "Grupos " + new Date().toLocaleDateString());
    if (!name) return;
    const list = { id: uid("lst"), name, groupIds: Array.from(selected), createdAt: Date.now() };
    await saveLists([...(state.lists || []), list]);
    selected.clear();
    syncSelection();
    toast("Lista guardada.", "ok");
  });

  renderTable();
  renderLists();

  const unsub = subscribe((changes) => {
    if (changes.groups || changes.groupStats || changes.log || changes.all) {
      Array.from(selected).forEach((id) => {
        if (!state.groups.some((group) => group.id === id)) selected.delete(id);
      });
      renderTable();
    }
    if (changes.lists || changes.all) renderLists();
  });

  readGroups().then((groups) => {
    if (groups.length !== state.groups.length) renderTable();
  });

  return unsub;
}
