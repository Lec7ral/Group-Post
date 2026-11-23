import { state, subscribe } from "../state.js";
import { saveCampaigns, buildGroupMetrics } from "../../shared/store.js";
import { api } from "../api.js";
import { launchCampaign } from "../launch.js";
import { escapeHtml, fmtDuration, fmtDelay, toast, confirmDialog } from "../ui.js";
import { uid, clamp } from "../../shared/util.js";
import { renderTemplate, countVariations, hasSpintax } from "../../shared/spintax.js";

const SAFETY_PRESETS = {
  maximum: { key: "maximum", label: "Máxima", min: 90, max: 210, every: 6, pauseMin: 12 },
  balanced: { key: "balanced", label: "Balanceada", min: 45, max: 100, every: 10, pauseMin: 8 },
  turbo: { key: "turbo", label: "Turbo", min: 25, max: 50, every: 15, pauseMin: 5 }
};

const VARIABLES = [
  ["{group_name}", "Nombre del grupo"],
  ["{group_id}", "ID del grupo"],
  ["{group_url}", "URL del grupo"],
  ["{today}", "Fecha de hoy"],
  ["{time}", "Hora actual"]
];

const blankDraft = (settings) => ({
  id: "",
  name: "",
  message: "",
  variations: [],
  groupIds: [],
  imageUrl: "",
  images: [],
  minDelaySec: settings.minDelaySec || 120,
  maxDelaySec: settings.maxDelaySec || 300,
  safetyEvery: settings.safetyEvery || 0,
  safetySec: settings.safetySec || 300,
  scheduledAt: 0,
  createdAt: 0,
  updatedAt: 0
});

const toLocalDatetimeInput = (ts) => {
  if (!ts || !Number.isFinite(Number(ts))) return "";
  const d = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
};

const readNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export async function mount(root, param) {
  const existing = param && param !== "new" ? state.campaigns.find((item) => item.id === param) : null;
  if (param && param !== "new" && !existing) {
    root.innerHTML = '<section class="card"><div class="empty">Esa campaña ya no existe. <a href="#/campaigns">Volver a Campañas</a></div></section>';
    return null;
  }

  const draft = existing ? JSON.parse(JSON.stringify(existing)) : blankDraft(state.settings);
  draft.variations = Array.isArray(draft.variations) ? draft.variations : [];
  const selected = new Set(draft.groupIds || []);

  root.innerHTML =
    '<div class="split">' +
    '<div class="col">' +
    // ---- basics
    '<section class="card"><div class="card__head"><div class="card__title">Campaña</div><button class="btn btn--sm btn--ghost" type="button" id="edBack">← Campañas</button></div>' +
    '<div class="card__body col">' +
    '<div class="field"><label class="label" for="edName">Nombre</label><input class="input" id="edName" placeholder="p. ej. Oferta de lunes" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="edMessage">Mensaje</label><textarea class="textarea" id="edMessage" placeholder="Escribe el post que quieres publicar en cada grupo…"></textarea>' +
    '<div class="hint">Se respetan los saltos de línea. Los enlaces se publican como texto normal.</div>' +
    '<div class="field"><label class="label" for="edImage">Imagen (URL o archivo, opcional)</label><input class="input" id="edImage" placeholder="https://…/foto.jpg" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="edImageFile">…o adjuntar archivos locales (se permite más de una foto)</label>' +
    '<div class="row"><input class="input" id="edImageFile" type="file" accept="image/*" multiple style="flex:1">' +
    '<button class="btn btn--sm btn--ghost" type="button" id="edClearImage" hidden>Quitar foto(s)</button></div>' +
    '<div class="hint" id="edImageInfo"></div></div>' +
    '<div class="row" id="edVars"></div>' +
    '<div class="inset small" id="edSpinInfo">Spintax: escribe <span class="mono">{Hola|Buenas|Qué tal}</span> y cada grupo recibe una variante distinta. Se puede anidar: <span class="mono">{Hola|{Buenas|Qué tal}}</span>. <strong id="edSpinCount">1 variante</strong></div>' +
    "</div></div>" +
    // ---- variations
    '<section class="card"><div class="card__head"><div class="card__title">Variaciones enteras (opcional)</div><button class="btn btn--sm" type="button" id="edAddVariation">Añadir variación</button></div>' +
    '<div class="card__body"><p class="hint" style="margin-top:0">Si añades variaciones, rotan entre grupos como posts completos distintos. Si lo dejas vacío se usa el mensaje de arriba (con su spintax).</p><div class="col" id="edVariations"></div></div></section>' +
    // ---- audience
    '<section class="card"><div class="card__head"><div class="card__title">Audiencia</div><span class="badge badge--info" id="edGroupCount">0 seleccionados</span></div>' +
    '<div class="card__body col">' +
    '<div class="row"><input class="input input--sm" id="edGroupSearch" placeholder="Buscar grupos…" style="flex:1;min-width:180px" autocomplete="off">' +
    '<select class="select input--sm" id="edListSelect" style="width:auto"><option value="">Cargar una lista…</option></select>' +
    '<button class="btn btn--sm btn--ghost" type="button" id="edSelectAll">Todos</button>' +
    '<button class="btn btn--sm btn--ghost" type="button" id="edSelectNone">Ninguno</button></div>' +
    '<div class="group-picker" id="edGroupPicker"></div>' +
    '<div class="hint" id="edGroupHint"></div>' +
    "</div></section>" +
    // ---- timing
    '<section class="card"><div class="card__head"><div class="card__title">Ritmo y seguridad</div><span class="badge" id="edPresetBadge">Personalizado</span></div><div class="card__body col">' +
    '<div class="row" id="edPresets"></div>' +
    '<div class="row">' +
    '<div class="field" style="flex:1"><label class="label" for="edMin">Retardo mínimo (segundos)</label><input class="input" id="edMin" type="number" min="1" step="1"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="edMax">Retardo máximo (segundos)</label><input class="input" id="edMax" type="number" min="1" step="1"></div>' +
    "</div>" +
    '<div class="row" style="margin-top:6px">' +
    '<div class="field" style="flex:1"><label class="label" for="edSafetyEvery">Descanso cada N posts</label><input class="input" id="edSafetyEvery" type="number" min="0" step="1"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="edSafetySec">Duración del descanso (segundos)</label><input class="input" id="edSafetySec" type="number" min="0" step="1"></div>' +
    "</div>" +
    '<div class="hint">El primer post sale enseguida; la espera solo se aplica entre posts. Un descanso cada N = 0 lo desactiva. El límite diario se configura en Ajustes.</div>' +
    "</div></section>" +
    // ---- schedule
    '<section class="card"><div class="card__head"><div class="card__title">Programación (opcional)</div><span class="badge" id="edSchedBadge">Manual</span></div><div class="card__body col">' +
    '<div class="row" style="align-items:flex-end">' +
    '<div class="field" style="flex:1;min-width:220px"><label class="label" for="edSchedule">Fecha y hora de lanzamiento</label><input class="input" id="edSchedule" type="datetime-local"></div>' +
    '<button class="btn btn--sm btn--ghost" type="button" id="edClearSchedule">Quitar programación</button>' +
    "</div>" +
    '<div class="hint">Usa las alarmas de Chrome en la extensión. El navegador debe estar abierto a la hora elegida; si está cerrado, se lanzará al abrirlo.</div>' +
    "</div></section>" +
    // ---- test
    '<section class="card"><div class="card__head"><div class="card__title">Post de prueba</div></div><div class="card__body col">' +
    '<p class="hint" style="margin:0">Publica el mensaje (con una variante de spintax ya resuelta) en el primer grupo seleccionado, ahora mismo. Es una publicación real y pública.</p>' +
    '<div class="row"><button class="btn btn--sm" type="button" id="edTest">Enviar prueba al primer grupo seleccionado</button></div>' +
    '<div id="edTestResult"></div>' +
    "</div></section>" +
    '<div class="row"><button class="btn" type="button" id="edSave">Guardar campaña</button><button class="btn btn--primary" type="button" id="edLaunch">Guardar y lanzar</button><a class="btn btn--ghost" href="#/campaigns">Cancelar</a></div>' +
    "</div>" +
    // ---- preview rail
    '<aside class="preview"><div class="preview__head">Vista previa <button class="btn btn--sm btn--ghost" type="button" id="edPreviewSample">Otra variante</button></div><div class="preview__body" id="edPreview"></div><div class="preview__meta" id="edPreviewMeta"></div></aside>' +
    "</div>";

  const $ = (selector) => root.querySelector(selector);
  const nameInput = $("#edName");
  const messageInput = $("#edMessage");
  const minInput = $("#edMin");
  const maxInput = $("#edMax");
  const safetyEvery = $("#edSafetyEvery");
  const safetySec = $("#edSafetySec");
  const groupPicker = $("#edGroupPicker");
  const groupCount = $("#edGroupCount");
  const variationsHost = $("#edVariations");
  const searchInput = $("#edGroupSearch");
  const listSelect = $("#edListSelect");
  const testResult = $("#edTestResult");
  const imageInput = $("#edImage");
  const imageFile = $("#edImageFile");
  const clearImageBtn = $("#edClearImage");
  const imageInfo = $("#edImageInfo");
  const scheduleInput = $("#edSchedule");

  const syncImageUi = () => {
    const imgs = Array.isArray(draft.images) ? draft.images.filter(Boolean) : [];
    const localCount = imgs.filter((v) => String(v).startsWith("data:")).length;
    if (localCount > 0) {
      imageInfo.textContent = localCount + " imagen(es) local(es) adjunta(s).";
    } else if (draft.imageUrl) {
      imageInfo.textContent = "Usando imagen desde URL.";
    } else {
      imageInfo.textContent = "";
    }
    clearImageBtn.hidden = !(imgs.length || draft.imageUrl);
  };

  nameInput.value = draft.name || "";
  messageInput.value = draft.message || "";
  imageInput.value = draft.imageUrl && !String(draft.imageUrl).startsWith("data:") ? draft.imageUrl : "";
  if (imageFile) imageFile.value = "";
  syncImageUi();
  minInput.value = draft.minDelaySec;
  maxInput.value = draft.maxDelaySec;
  safetyEvery.value = draft.safetyEvery;
  safetySec.value = draft.safetySec;
  scheduleInput.value = draft.scheduledAt > 0 ? toLocalDatetimeInput(draft.scheduledAt) : "";

  const updateScheduleBadge = () => {
    const badge = $("#edSchedBadge");
    if (!badge) return;
    if (draft.scheduledAt > Date.now()) {
      badge.textContent = "Programada";
      badge.className = "badge badge--info";
    } else if (draft.scheduledAt > 0) {
      badge.textContent = "Fecha pasada";
      badge.className = "badge badge--pending";
    } else {
      badge.textContent = "Manual";
      badge.className = "badge";
    }
  };
  updateScheduleBadge();

  const groupsById = new Map(state.groups.map((group) => [group.id, group]));

  const sampleGroup = () => {
    const first = Array.from(selected)[0];
    return (
      groupsById.get(first) || {
        id: "123456789",
        name: "Mi grupo de ejemplo",
        url: "https://www.facebook.com/groups/123456789/"
      }
    );
  };

  const baseText = () => {
    const main = String(draft.message || "").trim();
    if (main) return main;
    return String(draft.variations.find((item) => String(item || "").trim()) || "").trim();
  };

  const updatePreview = () => {
    const source = baseText();
    if (!source) {
      $("#edPreview").textContent = "Tu post aparecerá aquí mientras escribes.";
    } else {
      const group = sampleGroup();
      const rendered = renderTemplate(source, {
        group_name: group.name,
        group_id: group.id,
        group_url: group.url
      });
      $("#edPreview").textContent = rendered || "…";
    }

    const variants = countVariations(source);
    $("#edSpinCount").textContent = variants > 1 ? variants.toLocaleString("es-ES") + " variantes" : "1 variante";
    $("#edSpinInfo").style.borderColor = hasSpintax(source) ? "var(--accent)" : "var(--line2)";

    const count = selected.size;
    const min = Number(draft.minDelaySec) || 0;
    const max = Number(draft.maxDelaySec) || 0;
    const avg = (min + max) / 2;
    const estimate = count > 1 ? Math.round(avg) * (count - 1) * 1000 : 0;
    const breaks = draft.safetyEvery > 0 ? Math.floor(count / draft.safetyEvery) : 0;
    $("#edPreviewMeta").innerHTML =
      "<div>" + count + " grupo(s) · retardo " + fmtDelay(min, max) + "</div>" +
      "<div>Duración estimada: " + (count > 1 ? fmtDuration(estimate) : "inmediata") + (breaks ? " + " + breaks + " descanso(s)" : "") + "</div>" +
      (state.settings.dailyLimit > 0 ? "<div>Límite diario: " + state.settings.dailyLimit + " posts</div>" : "");
    groupCount.textContent = count + " seleccionados";
    groupCount.className = "badge " + (count ? "badge--info" : "badge--failed");
  };

  const markPreset = (key) => {
    const preset = SAFETY_PRESETS[key];
    $("#edPresetBadge").textContent = preset ? preset.label : "Personalizado";
    $("#edPresetBadge").className = "badge " + (preset ? "badge--info" : "");
    root.querySelectorAll("[data-preset]").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.preset === key);
    });
  };

  const renderVariables = () => {
    $("#edVars").innerHTML =
      '<span class="hint" style="margin-right:4px">Insertar:</span>' +
      VARIABLES.map(
        ([token, label]) =>
          '<button class="chip chip--sm" type="button" data-var="' + escapeHtml(token) + '" title="' + escapeHtml(label) + '">' + escapeHtml(token) + "</button>"
      ).join("");
  };

  const insertAtCursor = (token) => {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? messageInput.value.length;
    messageInput.value = messageInput.value.slice(0, start) + token + messageInput.value.slice(end);
    messageInput.focus();
    const pos = start + token.length;
    messageInput.setSelectionRange(pos, pos);
    draft.message = messageInput.value;
    updatePreview();
  };

  const renderVariations = () => {
    variationsHost.innerHTML = draft.variations.length
      ? draft.variations
          .map(
            (value, index) =>
              '<div class="row" style="align-items:flex-start;flex-wrap:nowrap">' +
              '<div class="field" style="flex:1"><label class="label">Variación ' + (index + 1) + '</label>' +
              '<textarea class="textarea" data-variation="' + index + '" style="min-height:90px" placeholder="Otra redacción…"></textarea></div>' +
              '<button class="btn btn--sm btn--danger" type="button" data-remove-variation="' + index + '" style="margin-top:22px">Quitar</button>' +
              "</div>"
          )
          .join("")
      : '<div class="hint">Sin variaciones. Se usa el mensaje principal en todos los grupos.</div>';

    variationsHost.querySelectorAll("textarea[data-variation]").forEach((area) => {
      area.value = draft.variations[Number(area.dataset.variation)] || "";
      area.addEventListener("input", () => {
        draft.variations[Number(area.dataset.variation)] = area.value;
        updatePreview();
      });
    });
    variationsHost.querySelectorAll("[data-remove-variation]").forEach((button) => {
      button.addEventListener("click", () => {
        draft.variations.splice(Number(button.dataset.removeVariation), 1);
        renderVariations();
        updatePreview();
      });
    });
  };

  const renderPicker = () => {
    const query = (searchInput.value || "").toLowerCase().trim();
    const metrics = buildGroupMetrics(state.groupStats, state.log);
    const rows = state.groups
      .filter((group) => !query || group.name.toLowerCase().includes(query) || group.id.toLowerCase().includes(query))
      .map((group) => {
        const checked = selected.has(group.id) ? " checked" : "";
        const m = metrics[group.id];
        const needsApproval = Boolean(group.requiresApproval || (m && (m.requiresApproval || m.pending > 0)));
        const avatar = group.pic
          ? '<img class="avatar" src="' + escapeHtml(group.pic) + '" alt="" loading="lazy">'
          : '<span class="avatar">' + escapeHtml((group.name || "?").slice(0, 2).toUpperCase()) + "</span>";
        return (
          '<div class="group-picker__row" data-row="' + escapeHtml(group.id) + '">' +
          '<label>' +
          '<input type="checkbox" data-group="' + escapeHtml(group.id) + '"' + checked + ">" +
          avatar +
          '<span><span class="strong">' + escapeHtml(group.name) + "</span>" +
          (group.members ? '<span class="xs muted"> · ' + escapeHtml(group.members) + "</span>" : "") +
          (needsApproval ? ' <span class="badge badge--pending">Aprobación</span>' : "") +
          "</span></label></div>"
        );
      });
    groupPicker.innerHTML = rows.length
      ? rows.join("")
      : '<div class="empty" style="padding:22px">' +
        (state.groups.length
          ? "Ningún grupo coincide con la búsqueda."
          : 'Tu lista de grupos está vacía. <a href="#/groups">Carga tus grupos</a> primero y vuelve aquí.') +
        "</div>";
    $("#edGroupHint").textContent = state.groups.length + " grupo(s) en tu lista local.";
  };

  // ---- events
  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
  });
  messageInput.addEventListener("input", () => {
    draft.message = messageInput.value;
    updatePreview();
  });
  imageInput.addEventListener("input", () => {
    const url = imageInput.value.trim();
    draft.imageUrl = url;
    draft.images = url ? [url] : [];
    if (imageFile) imageFile.value = "";
    syncImageUi();
  });
  imageFile.addEventListener("change", async () => {
    const files = Array.from(imageFile.files || []);
    if (!files.length) {
      const url = imageInput.value.trim();
      draft.imageUrl = url;
      draft.images = url ? [url] : [];
      syncImageUi();
      return;
    }
    const readFile = (file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
    draft.images = (await Promise.all(files.map(readFile))).filter(Boolean);
    draft.imageUrl = draft.images[0] || "";
    imageInput.value = "";
    syncImageUi();
    updatePreview();
  });
  clearImageBtn.addEventListener("click", () => {
    draft.imageUrl = "";
    draft.images = [];
    imageInput.value = "";
    if (imageFile) imageFile.value = "";
    syncImageUi();
    updatePreview();
  });
  minInput.addEventListener("input", () => {
    draft.minDelaySec = Math.max(1, readNumber(minInput.value, 60));
    markPreset("custom");
    updatePreview();
  });
  maxInput.addEventListener("input", () => {
    draft.maxDelaySec = Math.max(1, readNumber(maxInput.value, draft.minDelaySec));
    markPreset("custom");
    updatePreview();
  });
  safetyEvery.addEventListener("input", () => {
    draft.safetyEvery = Math.max(0, readNumber(safetyEvery.value, 0));
    markPreset("custom");
    updatePreview();
  });
  safetySec.addEventListener("input", () => {
    draft.safetySec = Math.max(0, readNumber(safetySec.value, 0));
  });
  scheduleInput.addEventListener("change", () => {
    const val = scheduleInput.value;
    draft.scheduledAt = val ? new Date(val).getTime() || 0 : 0;
    updateScheduleBadge();
  });
  $("#edClearSchedule").addEventListener("click", () => {
    scheduleInput.value = "";
    draft.scheduledAt = 0;
    updateScheduleBadge();
  });

  renderVariables();
  $("#edVars").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-var]");
    if (!chip) return;
    insertAtCursor(chip.dataset.var);
  });

  $("#edPreviewSample").addEventListener("click", updatePreview);

  $("#edPresets").innerHTML = Object.values(SAFETY_PRESETS)
    .map(
      (preset) =>
        '<button class="chip" type="button" data-preset="' + preset.key + '">' +
        preset.label + " · " + preset.min + "–" + preset.max + "s · " + preset.every + " posts/descanso</button>"
    )
    .join("");
  $("#edPresets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    const preset = SAFETY_PRESETS[button.dataset.preset];
    if (!preset) return;
    draft.minDelaySec = preset.min;
    draft.maxDelaySec = preset.max;
    draft.safetyEvery = preset.every;
    draft.safetySec = preset.pauseMin * 60;
    minInput.value = preset.min;
    maxInput.value = preset.max;
    safetyEvery.value = preset.every;
    safetySec.value = preset.pauseMin * 60;
    markPreset(preset.key);
    updatePreview();
  });

  $("#edAddVariation").addEventListener("click", () => {
    draft.variations.push("");
    renderVariations();
  });

  searchInput.addEventListener("input", renderPicker);

  groupPicker.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-group]");
    if (!box) return;
    if (box.checked) selected.add(box.dataset.group);
    else selected.delete(box.dataset.group);
    updatePreview();
  });

  $("#edSelectAll").addEventListener("click", () => {
    state.groups.forEach((group) => selected.add(group.id));
    renderPicker();
    updatePreview();
  });
  $("#edSelectNone").addEventListener("click", () => {
    selected.clear();
    renderPicker();
    updatePreview();
  });

  const renderListOptions = () =>
    '<option value="">Cargar una lista…</option>' +
    (state.lists || [])
      .map((list) => '<option value="' + escapeHtml(list.id) + '">' + escapeHtml(list.name) + " (" + (list.groupIds || []).length + ")</option>")
      .join("");

  listSelect.innerHTML = renderListOptions();
  listSelect.addEventListener("change", () => {
    const list = state.lists.find((item) => item.id === listSelect.value);
    if (!list) return;
    (list.groupIds || []).forEach((id) => {
      if (groupsById.has(id)) selected.add(id);
    });
    renderPicker();
    updatePreview();
    toast('Cargada "' + list.name + '".', "ok");
  });

  const persist = async ({ silent = false } = {}) => {
    draft.name = nameInput.value.trim() || "Campaña sin título";
    draft.message = messageInput.value;
    const urlVal = imageInput.value.trim();
    const localImages = Array.isArray(draft.images) ? draft.images.filter((v) => String(v).startsWith("data:")) : [];
    if (localImages.length) {
      draft.images = localImages;
      draft.imageUrl = localImages[0];
    } else {
      draft.imageUrl = urlVal;
      draft.images = urlVal ? [urlVal] : [];
    }
    draft.groupIds = Array.from(selected);
    draft.minDelaySec = clamp(Number(draft.minDelaySec) || 60, 1, 24 * 3600);
    draft.maxDelaySec = clamp(Math.max(Number(draft.maxDelaySec) || draft.minDelaySec, draft.minDelaySec), draft.minDelaySec, 48 * 3600);
    draft.safetyEvery = Math.max(0, Number(draft.safetyEvery) || 0);
    draft.safetySec = Math.max(0, Number(draft.safetySec) || 0);
    const rawSched = scheduleInput.value ? new Date(scheduleInput.value).getTime() : 0;
    if (scheduleInput.value && (!Number.isFinite(rawSched) || rawSched <= Date.now())) {
      throw new Error("La fecha programada debe ser en el futuro.");
    }
    draft.scheduledAt = Number.isFinite(rawSched) && rawSched > Date.now() ? rawSched : 0;

    if (!draft.message.trim() && !draft.variations.some((item) => String(item || "").trim())) {
      throw new Error("Escribe un mensaje antes de guardar.");
    }
    if (!selected.size) {
      throw new Error("Selecciona al menos un grupo.");
    }

    if (!draft.id) {
      draft.id = uid("cmp");
      draft.createdAt = Date.now();
    }
    draft.updatedAt = Date.now();

    const others = state.campaigns.filter((item) => item.id !== draft.id);
    await saveCampaigns([...others, draft]);
    if (location.hash !== "#/editor/" + draft.id) {
      history.replaceState(null, "", "#/editor/" + draft.id);
    }
    if (!silent) {
      toast(
        draft.scheduledAt
          ? "Campaña guardada y programada."
          : "Campaña guardada.",
        "ok"
      );
    }
    updateScheduleBadge();
    return draft;
  };

  $("#edSave").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      await persist();
    } catch (error) {
      toast(String(error.message || error), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#edLaunch").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      const saved = await persist({ silent: true });
      await launchCampaign(saved);
    } catch (error) {
      toast(String(error.message || error), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#edTest").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const groupId = Array.from(selected)[0];
    if (!groupId) {
      toast("Selecciona al menos un grupo primero.", "error");
      return;
    }
    const source = baseText();
    if (!source) {
      toast("Escribe un mensaje primero.", "error");
      return;
    }
    const group = groupsById.get(groupId) || { id: groupId, name: groupId, url: "" };
    const message = renderTemplate(source, { group_name: group.name, group_id: group.id, group_url: group.url }).trim();
    const ok = await confirmDialog(
      '¿Publicar este mensaje en "' + (group.name || groupId) + '" ahora? Será público.',
      { title: "Enviar post de prueba", confirmLabel: "Publicar" }
    );
    if (!ok) return;

    try {
      button.disabled = true;
      testResult.innerHTML = '<div class="inset">Publicando…</div>';
      const response = await api("test:post", { groupId, message, imageUrl: draft.imageUrl || "", images: draft.images || [] });
      if (!response || response.ok === false) throw new Error((response && response.error) || "La prueba falló.");
      const result = response.result || {};
      testResult.innerHTML = result.ok
        ? '<div class="inset" style="border-color:var(--ok)">Publicado vía ' +
          escapeHtml(result.via || "?") +
          (result.pending ? " (pendiente de aprobación del admin)" : "") +
          (result.imageAttached ? " · con foto" : "") +
          (result.postUrl ? ' · <a href="' + escapeHtml(result.postUrl) + '" target="_blank" rel="noopener">abrir post</a>' : "") +
          (Array.isArray(result.debug)
            ? '<div class="xs muted mono" style="margin-top:6px;white-space:pre-wrap">' + escapeHtml(result.debug.join("\n")) + "</div>"
            : "") +
          '<div class="xs muted" style="margin-top:6px;white-space:pre-wrap">' + escapeHtml(message.slice(0, 400)) + "</div></div>"
        : '<div class="inset" style="border-color:var(--bad)"><strong>Falló:</strong> ' +
          escapeHtml(result.error || "Error desconocido") +
          '<div class="xs muted mono" style="margin-top:6px;white-space:pre-wrap">' +
          (Array.isArray(result.debug) && result.debug.length
            ? escapeHtml(result.debug.join("\n"))
            : escapeHtml(String(result.raw || "").slice(0, 800))) + "</div></div>";
      if (result.ok) toast("Post de prueba publicado.", "ok");
      else toast("La prueba falló.", "error");
    } catch (error) {
      testResult.innerHTML = '<div class="inset" style="border-color:var(--bad)">' + escapeHtml(String(error.message || error)) + "</div>";
      toast(String(error.message || error), "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#edBack").addEventListener("click", () => {
    location.hash = "#/campaigns";
  });

  const unsub = subscribe((changes) => {
    if (changes.groups || changes.lists || changes.all) {
      renderPicker();
      listSelect.innerHTML = renderListOptions();
    }
  });

  markPreset(
    Object.values(SAFETY_PRESETS).find(
      (preset) =>
        preset.min === draft.minDelaySec &&
        preset.max === draft.maxDelaySec &&
        preset.every === draft.safetyEvery &&
        preset.pauseMin * 60 === draft.safetySec
    )?.key || "custom"
  );
  renderVariations();
  renderPicker();
  updatePreview();

  return () => unsub();
}
