/* Toolbar popup: quick actions on the user's Facebook tab.
   The dashboard is opened separately for supervision and campaign management. */

const $ = (id) => document.getElementById(id);

async function readSettings() {
  try {
    const data = await chrome.storage.local.get(["settings"]);
    return (data && data.settings) || {};
  } catch {
    return {};
  }
}

async function saveWorkMode() {
  const settings = await readSettings();
  await chrome.storage.local.set({
    settings: { ...settings, workTarget: $("workMode").value === "newtab" ? "newtab" : "tab" }
  });
}

function status(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = kind;
}

$("scan").addEventListener("click", async () => {
  const button = $("scan");
  button.disabled = true;
  status("Escaneando la pestaña de Facebook…");
  try {
    await saveWorkMode();
    const response = await chrome.runtime.sendMessage({ type: "gp:api", action: "groups:load" });
    if (!response || response.ok === false) {
      status((response && response.error) || "No se pudieron cargar los grupos.", "error");
      return;
    }
    const count = Array.isArray(response.groups) ? response.groups.length : Number(response.count) || 0;
    status("Grupos cargados: " + count + ". Abre el panel para verlos.", "ok");
  } catch (error) {
    status(String(error && error.message ? error.message : error), "error");
  } finally {
    button.disabled = false;
  }
});

$("open").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "gp:openApp" });
  } catch (error) {
    status(String(error && error.message ? error.message : error), "error");
    return;
  }
  window.close();
});

readSettings().then((settings) => {
  $("workMode").value = settings.workTarget === "newtab" ? "newtab" : "tab";
});
