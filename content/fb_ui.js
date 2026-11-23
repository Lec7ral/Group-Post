/* Group Poster - Facebook page automation.

   Runs inside facebook.com. Three jobs:
   1. Post to the group that is currently open, by driving the real composer
      and verifying that the post was actually published.
   2. Scan the "your groups" page for joined groups.
   3. Inject a small "Grupos" button in the feed action bars so an existing
      post can be forwarded to several groups.

   Nothing runs unless the extension asks for it. */

(() => {
  if (window.__gpUiLoaded) return;
  window.__gpUiLoaded = true;

  const VERSION = 2;
  const WORKER_FLAG = "gp:worker";
  let isWorker = false;
  try {
    isWorker = sessionStorage.getItem(WORKER_FLAG) === "1";
  } catch {
    isWorker = false;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const labelOf = (el) => {
    if (!el) return "";
    const value =
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.textContent ||
      "";
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  };

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    /* A background/occluded tab can report zero-sized rects, so rely on the
       computed style and DOM state instead of geometry. */
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const pickVisible = (selector, root = document) => {
    const nodes = Array.from(root.querySelectorAll(selector));
    return nodes.find((node) => isVisible(node)) || null;
  };

  /* ---------------- safety ---------------- */

  const WARNING_PHRASES = [
    "you're temporarily blocked",
    "you are temporarily blocked",
    "we limit how often you can post",
    "goes against our community standards",
    "this post goes against",
    "account restricted",
    "your account has been restricted",
    "security check",
    "confirm your identity",
    "we suspended your account",
    "bloqueado temporalmente",
    "bloqueada temporalmente",
    "limitamos la frecuencia",
    "tu cuenta está restringida",
    "tu cuenta ha sido restringida",
    "control de seguridad",
    "confirma tu identidad",
    "infringe nuestras normas",
    "normas comunitarias",
    "suspendimos tu cuenta",
    "تم حظرك مؤقتًا",
    "نحن نضع قيود",
    "تم تقييد حسابك",
    "compte restreint",
    "votre compte a été restreint"
  ];

  function detectWarning() {
    /* Dialogs and alerts are where Facebook actually shows a block or a
       checkpoint, and they never contain other people's posts. */
    const overlays = document.querySelectorAll('div[role="dialog"], div[role="alert"]');
    for (const node of overlays) {
      if (!isVisible(node)) continue;
      const text = String(node.innerText || "").toLowerCase();
      for (const phrase of WARNING_PHRASES) {
        if (text.includes(phrase)) return 'Facebook muestra un aviso: "' + phrase + '"';
      }
    }

    /* A full checkpoint replaces the page with the warning, so only scan the
       body when there is no feed or group content around it. Scanning the feed
       would match users talking about restrictions. */
    const hasFeed = Boolean(
      document.querySelector('div[role="feed"]') ||
        document.querySelector('div[role="article"]') ||
        document.querySelector('div[data-pagelet*="Group"]')
    );
    if (hasFeed) return null;

    const text = String(document.body ? document.body.innerText : "").slice(0, 200000).toLowerCase();
    for (const phrase of WARNING_PHRASES) {
      if (text.includes(phrase)) return 'Facebook muestra un aviso: "' + phrase + '"';
    }
    return null;
  }

  /* ---------------- text input ---------------- */

  function placeCaretInEditor(editor) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* ignore */
    }
  }

  async function setEditorText(editor, text) {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const readValue = (node) => {
      if (!node || node === document.body) return "";
      return String(node.textContent || node.innerText || "");
    };
    const needle = normalize(text).slice(0, 14);
    const hasText = () =>
      Boolean(needle) &&
      (normalize(readValue(editor)).includes(needle) || normalize(readValue(document.activeElement)).includes(needle));
    const waitInserted = async (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 60) {
        if (hasText()) return true;
        await sleep(60);
      }
      return hasText();
    };

    if (hasText()) return true;

    editor.focus();
    placeCaretInEditor(editor);
    /* Avoid synthetic click() when the tab is hidden if focus+selection already holds. */
    if (!document.hidden) {
      try {
        editor.click();
      } catch {
        /* ignore */
      }
      placeCaretInEditor(editor);
    }

    /* 1) Clipboard paste into Lexical editor (text/plain only so Lexical inserts once). */
    try {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", String(text));
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    } catch {
      /* ignore */
    }
    if (await waitInserted(300)) {
      trace("setEditorText via=paste editor=" + readValue(editor).slice(0, 40));
      return true;
    }

    /* 2) execCommand fallback (only if paste did not populate the editor). */
    try {
      placeCaretInEditor(editor);
      document.execCommand("insertText", false, String(text));
    } catch {
      /* ignore */
    }
    if (await waitInserted(240)) {
      trace("setEditorText via=execCommand editor=" + readValue(editor).slice(0, 40));
      return true;
    }

    /* 3) Lexical beforeinput fallback (mainly for background tabs where execCommand is ignored). */
    try {
      placeCaretInEditor(editor);
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: String(text)
        })
      );
    } catch {
      /* ignore */
    }
    if (await waitInserted(240)) {
      trace("setEditorText via=beforeinput editor=" + readValue(editor).slice(0, 40));
      return true;
    }

    /* 4) Last-resort DOM text assignment + single input/change signal. */
    try {
      editor.textContent = String(text);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: String(text).slice(-1) }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      /* ignore */
    }
    trace("setEditorText via=dom editor=" + readValue(editor).slice(0, 40));
    return hasText();
  }

  /* ---------------- composer ---------------- */

  const COMPOSER_HINTS = [
    "write something",
    "create a public post",
    "create a post",
    "write a post",
    "what's on your mind",
    "start discussion",
    "crear publicación",
    "escribe algo",
    "iniciar conversación",
    "créer une publication",
    "exprimez-vous",
    "اكتب شيئاً",
    "انشئ منشوراً",
    "إنشاء منشور",
    "بما تفكر",
    "أضف منشوراً"
  ];

  const COMPOSER_SELECTORS = [
    'div[data-pagelet="GroupInlineComposer"] div[role="button"]',
    'div[data-pagelet*="Composer"] div[role="button"]',
    '[aria-label*="Create a public post"]',
    '[aria-label*="Write something"]',
    '[aria-label*="Create a post"]',
    '[aria-label*="Créer une publication"]',
    '[aria-label*="Exprimez-vous"]',
    '[aria-label*="Crear publicación"]',
    '[aria-label*="اكتب شيئاً"]',
    '[aria-label*="انشئ منشوراً"]'
  ];

  const COMMENT_WORDS = ["comment", "comentar", "comentario", "commenter", "composer un comment", "تعليق", "コメント"];

  const SELL_WORDS = [
    "sell something",
    "sell an item",
    "item for sale",
    "vehicle for sale",
    "home for sale",
    "vender algo",
    "vender un artículo",
    "vender artículo",
    "artículo en venta",
    "vehículo en venta",
    "vivienda en venta",
    "crear publicación de venta",
    "publicación de venta",
    "vendre quelque chose",
    "vendre un article",
    "article à vendre",
    "vender alguma coisa",
    "item à venda",
    "بيع شيء",
    "عرض للبيع",
    "عنصر للبيع"
  ];

  const SECONDARY_COMPOSER_WORDS = [
    "live video",
    "video en vivo",
    "vídeo en directo",
    "vidéo en direct",
    "photo/video",
    "foto/video",
    "foto/vídeo",
    "photo/vidéo",
    "feeling/activity",
    "sentimiento/actividad",
    "poll",
    "encuesta",
    "sondage",
    "anonymous post",
    "publicación anónima",
    "publication anonyme",
    "tag people",
    "etiquetar personas"
  ];

  const isSellLabel = (label) => {
    const lower = String(label || "").toLowerCase().trim();
    if (!lower) return false;
    return SELL_WORDS.some((word) => lower.includes(word)) || /^(sell|vender|vendre)\b/.test(lower);
  };

  const isExcludedTriggerLabel = (label) => {
    const lower = String(label || "").toLowerCase().trim();
    if (!lower) return false;
    if (COMMENT_WORDS.some((word) => lower.includes(word))) return true;
    if (isSellLabel(lower)) return true;
    return SECONDARY_COMPOSER_WORDS.some((word) => lower === word || lower.startsWith(word));
  };

  function findComposerTrigger() {
    for (const selector of COMPOSER_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const node = nodes.find((candidate) => isVisible(candidate) && !isExcludedTriggerLabel(labelOf(candidate)));
      if (node) {
        const button = node.closest('[role="button"]') || node;
        if (isVisible(button) && !isExcludedTriggerLabel(labelOf(button))) return button;
      }
    }
    const candidates = document.querySelectorAll('div[role="button"], span[role="button"]');
    for (const node of candidates) {
      const label = labelOf(node);
      if (!label) continue;
      const lower = label.toLowerCase();
      if (isExcludedTriggerLabel(lower)) continue;
      if (COMPOSER_HINTS.some((hint) => lower.includes(hint))) {
        const button = node.closest('[role="button"]') || node;
        if (isVisible(button) && !isExcludedTriggerLabel(labelOf(button))) return button;
      }
    }
    return null;
  }

  function isBuySellDialog(dialog) {
    if (!dialog) return false;
    const headings = Array.from(dialog.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .map((el) => labelOf(el))
      .join(" ");
    if (
      /sell something|item for sale|vehicle for sale|home for sale|vender algo|art[ií]culo en venta|publicaci[oó]n de venta|what are you selling|qu[eé] vendes|qu[eé] est[aá]s vendiendo|vendre quelque chose|vendre un article|بيع شيء/.test(
        headings
      )
    ) {
      return true;
    }
    const inputs = Array.from(dialog.querySelectorAll('input:not([type="file"]):not([type="hidden"]), select'));
    return inputs.some((el) => {
      if (!isVisible(el)) return false;
      const hint = String(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").toLowerCase();
      return /^(price|precio|prix|السعر|what are you selling|qu[eé] vendes|qu[eé] est[aá]s vendiendo)/.test(hint);
    });
  }

  function closeOpenDialog(dialog) {
    if (!dialog) return;
    const closeBtn =
      pickVisible('[aria-label="Close"]', dialog) ||
      pickVisible('[aria-label="Cerrar"]', dialog) ||
      pickVisible('[aria-label="Fermer"]', dialog) ||
      pickVisible('[aria-label="إغلاق"]', dialog);
    if (closeBtn) {
      try {
        closeBtn.click();
      } catch {
        /* ignore */
      }
    }
  }

  function isPostComposer(dialog) {
    if (!dialog || isBuySellDialog(dialog)) return false;
    const text = String(dialog.innerText || "").toLowerCase();
    if (/write a comment|escribe un comentario|escribir un comentario|écrire un commentaire|اكتب تعليق|reply to/.test(text)) {
      return false;
    }
    return /post|publicar|public|create|write|crear|escribe|écrire|créer|نشر|منشور|اكتب|分享/.test(text);
  }

  /* Strict selectors ported from the reference extension. */
  function isComposerElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" && style.visibility !== "hidden" &&
      !el.closest('[hidden], [aria-hidden="true"]')
    );
  }

  function findEditorStrict(dialog) {
    if (!dialog) return null;
    return Array.from(dialog.querySelectorAll('[role="textbox"][contenteditable="true"]')).find(isComposerElementVisible) || null;
  }

  function findComposerDialogStrict() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (dialog) => isComposerElementVisible(dialog) && findEditorStrict(dialog) && !isBuySellDialog(dialog)
    );
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  function composerForm(dialog) {
    if (!dialog) return null;
    const editor = findEditorStrict(dialog);
    const form = editor && editor.closest("form");
    return form && dialog.contains(form) ? form : null;
  }

  function findMediaInputStrict(dialog) {
    const form = composerForm(dialog);
    if (!form) return null;
    const inputs = Array.from(form.querySelectorAll('input[type="file"]')).filter(
      (input) => input.isConnected && !input.disabled &&
        input.accept.split(",").some((type) => type.trim().toLowerCase().startsWith("image/"))
    );
    return inputs.length === 1 ? inputs[0] : null;
  }

  function findPostButtonStrict(dialog) {
    const form = composerForm(dialog);
    if (!form || !form.querySelector('input[type="submit"], button[type="submit"]')) return null;
    const buttons = Array.from(form.querySelectorAll('[role="button"], button')).filter(isComposerElementVisible);
    const button = buttons[buttons.length - 1];
    if (!button || !button.textContent?.trim() || !button.querySelector("span") ||
        button.querySelector("svg, img, i, input") ||
        !button.querySelector('[role="none"][data-visualcompletion="ignore"]')) return null;
    const formWidth = form.getBoundingClientRect().width;
    const btnWidth = button.getBoundingClientRect().width;
    if (formWidth > 0 && btnWidth > 0 && btnWidth < formWidth * 0.8) return null;
    return button;
  }

  function findComposerDialog() {
    const strict = findComposerDialogStrict();
    if (strict) return strict;
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(
      (d) => isVisible(d) && d.querySelector('div[contenteditable="true"]') && !isBuySellDialog(d)
    );
    const postDialogs = dialogs.filter(isPostComposer);
    if (postDialogs.length) return postDialogs[postDialogs.length - 1];
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  /* Only the post composer dialog is valid. */
  function findEditor() {
    const dialog = findComposerDialog();
    if (!dialog) return null;
    return findEditorStrict(dialog) ||
      pickVisible('div[contenteditable="true"][role="textbox"]', dialog) ||
      pickVisible('div[contenteditable="true"]', dialog);
  }

  function pageNotFound() {
    const title = String(document.title || "");
    const text = String(document.body ? document.body.innerText : "").slice(0, 3000);
    return (
      /not found/i.test(title) ||
      /back to facebook/i.test(text) ||
      /p[aá]gina no encontrada|p[aá]gina inexistente/i.test(text)
    );
  }

  async function waitFor(findFn, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = findFn();
      if (found) return found;
      await sleep(350);
    }
    return null;
  }

  const SUBMIT_EXACT = ["post", "publish", "submit", "نشر", "publier", "publicar", "publicar ahora", "إرسال"];
  const SUBMIT_STARTS = ["post", "publish", "نشر", "publier", "publicar"];
  const SUBMIT_BLACKLIST = [
    "add to your post",
    "add to post",
    "photo",
    "video",
    "tag",
    "feeling",
    "activity",
    "check in",
    "more",
    "settings",
    "schedule",
    "close",
    "cerrar",
    "fermer",
    "cancel",
    "comment",
    "comentar",
    "comentario",
    "reply",
    "programmer",
    "planifier",
    "إضافة",
    "صورة",
    "فيديو",
    "المزيد",
    "إغلاق",
    "إلغاء",
    "تعليق",
    "agregar a tu publicación",
    "ajouter à votre publication"
  ];

  function isSubmitButton(el) {
    if (!el) return false;
    const role = el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (role !== "button" && tag !== "button") return false;
    const label = labelOf(el);
    if (!label) return false;
    if (SUBMIT_BLACKLIST.some((word) => label.includes(word))) return false;
    if (label.length > 40) return false;
    if (SUBMIT_EXACT.includes(label)) return true;
    return SUBMIT_STARTS.some((word) => label === word || label.startsWith(word + " "));
  }

  function findSubmitButton() {
    const dialog = findComposerDialog();
    if (!dialog) return null;
    const strict = findPostButtonStrict(dialog);
    if (strict) return strict;
    const direct = pickVisible(
      'div[aria-label="Post"][role="button"], div[aria-label="Publicar"][role="button"], div[aria-label="Publier"][role="button"], div[aria-label="نشر"][role="button"], button[aria-label="Post"], button[aria-label="Publicar"]',
      dialog
    );
    if (direct && isSubmitButton(direct)) return direct;
    const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button'));
    const matches = buttons.filter((el) => isSubmitButton(el) && isVisible(el));
    return matches.length ? matches[matches.length - 1] : null;
  }

  const isDisabled = (el) =>
    el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.getAttribute("disabled") !== null;

  async function waitForSubmitReady(timeoutMs) {
    const started = Date.now();
    let lastFound = null;
    while (Date.now() - started < timeoutMs) {
      const button = findSubmitButton();
      if (button) {
        lastFound = button;
        const dialog = findComposerDialog();
        const dialogText = dialog ? String(dialog.innerText || "").toLowerCase() : "";
        const fetchingPreview =
          Boolean(pickVisible('div[role="progressbar"]', dialog || document)) ||
          dialogText.includes("fetching preview") ||
          dialogText.includes("جلب المعاينة") ||
          dialogText.includes("création de l'aperçu");

        if (!isDisabled(button) && !fetchingPreview) {
          return { button, status: "ready" };
        }

        if (Date.now() - started > 10000 && fetchingPreview && dialog) {
          const removePreview =
            pickVisible('[aria-label="Remove preview"]', dialog) ||
            pickVisible('[aria-label="إزالة المعاينة"]', dialog) ||
            pickVisible('[aria-label="Supprimer l\'aperçu"]', dialog);
          if (removePreview) {
            removePreview.click();
            await sleep(1200);
          }
        }
      }
      await sleep(400);
    }
    const stillDisabled = lastFound ? isDisabled(lastFound) : false;
    return {
      button: lastFound,
      status: stillDisabled ? "timeout_disabled" : lastFound ? "ready" : "not_found"
    };
  }

  /* Facebook's buttons are React components: dispatching DOM events is not
     always enough. Invoke the synthetic onClick stored on the React fiber. */
  function reactClick(el) {
    try {
      for (const key of Object.keys(el)) {
        if (!key.startsWith("__reactProps$") && !key.startsWith("__reactEventHandlers$")) continue;
        const props = el[key];
        if (props && typeof props.onClick === "function") {
          props.onClick({
            currentTarget: el,
            target: el,
            preventDefault() {},
            stopPropagation() {}
          });
          return true;
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /* ONE activation per call. Calling React's onClick plus the whole pointer
     sequence plus el.click() opened the composer three times. */
  async function clickOnce(el, mode) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (typeof el.focus === "function") el.focus();
    } catch {
      /* ignore */
    }
    await sleep(150);
    if (mode === "react") return reactClick(el);
    if (mode === "dom") {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
    const rect = el.getBoundingClientRect();
    const jitter = () => (Math.random() - 0.5) * 8;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2 + jitter(),
      clientY: rect.top + rect.height / 2 + jitter()
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", common));
      el.dispatchEvent(new MouseEvent("mousedown", common));
      await sleep(50 + Math.floor(Math.random() * 80));
      el.dispatchEvent(new PointerEvent("pointerup", common));
      el.dispatchEvent(new MouseEvent("mouseup", common));
      el.dispatchEvent(new MouseEvent("click", common));
      return true;
    } catch {
      return false;
    }
  }

  async function openComposer(trigger) {
    const status = () => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const withEditor = dialogs.filter((d) => d.querySelector('[contenteditable="true"]'));
      trace("dialogs=" + dialogs.length + " conEditor=" + withEditor.length + " detectado=" + Boolean(findComposerDialog()));
    };
    status();
    for (const mode of ["react", "dom", "pointer"]) {
      if (findComposerDialog()) return true;
      trace("clic composer modo=" + mode);
      await clickOnce(trigger, mode);
      await sleep(1500);
      status();
      if (findComposerDialog()) return true;
    }
    return Boolean(findComposerDialog());
  }

  function fireClick(el) {
    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }
    try {
      if (typeof el.focus === "function") el.focus();
    } catch {
      /* ignore */
    }
    /* A single native click reaches React's delegated handler. Dispatching
       extra synthetic clicks opened several dialogs on Facebook. */
    try {
      if (typeof el.click === "function") el.click();
    } catch {
      /* ignore */
    }
  }

  const PENDING_PHRASES = [
    "your post has been submitted",
    "submitted and is pending approval",
    "pending approval",
    "تم إرسال منشورك",
    "قيد المراجعة",
    "publication envoyée",
    "publicación enviada"
  ];

  const APPROVAL_HINTS = [
    "requires admin approval",
    "require admin approval",
    "must be approved by an admin",
    "pending admin approval",
    "requiere aprobación",
    "requieren aprobación",
    "aprobación de un administrador",
    "aprobación del administrador",
    "pendiente de aprobación",
    "approbation d'un administrateur",
    "soumises à l'approbation",
    "موافقة المسؤول"
  ];

  function detectPending({ allowFullBody = true } = {}) {
    const alerts = document.querySelectorAll('div[role="alert"], div[role="status"]');
    for (const node of alerts) {
      if (!isVisible(node)) continue;
      const text = String(node.innerText || "").toLowerCase();
      if (PENDING_PHRASES.some((phrase) => text.includes(phrase))) return true;
    }
    if (!allowFullBody) return false;
    const text = String(document.body ? document.body.innerText : "").slice(0, 200000).toLowerCase();
    return PENDING_PHRASES.some((phrase) => text.includes(phrase));
  }

  function detectApprovalRequirement(dialog) {
    const scope = dialog || document.querySelector('div[role="dialog"]') || document.querySelector('[role="main"]');
    if (!scope) return false;
    const text = String(scope.innerText || "").slice(0, 40000).toLowerCase();
    return APPROVAL_HINTS.some((phrase) => text.includes(phrase));
  }

  const PAUSED_OR_ARCHIVED_PHRASES = [
    "this group is paused",
    "group is paused",
    "this group has been paused",
    "posting is paused",
    "posting has been paused",
    "admins have paused",
    "paused by an admin",
    "este grupo está en pausa",
    "este grupo esta en pausa",
    "grupo en pausa",
    "las publicaciones están en pausa",
    "publicaciones en pausa",
    "este grupo ha sido pausado",
    "el administrador pausó este grupo",
    "este grupo está congelado",
    "grupo congelado",
    "ce groupe est en pause",
    "groupe en pause",
    "les publications sont en pause",
    "este grupo está pausado",
    "grupo pausado",
    "هذه المجموعة متوقفة مؤقتًا",
    "المجموعة متوقفة مؤقتًا",
    "تم إيقاف النشر مؤقتًا",
    "this group is archived",
    "this group has been archived",
    "archived group",
    "este grupo está archivado",
    "este grupo esta archivado",
    "este grupo fue archivado",
    "grupo archivado",
    "ce groupe est archivé",
    "groupe archivé",
    "este grupo foi arquivado",
    "grupo arquivado",
    "هذه المجموعة مؤرشفة",
    "تمت أرشفة هذه المجموعة",
    "this group is no longer available",
    "este grupo ya no está disponible",
    "group has been disabled"
  ];

  function getGroupNonFeedText() {
    const main = document.querySelector('[role="main"]');
    if (!main) return "";
    const chunks = [];
    const walk = (el) => {
      if (!el || el.nodeType !== 1) return;
      const role = el.getAttribute("role");
      if (role === "feed" || role === "article") return;
      if (el.getAttribute("aria-hidden") === "true" || el.hidden) return;
      if (!el.children.length) {
        const txt = String(el.textContent || "").trim();
        if (txt) chunks.push(txt);
        return;
      }
      for (const child of el.children) walk(child);
    };
    walk(main);
    return chunks.join(" ").replace(/\s+/g, " ").slice(0, 8000).toLowerCase();
  }

  function detectPausedOrArchived(nonFeedText) {
    const text = nonFeedText || getGroupNonFeedText();
    if (!text) return null;
    const hit = PAUSED_OR_ARCHIVED_PHRASES.find((phrase) => text.includes(phrase));
    if (!hit) return null;
    const archived = /archiv|مؤرشفة/.test(hit);
    return archived
      ? "Este grupo está archivado y ya no admite publicaciones."
      : "Este grupo está en pausa / congelado y no admite publicaciones.";
  }

  function detectBuySellOnly(nonFeedText) {
    const scopes = Array.from(
      document.querySelectorAll('div[data-pagelet="GroupInlineComposer"], div[data-pagelet*="Composer"]')
    );
    const main = document.querySelector('[role="main"]');
    if (!scopes.length && main) scopes.push(main);

    for (const scope of scopes) {
      const buttons = scope.querySelectorAll('[role="button"], button');
      for (const btn of buttons) {
        if (btn.closest('div[role="feed"], div[role="article"]')) continue;
        if (!isVisible(btn)) continue;
        if (isSellLabel(labelOf(btn))) {
          return "Grupo en modo ventas / compraventa («Vender algo»), sin publicación normal.";
        }
      }
    }

    const text = nonFeedText || getGroupNonFeedText();
    if (
      text &&
      /\b(buy and sell|compraventa|art[ií]culos en venta|venta de art[ií]culos|achat et vente|بيع وشراء)\b/.test(text) &&
      /\b(sell something|vender algo|item for sale|art[ií]culo en venta|vendre quelque chose)\b/.test(text)
    ) {
      return "Grupo en modo ventas / compraventa, sin publicación estándar.";
    }
    return null;
  }

  function detectGroupBlockedReason() {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;
    const nonFeedText = getGroupNonFeedText();

    const paused = detectPausedOrArchived(nonFeedText);
    if (paused) return { code: "group_paused", skip: true, error: paused };

    if (
      /only admins can post|solo los administradores pueden publicar|seuls les administrateurs peuvent publier|يمكن للمسؤولين فقط النشر/.test(
        nonFeedText
      )
    ) {
      return {
        code: "cannot_post",
        skip: true,
        error: "Solo los administradores pueden publicar en este grupo."
      };
    }

    const joinBtn = Array.from(main.querySelectorAll('[role="button"], button')).find((el) => {
      if (el.closest('div[role="feed"], div[role="article"]')) return false;
      if (!isVisible(el)) return false;
      const lbl = labelOf(el);
      return lbl === "join group" || lbl === "unirse al grupo" || lbl === "rejoindre le groupe" || lbl === "انضمام إلى المجموعة";
    });
    if (joinBtn) {
      return {
        code: "cannot_post",
        skip: true,
        error: "No eres miembro de este grupo (aparece el botón Unirse al grupo)."
      };
    }

    const buySell = detectBuySellOnly(nonFeedText);
    if (buySell) return { code: "buy_sell_only", skip: true, error: buySell };

    return null;
  }

  function snapshotFeedPostLinks() {
    const feed = document.querySelector('div[role="feed"]') || document.querySelector('[role="main"]');
    const links = new Set();
    if (!feed) return links;
    feed.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]').forEach((a) => {
      try {
        const u = new URL(a.href, location.origin);
        links.add(u.origin + u.pathname);
      } catch {
        /* ignore */
      }
    });
    return links;
  }

  function findNewPostUrl(beforeLinks) {
    const feed = document.querySelector('div[role="feed"]') || document.querySelector('[role="main"]');
    if (!feed) return "";
    for (const a of feed.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')) {
      try {
        const u = new URL(a.href, location.origin);
        const clean = u.origin + u.pathname;
        if (!beforeLinks.has(clean)) return clean;
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  async function clickAndVerify(button) {
    let target = button;
    const composerDialog = findComposerDialog();
    const hadDialog = Boolean(composerDialog);
    const pendingBefore = detectPending({ allowFullBody: true });
    let sawSubmitting = false;

    for (const mode of ["react", "dom", "pointer"]) {
      if (!findComposerDialog()) return { ok: true };
      /* If a previous click already put the dialog in submitting state, wait
         instead of clicking Publicar again and risking a duplicate post. */
      if (sawSubmitting) {
        trace("envío en curso; esperando cierre sin re-clic");
      } else {
        trace("clic Publicar modo=" + mode);
        await clickOnce(target, mode);
        await sleep(250);
      }

      for (let step = 0; step < 14; step += 1) {
        await sleep(500);

        const warning = detectWarning();
        if (warning) return { ok: false, checkpoint: true, error: warning };

        if (hadDialog) {
          const alive =
            composerDialog &&
            document.contains(composerDialog) &&
            isVisible(composerDialog) &&
            composerDialog.getAttribute("aria-hidden") !== "true";
          if (!alive) {
            trace("diálogo cerrado tras clic");
            const pendingAfter = detectPending({ allowFullBody: !pendingBefore });
            return { ok: true, pending: pendingAfter };
          }
          const btnNow = findSubmitButton();
          if (
            (btnNow && isDisabled(btnNow)) ||
            Boolean(pickVisible('div[role="progressbar"]', composerDialog))
          ) {
            sawSubmitting = true;
          }
        }

        if (detectPending({ allowFullBody: !pendingBefore })) return { ok: true, pending: true };

        if (!hadDialog) {
          const editor = pickVisible('div[contenteditable="true"][role="textbox"]');
          if (!editor) return { ok: true };
        }
      }

      const fresh = findSubmitButton();
      if (fresh) target = fresh;
    }

    if (!findComposerDialog()) return { ok: true };
    return {
      ok: false,
      code: "dialog_open",
      error: "Se pulsó Publicar pero el cuadro sigue abierto. Puede que el grupo requiera responder preguntas de membresía o tenga restricciones."
    };
  }

  async function simulatePresence(seconds = 3) {
    const end = Date.now() + Math.max(0, seconds) * 1000;
    while (Date.now() < end) {
      const step = Math.floor(Math.random() * 250) + 100;
      try {
        window.scrollBy({ top: step, behavior: "smooth" });
      } catch {
        /* ignore */
      }
      await sleep(Math.floor(Math.random() * 900) + 600);
      if (Math.random() > 0.6) {
        try {
          window.scrollBy({ top: -Math.round(step * 0.4), behavior: "smooth" });
        } catch {
          /* ignore */
        }
        await sleep(Math.floor(Math.random() * 700) + 400);
      }
    }
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* ignore */
    }
    await sleep(800);
  }

  const MIME_EXT = {
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/jpg": "jpg"
  };

  async function fileFromDataUrl(dataUrl) {
    const [meta, b64] = String(dataUrl).split(",");
    const mime = ((/data:(.*?)(;base64)?$/.exec(meta || ""))?.[1] || "image/jpeg").toLowerCase();
    const ext = MIME_EXT[mime] || "jpg";
    const bin = atob(b64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || "image/jpeg" });
    return new File([blob], "imagen." + ext, { type: mime || "image/jpeg" });
  }

  function findComposerMediaInput(dialog) {
    const strict = findMediaInputStrict(dialog);
    if (strict) return strict;
    const scoped = dialog
      ? Array.from(dialog.querySelectorAll('input[type="file"]')).filter(
          (node) => !node.disabled && node.accept && node.accept.split(",").some((t) => t.trim().toLowerCase().startsWith("image/"))
        )
      : [];
    if (scoped.length === 1) return scoped[0];
    const all = Array.from(document.querySelectorAll('input[type="file"]')).filter(
      (node) => !node.disabled && node.accept && node.accept.split(",").some((t) => t.trim().toLowerCase().startsWith("image/"))
    );
    return all.length === 1 ? all[0] : all[0] || null;
  }

  async function attachImageToEditor(editor, dataUrls) {
    try {
      const list = Array.isArray(dataUrls) ? dataUrls.filter(Boolean) : [dataUrls];
      const files = [];
      for (const url of list) files.push(await fileFromDataUrl(url));
      const dialog = findComposerDialog() || editor.closest('div[role="dialog"]');
      /* Exactly like the reference: wait for the media input, then dispatch a
         single shared DataTransfer through dragenter -> dragover -> drop on its
         parent div. Do NOT assign input.files (Facebook ignores it). */
      let input = findComposerMediaInput(dialog);
      trace("media input inicial=" + Boolean(input));
      for (let attempt = 0; attempt < 40 && !input; attempt += 1) {
        await sleep(250);
        input = findComposerMediaInput(dialog);
      }
      trace("media input final=" + Boolean(input));
      if (!input) return false;
      const dropTarget = input.closest("div") || input;
      trace("drop target=" + dropTarget.tagName + "." + dropTarget.className);
      const data = new DataTransfer();
      for (const file of files) data.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        dropTarget.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
        await sleep(200);
      }
      /* Wait for Facebook to render the photo preview (blob:) in the dialog. */
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(500);
        const preview = dialog
          ? dialog.querySelector('img[src^="blob:"], img[src^="data:"], [data-img-permalink], [aria-label*="Remove"]')
          : null;
        if (preview) {
          trace("preview foto detectado");
          return true;
        }
      }
      trace("preview foto NO detectado (continuamos)");
      return true;
    } catch {
      return false;
    }
  }

  let debugSteps = [];
  let debugEnabled = false;
  const trace = (message) => {
    if (debugEnabled) debugSteps.push(String(message));
  };

  async function postToCurrentGroupInner(payload) {
    const text = String(payload.text || "").trim();
    trace("texto recibido: " + text.length + " chars");
    if (!text) return { ok: false, code: "empty", error: "El texto del post está vacío." };

    trace("pageNotFound=" + Boolean(pageNotFound()));
    if (pageNotFound()) {
      return {
        ok: false,
        code: "bad_group_page",
        error: "Facebook devolvió una página «Not Found». El enlace del grupo no es válido o ya no existe."
      };
    }

    const warning = detectWarning();
    trace("warning=" + String(warning || "-"));
    if (warning) return { ok: false, checkpoint: true, error: warning };

    if (payload.options && payload.options.presence) {
      await simulatePresence(1.8);
    }

    let trigger = await waitFor(findComposerTrigger, 5000);
    if (!trigger) {
      const blocked = detectGroupBlockedReason();
      if (blocked) {
        trace("grupo omitido=" + blocked.code + " · " + blocked.error);
        return { ok: false, ...blocked };
      }
      trigger = await waitFor(findComposerTrigger, 15000);
    }
    trace("composer trigger=" + (trigger ? (labelOf(trigger) || "encontrado") : "NO"));
    if (!trigger) {
      const blocked = detectGroupBlockedReason();
      if (blocked) return { ok: false, ...blocked };
      return {
        ok: false,
        code: "no_composer",
        error: "No encontré el cuadro de 'Crear publicación' en este grupo."
      };
    }

    const composerOpened = await openComposer(trigger);
    trace("composer abierto=" + composerOpened);
    if (!composerOpened) {
      const buySellDialog = Array.from(document.querySelectorAll('div[role="dialog"]')).find(
        (d) => isVisible(d) && isBuySellDialog(d)
      );
      if (buySellDialog) {
        closeOpenDialog(buySellDialog);
        return {
          ok: false,
          skip: true,
          code: "buy_sell_only",
          error: "El grupo abrió un formulario de compraventa (modo ventas) en lugar de publicación normal."
        };
      }
      return { ok: false, code: "no_editor", error: "No se abrió el cuadro de publicación del grupo." };
    }

    /* Facebook renders the composer dialog asynchronously. Give it time before
       polling, then wait up to 15 s for the editor to appear. */
    await sleep(1200);
    const buySellDialog = Array.from(document.querySelectorAll('div[role="dialog"]')).find(
      (d) => isVisible(d) && isBuySellDialog(d)
    );
    if (buySellDialog) {
      closeOpenDialog(buySellDialog);
      return {
        ok: false,
        skip: true,
        code: "buy_sell_only",
        error: "El grupo abrió un formulario de compraventa (modo ventas) en lugar de publicación normal."
      };
    }

    const editor = await waitFor(findEditor, 15000);
    trace("editor=" + (editor ? "encontrado" : "NO"));
    if (!editor) {
      return { ok: false, code: "no_editor", error: "No pude activar el editor del post." };
    }

    /* The reference attaches images BEFORE typing the text, then sleeps 1 s. */
    const options = payload.options || {};
    const images = Array.isArray(options.images)
      ? options.images.filter(Boolean)
      : options.image ? [String(options.image).trim()] : [];
    if (images.length) {
      const attached = await attachImageToEditor(editor, images);
      trace("imagen adjuntada=" + attached);
      if (!attached) {
        return { ok: false, code: "no_image", error: "No se pudo adjuntar la imagen al post." };
      }
      await sleep(1000);
    }

    /* Attaching a photo re-renders the composer: the old editor node is stale. */
    const liveEditor = images.length ? (await waitFor(findEditor, 10000)) || editor : editor;
    let textOk = await setEditorText(liveEditor, text);
    if (!textOk && liveEditor !== editor && editor.isConnected) {
      const btnNow = findSubmitButton();
      if (!btnNow || isDisabled(btnNow)) {
        trace("reintentando texto en el editor original");
        textOk = await setEditorText(editor, text);
      }
    }
    trace("texto escrito=" + textOk + " contenido=" + String(liveEditor.innerText || "").slice(0, 40));
    /* Lexical may keep the text in its internal state without exposing it in
       textContent. Do not abort on the verification — the Post button state is
       the real signal. */

    await sleep(1200);

    const submitCandidate = findSubmitButton();
    trace("botón Publicar=" + (submitCandidate ? (labelOf(submitCandidate) || "encontrado") + " disabled=" + isDisabled(submitCandidate) : "NO"));
    const ready = await waitForSubmitReady(30000);
    trace("submit ready=" + ready.status);
    if (!ready.button) {
      return { ok: false, code: "no_submit", error: "No encontré el botón Publicar del cuadro de post." };
    }
    if (ready.status === "timeout_disabled") {
      return {
        ok: false,
        code: "submit_disabled",
        error: "El botón Publicar seguía desactivado. El grupo puede requerir responder preguntas o tener el posting restringido."
      };
    }

    const preApproval = detectApprovalRequirement(findComposerDialog());
    const beforeLinks = snapshotFeedPostLinks();
    const result = await clickAndVerify(ready.button);
    trace("clickAndVerify=" + JSON.stringify(result));
    if (!result.ok) return result;

    let postUrl = "";
    if (!result.pending) {
      await sleep(900);
      postUrl = findNewPostUrl(beforeLinks);
    }

    trace("POST OK");

    return {
      ok: true,
      pending: Boolean(result.pending),
      requiresApproval: Boolean(result.pending || preApproval),
      image: images.length > 0,
      url: postUrl || (location.origin + location.pathname)
    };
  }

  async function postToCurrentGroup(payload) {
    debugSteps = [];
    debugEnabled = Boolean(payload.options && payload.options.debug);
    try {
      const result = await postToCurrentGroupInner(payload);
      return { ...result, debug: debugSteps.slice() };
    } catch (error) {
      return {
        ok: false,
        error: String(error && error.message ? error.message : error),
        debug: debugSteps.slice()
      };
    }
  }

  /* ---------------- joined groups ---------------- */

  const GROUP_IGNORE = new Set([
    "feed",
    "discover",
    "joins",
    "create",
    "notifications",
    "categories",
    "chats",
    "saved",
    "manage",
    "membership_questions",
    "your_posts",
    "search",
    "your_groups",
    "invites",
    "suggested",
    "mine",
    "joined",
    "events",
    "polls",
    "videos",
    "albums"
  ]);

  function cleanGroupName(raw) {
    return String(raw || "")
      .split("\n")[0]
      .replace(/^(group|مجموعة|groupe|grupo):\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collectGroups(found) {
    const anchors = document.querySelectorAll('a[href*="/groups/"]');
    anchors.forEach((anchor) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const match = String(href).match(/(?:https?:\/\/[^/]+)?\/groups\/([a-zA-Z0-9._-]+)/i);
      if (!match) return;
      const id = match[1];
      if (!id || GROUP_IGNORE.has(id.toLowerCase())) return;

      let name = "";
      const titleNode = anchor.querySelector('span[dir="auto"], strong, h3, h4, span.x193iq5w');
      if (titleNode && titleNode.innerText) name = cleanGroupName(titleNode.innerText);
      if (!name) name = cleanGroupName(anchor.innerText || anchor.getAttribute("aria-label") || "");
      if (!name || name.length < 2) return;

      const lower = name.toLowerCase();
      if (
        lower === "groups" ||
        lower === "grupos" ||
        lower === "groupes" ||
        lower === "المجموعات" ||
        lower.includes("see all") ||
        lower.includes("ver todo") ||
        lower.includes("ver todos") ||
        lower.includes("عرض الكل") ||
        lower.includes("discover") ||
        lower.includes("descubrir") ||
        lower.includes("create new group") ||
        lower.includes("crear grupo")
      ) {
        return;
      }

      if (!found.has(id)) {
        found.set(id, {
          id,
          name,
          url: "https://www.facebook.com/groups/" + id + "/"
        });
      }
    });
  }

  async function scanJoinedGroups(payload = {}) {
    const maxRounds = Math.min(40, Math.max(1, Number(payload.rounds) || 28));
    const found = new Map();
    const scrollables = [
      window,
      document.scrollingElement,
      document.querySelector('div[role="navigation"] div[style*="overflow"]'),
      document.querySelector('div[role="navigation"]'),
      document.querySelector('div[data-pagelet*="LeftRail"]')
    ].filter(Boolean);
    let stable = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      const before = found.size;
      collectGroups(found);
      try {
        scrollables.forEach((node) => {
          if (node === window || node === document.scrollingElement) {
            window.scrollBy({ top: 900, behavior: "smooth" });
          } else if (typeof node.scrollBy === "function") {
            node.scrollBy({ top: 700, behavior: "smooth" });
          }
        });
      } catch {
        /* ignore */
      }
      await sleep(700 + Math.floor(Math.random() * 500));
      collectGroups(found);
      stable = found.size === before ? stable + 1 : 0;
      if (stable >= 3 && found.size) break;
    }

    try {
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {
      /* ignore */
    }

    if (!found.size) {
      const warning = detectWarning();
      if (warning) return { ok: false, checkpoint: true, error: warning };
    }

    return { ok: true, groups: Array.from(found.values()), rounds: maxRounds };
  }

  /* ---------------- share button + modal ---------------- */

  const SHARE_WORDS = [
    "share",
    "partager",
    "compartir",
    "condividi",
    "teilen",
    "delen",
    "مشاركة",
    "مشاركه",
    "repartir"
  ];

  const PRESETS = {
    maximum: { min: 90, max: 210, every: 6, pause: 12 },
    balanced: { min: 45, max: 100, every: 10, pause: 8 },
    turbo: { min: 25, max: 50, every: 15, pause: 5 }
  };

  let shareEnabled = true;
  let lastScan = 0;

  const storageLocal = () => (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null);

  function refreshShareSetting() {
    const area = storageLocal();
    if (!area || typeof area.get !== "function") return;
    try {
      area.get(["settings"], (data) => {
        const settings = (data && data.settings) || {};
        shareEnabled = settings.shareButton !== false;
        if (!shareEnabled) {
          document.querySelectorAll(".gp-share-btn").forEach((node) => node.remove());
        }
      });
    } catch {
      /* context invalidated */
    }
  }

  function findActionRow(button) {
    let node = button;
    for (let depth = 0; depth < 7 && node; depth += 1) {
      node = node.parentElement;
      if (!node) break;
      const buttons = node.querySelectorAll('[role="button"]');
      if (buttons.length >= 3) {
        const style = window.getComputedStyle(node);
        if (style.display.includes("flex") || style.display.includes("grid")) return node;
      }
    }
    return null;
  }

  function postPermalink(row) {
    const article =
      row.closest('div[role="article"]') ||
      row.closest('div[data-pagelet*="FeedUnit"]') ||
      row.parentElement;
    let fallback = location.origin + location.pathname;
    if (!article) return fallback;
    const anchors = article.querySelectorAll("a[href]");
    for (const anchor of anchors) {
      const href = anchor.href || "";
      if (
        href.includes("/posts/") ||
        href.includes("/permalink/") ||
        href.includes("story_fbid=") ||
        href.includes("/videos/")
      ) {
        try {
          const url = new URL(href);
          return url.origin + url.pathname;
        } catch {
          return href.split("?")[0];
        }
      }
    }
    return fallback;
  }

  /* Facebook sets aria-label on action buttons, but sometimes it is a longer
     sentence ("Send this to friends…") while the visible text is just
     "Share". Check both to stay locale- and layout-proof. */
  function matchesShare(node) {
    const aria = String(node.getAttribute("aria-label") || "")
      .toLowerCase()
      .trim();
    const text = String(node.innerText || node.textContent || "")
      .toLowerCase()
      .trim();
    return SHARE_WORDS.some((word) => {
      const hit = (value) => value === word || value.startsWith(word + " ") || value.endsWith(" " + word) || value.includes(" " + word + " ");
      return hit(aria) || hit(text);
    });
  }

  function injectShareButtons() {
    if (isWorker || !shareEnabled) return;
    if (Date.now() - lastScan < 400) return;
    lastScan = Date.now();

    const candidates = document.querySelectorAll('[role="button"][aria-label], [role="button"]');
    for (const node of candidates) {
      if (!matchesShare(node)) continue;
      if (node.closest("#gp-share-overlay")) continue;
      const row = findActionRow(node);
      if (!row || row.querySelector(".gp-share-btn")) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "gp-share-btn";
      button.title = "Compartir este post en varios grupos";
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z"/></svg><span>Grupos</span>';

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openShareModal(postPermalink(row));
      });

      node.parentElement.insertBefore(button, node.nextSibling);
    }
  }

  function ensureStyle() {
    /* .gp-share-btn styles now live in content/fb_ui.css */
  }

  async function readStore() {
    return new Promise((resolve) => {
      const area = storageLocal();
      if (!area || typeof area.get !== "function") return resolve({});
      try {
        area.get(["groups", "settings"], (data) => resolve(data || {}));
      } catch {
        resolve({});
      }
    });
  }

  async function openShareModal(postUrl) {
    closeShareModal();
    const data = await readStore();
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const settings = data.settings || {};
    const presetName = PRESETS[settings.safetyPreset] ? settings.safetyPreset : "balanced";
    const selected = new Set(groups.map((group) => group.id));

    const overlay = document.createElement("div");
    overlay.id = "gp-share-overlay";
    overlay.className = "gp-overlay";
    overlay.innerHTML = `
      <div class="gp-modal" role="dialog" aria-modal="true">
        <header class="gp-modal__head">
          <div>
            <h2>Compartir en grupos</h2>
            <p>Se publicará el enlace de este post con tu texto, en cada grupo seleccionado.</p>
          </div>
          <button type="button" class="gp-icon" data-close aria-label="Cerrar">✕</button>
        </header>
        <div class="gp-modal__body">
          <div class="gp-field">
            <label>Enlace del post</label>
            <input class="gp-input" data-url readonly>
          </div>
          <div class="gp-field">
            <label>Texto que acompaña al enlace <span class="gp-hint">(opcional, admite {A|B})</span></label>
            <textarea class="gp-textarea" data-caption placeholder="Mira esto, puede interesarte…"></textarea>
          </div>
          <div class="gp-row">
            <div class="gp-field gp-grow">
              <label>Filtrar grupos</label>
              <input class="gp-input" data-filter placeholder="Buscar…">
            </div>
            <div class="gp-field">
              <label>Ritmo</label>
              <select class="gp-input" data-preset>
                <option value="maximum">Máxima seguridad</option>
                <option value="balanced" selected>Balanceada</option>
                <option value="turbo">Turbo</option>
              </select>
            </div>
          </div>
          <div class="gp-groups" data-groups></div>
        </div>
        <footer class="gp-modal__foot">
          <span class="gp-count" data-count>0 grupos</span>
          <div class="gp-actions">
            <button type="button" class="gp-btn" data-close>Cancelar</button>
            <button type="button" class="gp-btn gp-btn--primary" data-start>Compartir</button>
          </div>
        </footer>
        <div class="gp-note" data-note hidden></div>
      </div>`;

    document.body.appendChild(overlay);

    const $ = (selector) => overlay.querySelector(selector);
    $("[data-url]").value = postUrl;
    $("[data-preset]").value = presetName;
    $("[data-count]").textContent = groups.length + " grupos";

    const note = (message, kind = "info") => {
      const box = $("[data-note]");
      box.hidden = false;
      box.textContent = message;
      box.className = "gp-note gp-note--" + kind;
    };

    const renderGroups = () => {
      const query = String($("[data-filter]").value || "").toLowerCase().trim();
      const list = groups.filter((group) => !query || String(group.name || "").toLowerCase().includes(query));
      const host = $("[data-groups]");
      if (!list.length) {
        host.innerHTML =
          '<div class="gp-empty">' +
          (groups.length
            ? "Ningún grupo coincide con la búsqueda."
            : 'No tienes grupos guardados. Ábrelos en la extensión → Grupos.') +
          "</div>";
        return;
      }
      host.innerHTML = list
        .map(
          (group) =>
            '<label class="gp-group"><input type="checkbox" value="' + escapeAttr(group.id) + '"' +
            (selected.has(group.id) ? " checked" : "") +
            "><span>" + escapeHtml(group.name) + "</span></label>"
        )
        .join("");
      host.querySelectorAll("input[type=checkbox]").forEach((box) => {
        box.addEventListener("change", () => {
          if (box.checked) selected.add(box.value);
          else selected.delete(box.value);
          updateCount();
        });
      });
    };

    const updateCount = () => {
      $("[data-count]").textContent = selected.size + " grupos";
      $("[data-start]").disabled = selected.size === 0;
    };

    $("[data-filter]").addEventListener("input", renderGroups);
    overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeShareModal));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeShareModal();
    });

    $("[data-start]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const preset = PRESETS[$("[data-preset]").value] || PRESETS.balanced;
      const caption = String($("[data-caption]").value || "").trim();
      const url = String($("[data-url]").value || "").trim();
      const chosen = groups.filter((group) => selected.has(group.id));
      if (!chosen.length) {
        note("Elige al menos un grupo.", "error");
        return;
      }
      const message = caption ? caption + "\n\n" + url : url;

      button.disabled = true;
      note("Iniciando campaña…");
      try {
        const response = await chrome.runtime.sendMessage({
          type: "gp:api",
          action: "run:start",
          payload: {
            campaign: {
              id: "",
              name: "Compartir: " + (document.title || "post").slice(0, 60),
              message,
              variations: [],
              minDelaySec: preset.min,
              maxDelaySec: preset.max,
              safetyEvery: preset.every,
              safetySec: preset.pause * 60,
              groupIds: chosen.map((group) => group.id)
            },
            groups: chosen
          }
        });
        if (!response || response.ok === false) {
          throw new Error((response && response.error) || "No se pudo iniciar la campaña.");
        }
        note("Campaña iniciada con " + chosen.length + " grupo(s). Puedes cerrar esta ventana.", "ok");
        setTimeout(closeShareModal, 2200);
      } catch (error) {
        button.disabled = false;
        note(String(error && error.message ? error.message : error), "error");
      }
    });

    renderGroups();
    updateCount();
  }

  function closeShareModal() {
    const overlay = document.getElementById("gp-share-overlay");
    if (overlay) overlay.remove();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  const escapeAttr = escapeHtml;

  let shareScanTimer = null;
  function scheduleShareScan(delay = 500) {
    if (isWorker || !shareEnabled) return;
    if (shareScanTimer) return;
    shareScanTimer = setTimeout(() => {
      shareScanTimer = null;
      if (!document.getElementById("gp-share-overlay")) injectShareButtons();
    }, delay);
  }

  function hasRelevantAddedNodes(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.id === "gp-share-overlay" || node.classList?.contains("gp-share-btn")) continue;
        return true;
      }
    }
    return false;
  }

  function bootShareUi() {
    if (isWorker) return;
    ensureStyle();
    refreshShareSetting();
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === "local" && changes.settings) refreshShareSetting();
        });
      }
    } catch {
      /* ignore */
    }
    setInterval(() => scheduleShareScan(0), 5000);
    setTimeout(injectShareButtons, 1200);
    const observer = new MutationObserver((mutations) => {
      if (document.getElementById("gp-share-overlay")) return;
      if (!hasRelevantAddedNodes(mutations)) return;
      scheduleShareScan(500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------- message router ---------------- */

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "gp:ui") return;
      const task = message.task;
      const payload = message.payload || {};

      const respond = (promise) => {
        promise.then(
          (data) => sendResponse(data),
          (error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) })
        );
        return true;
      };

      if (task === "configure") {
        isWorker = payload.role === "worker";
        try {
          if (isWorker) sessionStorage.setItem(WORKER_FLAG, "1");
          else sessionStorage.removeItem(WORKER_FLAG);
        } catch {
          /* ignore */
        }
        if (isWorker) {
          document.querySelectorAll(".gp-share-btn").forEach((node) => node.remove());
          closeShareModal();
        }
        return respond(Promise.resolve({ ok: true, worker: isWorker }));
      }
      if (task === "ping") {
        return respond(Promise.resolve({ ok: true, version: VERSION, href: location.href, worker: isWorker }));
      }
      if (task === "post") return respond(postToCurrentGroup(payload));
      if (task === "scanGroups") return respond(scanJoinedGroups(payload));
      if (task === "security") return respond(Promise.resolve({ ok: true, warning: detectWarning() }));

      return respond(Promise.resolve({ ok: false, error: "Tarea desconocida: " + task }));
    });
  } catch {
    /* extension reloaded under an existing tab */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootShareUi, { once: true });
  } else {
    bootShareUi();
  }
})();
