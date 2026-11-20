import { state, subscribe } from "../state.js";
import { saveGroups, saveLists, readGroups } from "../../shared/store.js";
import { must } from "../api.js";
import { escapeHtml, fmtDateTime, toast, confirmDialog, promptDialog, busy } from "../ui.js";
import { uid } from "../../shared/util.js";

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

export async function mount(root) {
  root.innerHTML =
    '<div class="row row--spread">' +
    '<div class="row"><button class="btn btn--primary" id="grLoad" type="button">Cargar mis grupos</button>' +
    '<button class="btn" id="grAdd" type="button">Añadir por URL</button></div>' +
    '<span class="muted small" id="grCount"></span>' +
    "</div>" +
    '<div id="grNotice"></div>' +
    '<section class="card"><div class="card__head"><div class="card__title">Grupos</div>' +
    '<div class="row"><input class="input input--sm" id="grSearch" placeholder="Buscar grupos…" style="width:220px" autocomplete="off"></div></div>' +
    '<div class="tablewrap" id="grTable"></div></section>' +
    '<section class="card"><div class="card__head"><div class="card__title">Listas guardadas</div>' +
    '<button class="btn btn--sm" id="grSaveList" type="button">Guardar selección como lista</button></div>' +
    '<div class="card__body" id="grLists"></div></section>';

  const tableHost = root.querySelector("#grTable");
  const listsHost = root.querySelector("#grLists");
  const countHost = root.querySelector("#grCount");
  const noticeHost = root.querySelector("#grNotice");
  const searchInput = root.querySelector("#grSearch");
  const selected = new Set();

  const renderTable = () => {
    const query = (searchInput.value || "").toLowerCase().trim();
    const groups = (state.groups || []).filter((group) => !query || group.name.toLowerCase().includes(query));
    countHost.textContent = state.groups.length + " grupo(s)";

    if (!groups.length) {
      tableHost.innerHTML = state.groups.length
        ? '<div class="empty">Ningún grupo coincide con la búsqueda.</div>'
        : '<div class="empty">Todavía no hay grupos.<br>Pulsa <strong>Cargar mis grupos</strong>. Si Facebook lo bloquea, abre facebook.com/groups/joins en una pestaña una vez y reinténtalo, o usa <strong>Añadir por URL</strong>.</div>';
      return;
    }

    tableHost.innerHTML =
      '<table class="table"><thead><tr><th style="width:36px"></th><th>Grupo</th><th>Miembros</th><th>Última visita</th><th style="width:1%"></th></tr></thead><tbody>' +
      groups
        .map((group) => {
          const checked = selected.has(group.id) ? " checked" : "";
          const avatar = group.pic
            ? '<img class="avatar" src="' + escapeHtml(group.pic) + '" alt="" loading="lazy">'
            : '<span class="avatar">' + escapeHtml((group.name || "?").slice(0, 2).toUpperCase()) + "</span>";
          return (
            '<tr data-id="' + escapeHtml(group.id) + '">' +
            '<td><input type="checkbox" data-pick="' + escapeHtml(group.id) + '"' + checked + ' style="accent-color:var(--accent)"></td>' +
            "<td><div class=\"row\" style=\"flex-wrap:nowrap\">" + avatar + '<div><div class="strong">' + escapeHtml(group.name) + "</div>" +
            '<div class="xs muted">' + escapeHtml(group.id) + "</div></div></div></td>" +
            "<td>" + escapeHtml(group.members || "—") + "</td>" +
            '<td class="muted xs">' + (group.lastVisited ? escapeHtml(fmtDateTime(group.lastVisited)) : "—") + "</td>" +
            '<td><div class="row" style="flex-wrap:nowrap">' +
            '<a class="btn btn--sm btn--ghost" href="' + escapeHtml(group.url) + '" target="_blank" rel="noopener">Abrir</a>' +
            '<button class="btn btn--sm btn--ghost" data-act="visit" data-id="' + escapeHtml(group.id) + '">Marcar visitado</button>' +
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
      /* Re-render from storage so the table reflects the saved list even if
         the storage change event has not propagated yet. */
      await readGroups().then((groups) => {
        state.groups = groups;
        renderTable();
      });
    } catch (error) {
      showNotice(
        "<strong>No se pudieron cargar los grupos.</strong> " + escapeHtml(String(error.message || error)) +
          '<div class="xs muted" style="margin-top:6px">Consejo: abre facebook.com/groups/joins en una pestaña normal, haz un poco de scroll y vuelve a pulsar Cargar. También puedes añadir grupos uno a uno con <b>Añadir por URL</b>.</div>',
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

  searchInput.addEventListener("input", renderTable);

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
    if (changes.groups || changes.all) {
      Array.from(selected).forEach((id) => {
        if (!state.groups.some((group) => group.id === id)) selected.delete(id);
      });
      renderTable();
    }
    if (changes.lists || changes.all) renderLists();
  });

  // Refresh from storage in case another tab changed the list while this view was open.
  readGroups().then((groups) => {
    if (groups.length !== state.groups.length) renderTable();
  });

  return unsub;
}
