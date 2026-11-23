import { state } from "../state.js";
import { api } from "../api.js";
import {
  saveSettings,
  saveGroups,
  saveGroupStats,
  saveLists,
  saveCampaigns,
  readDiagnostics,
  KEYS,
  remove
} from "../../shared/store.js";
import { testAi } from "../../shared/ai.js";
import { escapeHtml, download, pickFile, toast, confirmDialog, fmtDateTime, busy } from "../ui.js";

const TRANSPORTS = [
  ["auto", "Automático (navegador real + API de respaldo)"],
  ["ui", "Solo navegador real (UI de Facebook)"],
  ["ajax", "Solo API clásica (sin ventana)"],
  ["graphql", "Solo GraphQL (necesita doc_id)"]
];

const WINDOW_MODES = [
  ["hidden", "Ventana pequeña sin foco (no molesta)"],
  ["visible", "Ventana visible (para supervisar)"]
];

const PRESETS = {
  maximum: { label: "Máxima", min: 90, max: 210, every: 6, pauseMin: 12, daily: 25 },
  balanced: { label: "Balanceada", min: 45, max: 100, every: 10, pauseMin: 8, daily: 30 },
  turbo: { label: "Turbo", min: 25, max: 50, every: 15, pauseMin: 5, daily: 50 }
};

const sanitizeSettings = (raw) => ({
  theme: ["light", "dark", "system"].includes(raw.theme) ? raw.theme : "system",
  minDelaySec: Math.max(1, Number(raw.minDelaySec) || 120),
  maxDelaySec: Math.max(1, Number(raw.maxDelaySec) || 300),
  safetyEvery: Math.max(0, Number(raw.safetyEvery) || 0),
  safetySec: Math.max(0, Number(raw.safetySec) || 0),
  retryOnce: raw.retryOnce !== false,
  maxLogEntries: Math.max(100, Number(raw.maxLogEntries) || 5000),
  transport: ["auto", "ui", "ajax", "graphql"].includes(raw.transport) ? raw.transport : "auto",
  workTarget: raw.workTarget === "newtab" ? "newtab" : "tab",
  dailyLimit: Math.max(0, Number(raw.dailyLimit) || 0),
  safetyPreset: ["maximum", "balanced", "turbo", "custom"].includes(raw.safetyPreset) ? raw.safetyPreset : "balanced",
  scrollPresence: raw.scrollPresence !== false,
  shareButton: raw.shareButton !== false,
  shuffleGroups: raw.shuffleGroups === true,
  focusWorker: raw.focusWorker === true,
  debugLogs: raw.debugLogs === true,
  aiEnabled: raw.aiEnabled === true,
  aiProvider: ["worker", "custom", "off"].includes(raw.aiProvider) ? raw.aiProvider : "worker",
  aiWorkerUrl: String(raw.aiWorkerUrl || "https://fb-smart-poster.0amaal89.workers.dev").trim(),
  aiTone: ["engaging", "enthusiastic", "professional", "casual"].includes(raw.aiTone) ? raw.aiTone : "engaging",
  aiStyle: ["moderate", "subtle", "creative"].includes(raw.aiStyle) ? raw.aiStyle : "moderate",
  aiLanguage: ["darija", "arabic", "french", "english", "auto"].includes(raw.aiLanguage) ? raw.aiLanguage : "auto",
  aiBaseUrl: String(raw.aiBaseUrl || "").slice(0, 300),
  aiApiKey: String(raw.aiApiKey || "").slice(0, 300),
  aiModel: String(raw.aiModel || "gpt-4o-mini").slice(0, 120),
  graphqlDocId: String(raw.graphqlDocId || "").slice(0, 40),
  graphqlFriendlyName: String(raw.graphqlFriendlyName || "CometGroupDiscussionComposerCreateMutation").slice(0, 120),
  graphqlTemplate: String(raw.graphqlTemplate || "")
});

const originOf = (value) => {
  try {
    return new URL(value).origin + "/*";
  } catch {
    return "";
  }
};

export async function mount(root) {
  root.innerHTML =
    /* ---------- session ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Sesión de Facebook</div><button class="btn btn--sm" id="setCheck" type="button">Comprobar sesión</button></div>' +
    '<div class="card__body col"><div id="setSession" class="inset">Sin comprobar. Group Poster usa la sesión de Facebook que ya tienes en este perfil de Chrome.</div>' +
    '<p class="hint" style="margin:0">No hace falta tener Facebook abierto: Group Poster trabaja sobre una pestaña de Facebook, sin abrir ventanas nuevas.</p></div></section>' +

    /* ---------- publishing ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Modo de publicación</div></div><div class="card__body col">' +
    '<div class="grid grid--2">' +
    '<div class="field"><label class="label" for="setTransport">Transporte</label><select class="select" id="setTransport">' +
    TRANSPORTS.map(([value, label]) => '<option value="' + value + '">' + escapeHtml(label) + "</option>").join("") +
    "</select></div>" +
    '<div class="field"><label class="label" for="setWorkTarget">Dónde automatizar</label><select class="select" id="setWorkTarget">' +
    '<option value="tab">Sobre la pestaña de Facebook abierta (recomendado)</option>' +
    '<option value="newtab">Crear una pestaña nueva de Facebook</option>' +
    "</select></div>" +
    "</div>" +
    '<div class="inset small">El <strong>navegador real</strong> escribe y pulsa Publicar en la página, igual que lo harías tú, y comprueba que el post se publicó. La <strong>API</strong> es silenciosa pero depende de endpoints internos que Facebook cambia. En automático se intenta el navegador y, si falla, la API.</div>' +
    '<div class="row"><button class="btn btn--sm" id="setShowWindow" type="button">Ver pestaña de Facebook</button>' +
    '<button class="btn btn--sm btn--ghost" id="setScanGroups" type="button">Sincronizar grupos con la pestaña</button>' +
    '<span class="hint">No se abre ninguna ventana: la automatización ocurre en la pestaña y la ponemos delante para que puedas verla o intervenir.</span></div>' +
    "</div></section>" +

    /* ---------- safety ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Ritmo y seguridad</div><span class="badge badge--info" id="setPresetBadge">Balanceada</span></div><div class="card__body col">' +
    '<div class="row" id="setPresets">' +
    Object.entries(PRESETS)
      .map(
        ([key, preset]) =>
          '<button class="chip" type="button" data-preset="' + key + '">' +
          escapeHtml(preset.label) +
          " · " + preset.min + "–" + preset.max + "s</button>"
      )
      .join("") +
    "</div>" +
    '<div class="row"><div class="field" style="flex:1"><label class="label" for="setMin">Retardo mínimo (segundos)</label><input class="input" id="setMin" type="number" min="1"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="setMax">Retardo máximo (segundos)</label><input class="input" id="setMax" type="number" min="1"></div></div>' +
    '<div class="row"><div class="field" style="flex:1"><label class="label" for="setEvery">Descanso cada N posts</label><input class="input" id="setEvery" type="number" min="0"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="setBreak">Duración del descanso (segundos)</label><input class="input" id="setBreak" type="number" min="0"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="setDaily">Límite diario (0 = sin límite)</label><input class="input" id="setDaily" type="number" min="0"></div></div>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setRetry" style="accent-color:var(--accent);width:15px;height:15px"> Reintentar una vez si falla, 8 segundos después</label>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setScroll" style="accent-color:var(--accent);width:15px;height:15px"> Simular presencia (scroll suave) antes de publicar</label>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setShareBtn" style="accent-color:var(--accent);width:15px;height:15px"> Mostrar el botón «Grupos» en el feed de Facebook</label>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setDebugLogs" style="accent-color:var(--accent);width:15px;height:15px"> Guardar trazas de depuración de cada post (diagnóstico)</label>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setFocusWorker" style="accent-color:var(--accent);width:15px;height:15px"> Enfocar la ventana de Facebook al publicar (por defecto, sin foco)</label>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setShuffleGroups" style="accent-color:var(--accent);width:15px;height:15px"> Barajar el orden de los grupos al lanzar cada campaña</label>' +
    '<p class="hint" style="margin:0">Los retardos se reparten alrededor del centro del rango (jitter gaussiano), no de forma uniforme. El límite diario cuenta los posts publicados hoy y pausa la campaña al alcanzarlo.</p>' +
    "</div></section>" +

    /* ---------- AI ---------- */
    '<details class="card"><summary class="card__head" style="cursor:pointer;list-style:none"><div class="card__title">IA opcional (reescritura de texto)</div><span class="badge" id="setAiBadge">Desactivada</span></summary>' +
    '<div class="card__body col">' +
    '<p class="hint" style="margin:0">IA opcional. Elige el <strong>proveedor</strong>: la <strong>IA del repositorio</strong> (worker externo, ya preconfigurado) o tu <strong>endpoint propio</strong> compatible con OpenAI. Si falla, el motor sigue con el texto original y el spintax local. Nunca bloquea una campaña.</p>' +
    '<label class="row" style="gap:8px"><input type="checkbox" id="setAiEnabled" style="accent-color:var(--accent);width:15px;height:15px"> Activar reescritura con IA</label>' +
    '<div class="field"><label class="label" for="setAiProvider">Proveedor de IA</label><select class="select" id="setAiProvider">' +
    '<option value="worker">IA del repositorio (worker externo, preconfigurado)</option>' +
    '<option value="custom">Endpoint propio compatible con OpenAI</option>' +
    '<option value="off">Desactivada</option>' +
    "</select></div>" +
    '<div id="aiFieldsWorker" class="col">' +
    '<div class="field"><label class="label" for="setAiWorker">Worker (endpoint del repositorio)</label><input class="input" id="setAiWorker" placeholder="https://fb-smart-poster.0amaal89.workers.dev" autocomplete="off"></div>' +
    '<div class="grid grid--2">' +
    '<div class="field"><label class="label" for="setAiLanguage">Idioma de salida</label><select class="select" id="setAiLanguage">' +
    '<option value="auto">Auto (conservar el idioma del texto)</option>' +
    '<option value="english">Inglés</option>' +
    '<option value="french">Francés</option>' +
    '<option value="arabic">Árabe (árabe estándar)</option>' +
    '<option value="darija">Darija (árabe marroquí)</option>' +
    "</select></div>" +
    '<div class="field"><label class="label" for="setAiTone">Tono</label><select class="select" id="setAiTone">' +
    '<option value="engaging">Engaging & conversacional</option>' +
    '<option value="enthusiastic">Entusiasta</option>' +
    '<option value="professional">Profesional</option>' +
    '<option value="casual">Casual</option>' +
    "</select></div>" +
    '<div class="field"><label class="label" for="setAiStyle">Intensidad de la variante</label><select class="select" id="setAiStyle">' +
    '<option value="moderate">Moderada (recomendada)</option>' +
    '<option value="subtle">Cambio sutil de redacción</option>' +
    '<option value="creative">Reescritura creativa</option>' +
    "</select></div>" +
    "</div>" +
    "</div>" +
    '<div id="aiFieldsCustom" class="col" style="display:none">' +
    '<div class="grid grid--2">' +
    '<div class="field"><label class="label" for="setAiBase">Endpoint base</label><input class="input" id="setAiBase" placeholder="https://api.openai.com/v1" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="setAiModel">Modelo</label><input class="input" id="setAiModel" placeholder="gpt-4o-mini" autocomplete="off"></div>' +
    "</div>" +
    '<div class="field"><label class="label" for="setAiKey">API key</label><input class="input" id="setAiKey" type="password" placeholder="sk-..." autocomplete="off"></div>' +
    "</div>" +
    '<div id="aiActionsRow" class="col">' +
    '<div class="row"><button class="btn btn--sm" id="setAiTest" type="button">Probar conexión</button><span class="hint" id="setAiStatus"></span></div>' +
    '<p class="hint" style="margin:0">Si el proveedor falla, el motor sigue con el texto original y el spintax local. Nunca bloquea una campaña.</p>' +
    "</div>" +
    "</div></details>" +

    /* ---------- graphql ---------- */
    '<details class="card"><summary class="card__head" style="cursor:pointer;list-style:none"><div class="card__title">GraphQL avanzado</div><span class="badge">Solo si usas el transporte GraphQL</span></summary>' +
    '<div class="card__body col">' +
    '<div class="grid grid--2">' +
    '<div class="field"><label class="label" for="setDoc">Operation id (doc_id)</label><input class="input" id="setDoc" placeholder="p. ej. 1234567890123456" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="setFriendly">Friendly name</label><input class="input" id="setFriendly" autocomplete="off"></div>' +
    "</div>" +
    '<div class="field"><label class="label" for="setTemplate">Plantilla de variables (opcional)</label><textarea class="textarea mono" id="setTemplate" style="min-height:110px" placeholder=\'{"input":{"message":{"text":"{{message}}"},"target_group_id":"{{groupId}}"}}\'></textarea>' +
    '<div class="hint">Marcadores: <span class="mono">{{groupId}}</span>, <span class="mono">{{message}}</span>, <span class="mono">{{userId}}</span>. Facebook rota los doc_id; si deja de funcionar, captura uno nuevo en DevTools → Network al publicar a mano.</div></div>' +
    "</div></details>" +

    /* ---------- test post ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Post de prueba</div></div><div class="card__body col">' +
    '<div class="grid grid--2"><div class="field"><label class="label" for="setTestGroup">Grupo</label><select class="select" id="setTestGroup"></select></div>' +
    '<div class="field"><label class="label" for="setTestMessage">Mensaje</label><input class="input" id="setTestMessage" value="Prueba desde Group Poster"></div></div>' +
    '<div class="field"><label class="label" for="setTestImage">Imagen (URL, opcional)</label><input class="input" id="setTestImage" placeholder="https://…/foto.jpg"></div>' +
    '<div class="field"><label class="label" for="setTestImageFile">…o adjuntar archivos locales (varios)</label><input class="input" id="setTestImageFile" type="file" accept="image/*" multiple></div>' +
    '<div class="row"><button class="btn btn--sm" id="setTestSend" type="button">Publicar post de prueba</button><span class="hint">Es una publicación real y pública. La foto requiere el transporte navegador real o automático.</span></div>' +
    '<div id="setTestResult"></div></div></section>' +

    /* ---------- appearance ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Apariencia</div></div><div class="card__body">' +
    '<div class="field" style="max-width:260px"><label class="label" for="setTheme">Tema</label><select class="select" id="setTheme"><option value="system">Sistema</option><option value="light">Claro</option><option value="dark">Oscuro</option></select></div>' +
    "</div></section>" +

    /* ---------- backup ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Copia de seguridad</div></div><div class="card__body col">' +
    '<p class="hint" style="margin:0">Exporta campañas, grupos, listas y preferencias. Tu sesión de Facebook nunca se incluye.</p>' +
    '<div class="row"><button class="btn btn--sm" id="setExport" type="button">Exportar copia</button><button class="btn btn--sm" id="setImport" type="button">Importar copia</button></div>' +
    "</div></section>" +

    /* ---------- diagnostics ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Diagnóstico</div><button class="btn btn--sm btn--ghost" id="setDiagRefresh" type="button">Actualizar</button></div><div class="card__body"><div id="setDiag" class="mono" style="max-height:300px;overflow:auto"></div></div></section>' +

    /* ---------- danger ---------- */
    '<section class="card"><div class="card__head"><div class="card__title">Zona peligrosa</div></div><div class="card__body row row--spread">' +
    '<div><div class="strong">Restablecer todo</div><div class="hint">Borra campañas, grupos, listas, ajustes y el registro de este navegador.</div></div>' +
    '<button class="btn btn--danger" id="setReset" type="button">Borrar todos los datos</button></div></section>';

  const $ = (selector) => root.querySelector(selector);

  const markPreset = (key) => {
    const preset = PRESETS[key];
    $("#setPresetBadge").textContent = preset ? preset.label : "Personalizado";
    root.querySelectorAll("[data-preset]").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.preset === key);
    });
  };

  const loadFields = () => {
    const settings = state.settings || {};
    $("#setMin").value = settings.minDelaySec ?? 120;
    $("#setMax").value = settings.maxDelaySec ?? 300;
    $("#setEvery").value = settings.safetyEvery ?? 0;
    $("#setBreak").value = settings.safetySec ?? 300;
    $("#setDaily").value = settings.dailyLimit ?? 30;
    $("#setRetry").checked = settings.retryOnce !== false;
    $("#setScroll").checked = settings.scrollPresence !== false;
    $("#setShareBtn").checked = settings.shareButton !== false;
    $("#setShuffleGroups").checked = settings.shuffleGroups === true;
    $("#setFocusWorker").checked = settings.focusWorker === true;
    $("#setDebugLogs").checked = settings.debugLogs === true;
    $("#setTransport").value = settings.transport || "auto";
    $("#setWorkTarget").value = settings.workTarget === "newtab" ? "newtab" : "tab";
    $("#setAiEnabled").checked = settings.aiEnabled === true;
    $("#setAiProvider").value = String(settings.aiProvider || "worker");
    $("#setAiWorker").value = settings.aiWorkerUrl || "";
    $("#setAiLanguage").value = String(settings.aiLanguage || "auto");
    $("#setAiTone").value = String(settings.aiTone || "engaging");
    $("#setAiStyle").value = String(settings.aiStyle || "moderate");
    $("#setAiBase").value = settings.aiBaseUrl || "";
    $("#setAiModel").value = settings.aiModel || "gpt-4o-mini";
    $("#setAiKey").value = settings.aiApiKey || "";
    $("#setAiBadge").textContent = settings.aiEnabled && String(settings.aiProvider || "worker") !== "off" ? "Activada" : "Desactivada";
    $("#setAiBadge").className = "badge " + (settings.aiEnabled && String(settings.aiProvider || "worker") !== "off" ? "badge--posted" : "");
    applyAiVisibility();
    $("#setDoc").value = settings.graphqlDocId || "";
    $("#setFriendly").value = settings.graphqlFriendlyName || "CometGroupDiscussionComposerCreateMutation";
    $("#setTemplate").value = settings.graphqlTemplate || "";
    $("#setTheme").value = settings.theme || "system";
    markPreset(settings.safetyPreset || "balanced");

    const select = $("#setTestGroup");
    const current = select.value;
    select.innerHTML = state.groups.length
      ? state.groups
          .map((group) => '<option value="' + escapeHtml(group.id) + '">' + escapeHtml(group.name) + "</option>")
          .join("")
      : '<option value="">No hay grupos cargados</option>';
    if (current) select.value = current;
  };

  /* Shows the fields of the selected AI provider: worker (repo) or custom
     (user endpoint). Hidden providers keep the raw values untouched. */
  const applyAiVisibility = () => {
    const provider = $("#setAiProvider").value || "worker";
    const isWorker = provider === "worker";
    const isCustom = provider === "custom";
    const setDisplay = (id, display) => {
      const el = root.querySelector("#" + id);
      if (el) el.style.display = display;
    };
    setDisplay("aiFieldsWorker", isWorker ? "" : "none");
    setDisplay("aiFieldsCustom", isCustom ? "" : "none");
    setDisplay("aiActionsRow", isWorker || isCustom ? "" : "none");
  };

  const collect = () =>
    sanitizeSettings({
      ...state.settings,
      minDelaySec: $("#setMin").value,
      maxDelaySec: $("#setMax").value,
      safetyEvery: $("#setEvery").value,
      safetySec: $("#setBreak").value,
      dailyLimit: $("#setDaily").value,
      retryOnce: $("#setRetry").checked,
      scrollPresence: $("#setScroll").checked,
      shareButton: $("#setShareBtn").checked,
      shuffleGroups: $("#setShuffleGroups").checked,
      focusWorker: $("#setFocusWorker").checked,
      debugLogs: $("#setDebugLogs").checked,
      transport: $("#setTransport").value,
      workTarget: $("#setWorkTarget").value,
      aiEnabled: $("#setAiEnabled").checked,
      aiProvider: $("#setAiProvider").value,
      aiWorkerUrl: $("#setAiWorker").value.trim(),
      aiTone: $("#setAiTone").value,
      aiStyle: $("#setAiStyle").value,
      aiLanguage: $("#setAiLanguage").value,
      aiBaseUrl: $("#setAiBase").value.trim(),
      aiModel: $("#setAiModel").value.trim(),
      aiApiKey: $("#setAiKey").value.trim(),
      graphqlDocId: $("#setDoc").value.trim(),
      graphqlFriendlyName: $("#setFriendly").value.trim(),
      graphqlTemplate: $("#setTemplate").value,
      theme: $("#setTheme").value
    });

  const save = async (patch = {}) => {
    const next = { ...collect(), ...patch };
    await saveSettings(next);
    return next;
  };

  const ensureOriginPermission = async (url) => {
    const origin = originOf(url);
    if (!origin) return false;
    if (typeof chrome === "undefined" || !chrome.permissions || typeof chrome.permissions.request !== "function") {
      return true;
    }
    try {
      /* Called straight from a user gesture: request() resolves true when the
         origin is already granted, so no prompt appears twice. */
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  };

  const simpleFields = [
    "setMin",
    "setMax",
    "setEvery",
    "setBreak",
    "setDaily",
    "setRetry",
    "setScroll",
    "setShareBtn",
    "setShuffleGroups",
    "setFocusWorker",
    "setDebugLogs",
    "setTransport",
    "setWorkTarget",
    "setAiEnabled",
    "setAiProvider",
    "setAiWorker",
    "setAiTone",
    "setAiStyle",
    "setAiLanguage",
    "setAiModel",
    "setAiKey",
    "setDoc",
    "setFriendly",
    "setTemplate",
    "setTheme"
  ];

  const TIMING_FIELDS = new Set(["setMin", "setMax", "setEvery", "setBreak", "setDaily"]);

  simpleFields.forEach((id) => {
    root.querySelector("#" + id).addEventListener("change", async () => {
      try {
        /* Ask for the AI origin before any await, while the click still counts
           as a user gesture. */
        if (id === "setAiEnabled" && $("#setAiEnabled").checked) {
          const aiUrl = $("#setAiProvider").value === "worker" ? $("#setAiWorker").value.trim() : $("#setAiBase").value.trim();
          const ok = await ensureOriginPermission(aiUrl);
          if (!ok) toast("Concede permiso al endpoint para que la IA funcione.", "error");
        }
        if (id === "setAiProvider") {
          await save({ aiProvider: $("#setAiProvider").value });
          loadFields();
          return;
        }
        await save(TIMING_FIELDS.has(id) ? { safetyPreset: "custom" } : {});
        if (TIMING_FIELDS.has(id)) markPreset("custom");
        if (["setAiEnabled", "setAiProvider", "setAiWorker", "setAiTone", "setAiStyle", "setAiLanguage"].includes(id)) loadFields();
      } catch (error) {
        toast(String(error.message || error), "error");
      }
    });
  });

  $("#setAiBase").addEventListener("change", async () => {
    try {
      const url = $("#setAiBase").value.trim();
      if (url) {
        const granted = await ensureOriginPermission(url);
        if (!granted) toast("Permiso pendiente para ese endpoint. Pulsa Probar conexión.", "error");
      }
      await save();
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  });

  $("#setPresets").addEventListener("click", async (event) => {
    const chip = event.target.closest("[data-preset]");
    if (!chip) return;
    const preset = PRESETS[chip.dataset.preset];
    if (!preset) return;
    $("#setMin").value = preset.min;
    $("#setMax").value = preset.max;
    $("#setEvery").value = preset.every;
    $("#setBreak").value = preset.pauseMin * 60;
    $("#setDaily").value = preset.daily;
    try {
      await save({ safetyPreset: chip.dataset.preset });
      markPreset(chip.dataset.preset);
      toast("Perfil " + preset.label + " aplicado.", "ok");
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  });

  $("#setAiTest").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const settings = collect();
    const aiUrl = settings.aiProvider === "worker" ? settings.aiWorkerUrl || "https://fb-smart-poster.0amaal89.workers.dev" : settings.aiBaseUrl;
    if (!aiUrl) {
      toast("Escribe el endpoint primero.", "error");
      return;
    }
    busy(button, true, "Probando…");
    $("#setAiStatus").textContent = "";
    try {
      const granted = await ensureOriginPermission(aiUrl);
      if (!granted) {
        $("#setAiStatus").textContent = "Permiso denegado para ese dominio.";
        toast("Chrome no concedió permiso a ese endpoint.", "error");
        return;
      }
      const result = await testAi(settings);
      if (result.ok) {
        $("#setAiStatus").textContent = "OK: " + result.text.slice(0, 120);
        toast("La IA respondió correctamente.", "ok");
      } else {
        $("#setAiStatus").textContent = result.error;
        toast("La IA no respondió.", "error");
      }
    } catch (error) {
      $("#setAiStatus").textContent = String(error.message || error);
      toast(String(error.message || error), "error");
    } finally {
      busy(button, false);
    }
  });

  $("#setShowWindow").addEventListener("click", async () => {
    if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      toast("Esta acción requiere ejecutar Group Poster como extensión en Chrome.", "error");
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: "gp:uiFocus" });
      if (!response || response.ok === false) {
        toast((response && response.error) || "No hay ventana abierta. Lanza una campaña o sincroniza grupos.", "error");
      }
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  });

  $("#setScanGroups").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    busy(button, true, "Sincronizando…");
    try {
      const response = await api("groups:load");
      if (!response || response.ok === false) throw new Error((response && response.error) || "No se pudo sincronizar.");
      toast("Grupos sincronizados (" + (response.count || 0) + ").", "ok");
      loadFields();
    } catch (error) {
      toast(String(error.message || error), "error");
    } finally {
      busy(button, false);
    }
  });

  $("#setCheck").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    busy(button, true, "Comprobando…");
    $("#setSession").innerHTML = '<span class="muted">Hablando con Facebook…</span>';
    try {
      const response = await api("session:check");
      if (response && response.ok) {
        $("#setSession").innerHTML =
          "<strong>Conectado</strong>" +
          '<div class="small" style="margin-top:4px">ID: ' +
          escapeHtml(response.userId || "desconocido") +
          (response.userName ? " · " + escapeHtml(response.userName) : "") +
          " · tokens: " +
          (response.hasDtsg ? "ok" : "faltan") +
          (response.hasLsd ? " · lsd ok" : "") +
          " · vía " +
          escapeHtml(response.via || "directo") +
          "</div>";
        toast("La sesión está bien.", "ok");
      } else {
        $("#setSession").innerHTML =
          '<strong style="color:var(--bad)">No disponible</strong><div class="small" style="margin-top:4px">' +
          escapeHtml((response && response.error) || "Error desconocido") +
          "</div>";
        toast("La comprobación falló.", "error");
      }
    } catch (error) {
      $("#setSession").innerHTML =
        '<strong style="color:var(--bad)">Error</strong><div class="small">' + escapeHtml(String(error.message || error)) + "</div>";
      toast(String(error.message || error), "error");
    } finally {
      busy(button, false);
    }
  });


  let testImageData = "";
  let testImagesData = [];
  $("#setTestImageFile").addEventListener("change", async () => {
    const files = Array.from($("#setTestImageFile").files || []);
    if (!files.length) {
      testImageData = "";
      testImagesData = [];
      return;
    }
    const readFile = (file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
    testImagesData = await Promise.all(files.map(readFile));
    testImageData = testImagesData[0] || "";
  });

  $("#setTestSend").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const groupId = $("#setTestGroup").value;
    const message = $("#setTestMessage").value.trim();
    if (!groupId) {
      toast("Carga grupos primero.", "error");
      return;
    }
    if (!message) {
      toast("Escribe un mensaje.", "error");
      return;
    }
    if (!(await confirmDialog("¿Publicar este post de prueba ahora?", { title: "Post de prueba", confirmLabel: "Publicar" }))) return;
    busy(button, true, "Publicando…");
    $("#setTestResult").innerHTML = '<div class="inset">Trabajando…</div>';
    try {
      const imageUrl = testImageData || $("#setTestImage").value.trim();
      const response = await api("test:post", { groupId, message, imageUrl, images: testImagesData });
      if (!response || response.ok === false) throw new Error((response && response.error) || "La prueba falló.");
      const result = response.result || {};
      $("#setTestResult").innerHTML = result.ok
        ? '<div class="inset" style="border-color:var(--ok)">Publicado vía ' +
          escapeHtml(result.via || "?") +
          (result.pending ? " (pendiente de aprobación)" : "") +
          (result.imageAttached ? " · con foto" : "") +
          (result.postUrl
            ? ' · <a href="' + escapeHtml(result.postUrl) + '" target="_blank" rel="noopener">abrir post</a>'
            : "") +
          (Array.isArray(result.debug)
            ? '<div class="mono xs" style="margin-top:6px;white-space:pre-wrap">' + escapeHtml(result.debug.join("\n")) + "</div>"
            : "") +
          "</div>"
        : '<div class="inset" style="border-color:var(--bad)"><strong>Falló:</strong> ' +
          escapeHtml(result.error || "") +
          '<div class="mono xs" style="margin-top:6px;white-space:pre-wrap">' +
          (Array.isArray(result.debug) && result.debug.length
            ? escapeHtml(result.debug.join("\n"))
            : escapeHtml(String(result.raw || "").slice(0, 800))) +
          "</div></div>";
      toast(result.ok ? "Post de prueba publicado." : "La prueba falló.", result.ok ? "ok" : "error");
    } catch (error) {
      $("#setTestResult").innerHTML =
        '<div class="inset" style="border-color:var(--bad)">' + escapeHtml(String(error.message || error)) + "</div>";
      toast(String(error.message || error), "error");
    } finally {
      busy(button, false);
    }
  });

  $("#setExport").addEventListener("click", () => {
    const payload = {
      app: "group-poster",
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      groups: state.groups,
      groupStats: state.groupStats,
      lists: state.lists,
      campaigns: state.campaigns
    };
    download("group-poster-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(payload, null, 2));
    toast("Copia exportada.", "ok");
  });

  $("#setImport").addEventListener("click", async () => {
    const file = await pickFile("application/json");
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || data.app !== "group-poster") throw new Error("Ese archivo no es una copia de Group Poster.");
      const ok = await confirmDialog(
        "¿Importar " +
          (data.campaigns || []).length +
          " campaña(s), " +
          (data.groups || []).length +
          " grupo(s) y " +
          (data.lists || []).length +
          " lista(s)? Tus datos actuales se reemplazarán.",
        { title: "Importar copia", confirmLabel: "Reemplazar e importar" }
      );
      if (!ok) return;
      if (Array.isArray(data.groups)) await saveGroups(data.groups);
      if (data.groupStats && typeof data.groupStats === "object") await saveGroupStats(data.groupStats);
      if (Array.isArray(data.lists)) await saveLists(data.lists);
      if (Array.isArray(data.campaigns)) await saveCampaigns(data.campaigns);
      if (data.settings) await saveSettings(sanitizeSettings(data.settings));
      toast("Copia importada.", "ok");
      loadFields();
      renderDiagnostics();
    } catch (error) {
      toast(String(error.message || error), "error");
    }
  });

  const renderDiagnostics = async () => {
    const entries = await readDiagnostics();
    $("#setDiag").innerHTML = entries.length
      ? entries
          .slice()
          .reverse()
          .map(
            (entry) =>
              '<div style="padding:6px 0;border-bottom:1px solid var(--line)">' +
              '<span class="muted">' + escapeHtml(fmtDateTime(entry.ts)) + "</span> " +
              '<span class="strong">' + escapeHtml(entry.scope || "evento") + "</span> " +
              escapeHtml(entry.url || entry.group || entry.error || "") +
              (entry.raw
                ? '<div class="xs muted" style="white-space:pre-wrap">' + escapeHtml(String(entry.raw).slice(0, 300)) + "</div>"
                : "") +
              "</div>"
          )
          .join("")
      : '<div class="muted small">Sin diagnósticos. Se rellena cuando una petición falla o se lanza un post de prueba.</div>';
  };

  $("#setDiagRefresh").addEventListener("click", renderDiagnostics);

  $("#setReset").addEventListener("click", async () => {
    const ok = await confirmDialog(
      "¿Borrar campañas, grupos, listas, ajustes y el registro de este navegador? Exporta una copia antes si quieres conservarlos.",
      { title: "Restablecer todo", confirmLabel: "Borrar todo" }
    );
    if (!ok) return;
    await remove([KEYS.campaigns, KEYS.groups, KEYS.groupStats, KEYS.lists, KEYS.log, KEYS.run, KEYS.diagnostics, KEYS.settings]);
    toast("Todos los datos borrados.", "ok");
    loadFields();
  });

  loadFields();
  renderDiagnostics();

  return null;
}
