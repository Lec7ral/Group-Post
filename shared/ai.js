/* Optional AI rewrite.

   Three selectable providers:
   - "worker": the Cloudflare worker from the reference repo
     (https://fb-smart-poster.0amaal89.workers.dev) with its own models and
     tone/style/language controls. Preconfigured by default.
   - "custom": any OpenAI-compatible /chat/completions endpoint configured by
     the user with their own URL and key.
   - "off": disabled.

   Nothing is sent anywhere unless the user turns the AI on. If the provider
   fails, the engine keeps the original text and local spintax. */

export const DEFAULT_WORKER_URL = "https://fb-smart-poster.0amaal89.workers.dev";

const SYSTEM_PROMPT = [
  "You rewrite Facebook group posts so each group gets a slightly different wording.",
  "Rules:",
  "- Keep the same language and dialect as the input. Never translate.",
  "- Preserve every URL, phone number, price, date and proper name exactly.",
  "- Keep it natural and conversational, no hashtags unless present.",
  "- Return only the rewritten post, with no quotes and no commentary."
].join("\n");

const WORKER_TONES = ["engaging", "enthusiastic", "professional", "casual"];
const WORKER_STYLES = ["moderate", "subtle", "creative"];
const WORKER_LANGUAGES = ["darija", "arabic", "french", "english", "auto"];

const endpointFor = (base) => {
  const value = String(base || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/\/chat\/completions$/i.test(value)) return value;
  return value + "/chat/completions";
};

const parseJson = (raw) => {
  const clean = String(raw || "").trim().replace(/^\s*for\s*\(;;\);/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const workerUrlFor = (settings) => {
  const value = String(settings.aiWorkerUrl || DEFAULT_WORKER_URL).trim().replace(/\/+$/, "");
  return value || DEFAULT_WORKER_URL;
};

export async function rewriteWithAi({ text, settings }) {
  const source = String(text || "").trim();
  if (!source) return { ok: false, error: "Texto vacío." };
  if (/^https?:\/\/[^\s]+$/i.test(source)) return { ok: true, text: source };
  const provider = String(settings.aiProvider || "worker");
  const enabled = settings.aiEnabled === true;

  if (provider === "off" || !enabled) {
    return { ok: false, error: "La IA está desactivada." };
  }

  if (provider === "worker") {
    const payload = {
      text: source,
      tone: String(settings.aiTone || "engaging"),
      style: String(settings.aiStyle || "moderate"),
      language: String(settings.aiLanguage || "darija")
    };
    let res;
    try {
      res = await fetch(workerUrlFor(settings) + "/api/ai/spin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      return { ok: false, error: "La petición a la IA falló: " + String(error && error.message ? error.message : error) };
    }
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, error: "El worker de IA respondió " + res.status + ": " + raw.slice(0, 160) };
    }
    const json = parseJson(raw);
    const variation = String((json && (json.variation || json.original)) || "").trim();
    if (!variation) return { ok: false, error: "El worker de IA devolvió una reescritura vacía." };
    return { ok: true, text: variation };
  }

  const url = endpointFor(settings.aiBaseUrl);
  if (!url) return { ok: false, error: "No hay endpoint de IA configurado." };

  const key = String(settings.aiApiKey || "").trim();
  const model = String(settings.aiModel || "").trim() || "gpt-4o-mini";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.85,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: source }
        ]
      })
    });
  } catch (error) {
    return { ok: false, error: "La petición a la IA falló: " + String(error && error.message ? error.message : error) };
  }

  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, error: "El endpoint de IA respondió " + res.status + ": " + raw.slice(0, 160) };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "El endpoint de IA no devolvió JSON." };
  }
  const choice = json && json.choices && json.choices[0];
  const content =
    (choice && choice.message && choice.message.content) ||
    (choice && choice.text) ||
    json.response ||
    (json.result && json.result.response) ||
    "";
  const clean = String(content).trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!clean) return { ok: false, error: "El endpoint de IA devolvió una reescritura vacía." };
  return { ok: true, text: clean };
}

export async function testAi(settings) {
  const result = await rewriteWithAi({ text: "Hola, prueba de conexión. Visita https://example.com", settings });
  return result;
}
