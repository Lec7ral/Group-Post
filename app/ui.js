/* Tiny DOM helpers: formatting, toasts and dialogs. No framework. */

export { escapeHtml, fmtTime, fmtDateTime, fmtDuration, fmtDelay, download, pickFile, readFileAsDataUrl } from "../shared/util.js";

let toastHost = null;
export function toast(message, kind = "info", timeout = 3600) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    document.body.appendChild(toastHost);
  }
  const node = document.createElement("div");
  node.className = "toast toast--" + kind;
  node.textContent = message;
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-in"));
  setTimeout(() => {
    node.classList.remove("is-in");
    setTimeout(() => node.remove(), 200);
  }, timeout);
}

function openDialog({ title, body, confirmLabel = "Aceptar", cancelLabel = "Cancelar", input = null, wide = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "gp-dialog" + (wide ? " gp-dialog--wide" : "");
    dialog.innerHTML =
      '<form method="dialog" class="gp-dialog__form">' +
      '<h2 class="gp-dialog__title"></h2>' +
      '<div class="gp-dialog__body"></div>' +
      '<div class="gp-dialog__actions">' +
      '<button value="cancel" class="btn btn--ghost" type="submit"></button>' +
      '<button value="ok" class="btn btn--primary" type="submit"></button>' +
      "</div></form>";
    dialog.querySelector(".gp-dialog__title").textContent = title;
    const bodyHost = dialog.querySelector(".gp-dialog__body");
    if (typeof body === "string") bodyHost.innerHTML = body;
    else if (body) bodyHost.appendChild(body);
    let field = null;
    if (input) {
      field = document.createElement(input.multiline ? "textarea" : "input");
      field.className = input.multiline ? "textarea mono" : "input";
      if (input.multiline) field.style.minHeight = "180px";
      field.value = input.value || "";
      field.placeholder = input.placeholder || "";
      bodyHost.appendChild(field);
    }
    const cancelBtn = dialog.querySelector('button[value="cancel"]');
    const okBtn = dialog.querySelector('button[value="ok"]');
    cancelBtn.textContent = cancelLabel;
    okBtn.textContent = confirmLabel;
    if (!cancelLabel) cancelBtn.hidden = true;
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => {
      const ok = dialog.returnValue === "ok";
      const value = field ? field.value : null;
      dialog.remove();
      resolve({ ok, value });
    });
    dialog.showModal();
    if (field) {
      if (!input.multiline) {
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            dialog.returnValue = "ok";
            dialog.close();
          }
        });
      }
      field.focus();
      if (!input.multiline) field.select();
    } else {
      okBtn.focus();
    }
  });
}

export async function confirmDialog(message, { title = "Confirma", confirmLabel = "Confirmar", cancelLabel = "Cancelar" } = {}) {
  const body = document.createElement("p");
  body.className = "muted";
  body.textContent = message;
  const result = await openDialog({ title, body, confirmLabel, cancelLabel });
  return result.ok;
}

export async function promptDialog(title, defaultValue = "", { placeholder = "" } = {}) {
  const promise = openDialog({ title, body: "", confirmLabel: "Guardar", input: { value: defaultValue, placeholder } });
  const result = await promise;
  return result.ok ? result.value : null;
}

export async function textareaDialog(title, { hint = "", defaultValue = "", placeholder = "", confirmLabel = "Importar" } = {}) {
  let body = "";
  if (hint) {
    body = document.createElement("p");
    body.className = "hint";
    body.style.margin = "0 0 8px";
    body.textContent = hint;
  }
  const result = await openDialog({
    title,
    body,
    confirmLabel,
    wide: true,
    input: { multiline: true, value: defaultValue, placeholder }
  });
  return result.ok ? result.value : null;
}

export async function contentDialog({ title, body, confirmLabel = "Cerrar", cancelLabel = "", wide = true }) {
  const result = await openDialog({ title, body, confirmLabel, cancelLabel, wide });
  return result.ok;
}

export const busy = (button, isBusy, label) => {
  if (!button) return;
  if (isBusy) {
    button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.classList.add("is-busy");
    if (label) button.textContent = label;
  } else {
    button.disabled = false;
    button.classList.remove("is-busy");
    if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
};

export const initials = (name) =>
  String(name || "?")
    .trim()
    .slice(0, 2)
    .toUpperCase();
