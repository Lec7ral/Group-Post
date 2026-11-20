/* Spintax and template variables.

   {Hola|Buenas|Qué tal} picks one option at random, and groups can be
   nested: {Hola|{Buenas|Qué tal}}. Variables are resolved before the
   spintax so a placeholder such as {group_name} never collides with a
   spintax block. */

const SPINTAX = /\{([^{}]*)\}/;
const MAX_PASSES = 400;

export const hasSpintax = (text) => /\{[^{}]+\|[^{}]*\}/.test(String(text || ""));

/* Resolves one random variant. Unknown single-option blocks are left as
   their content, which keeps plain text with braces readable. */
export function parseSpintax(input) {
  let text = String(input ?? "");
  if (!text.includes("{")) return text;
  let passes = 0;
  let match = SPINTAX.exec(text);
  while (match && passes < MAX_PASSES) {
    const options = match[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)] ?? "";
    text = text.slice(0, match.index) + chosen + text.slice(match.index + match[0].length);
    passes += 1;
    match = SPINTAX.exec(text);
  }
  return text;
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function injectVariables(input, variables = {}) {
  let text = String(input ?? "");
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null) continue;
    const pattern = new RegExp("\\{\\{\\s*" + escapeRegExp(key) + "\\s*\\}\\}|\\{\\s*" + escapeRegExp(key) + "\\s*\\}", "gi");
    text = text.replace(pattern, () => String(value));
  }
  const now = new Date();
  text = text
    .replace(/\{\{\s*today\s*\}\}|\{\s*today\s*\}/gi, () => now.toLocaleDateString())
    .replace(/\{\{\s*time\s*\}\}|\{\s*time\s*\}/gi, () => now.toLocaleTimeString());
  return text;
}

/* Variables first, spintax second. */
export function renderTemplate(input, variables = {}) {
  return parseSpintax(injectVariables(input, variables));
}

/* Counts how many distinct texts a template can produce, including nested
   blocks. {A|B} -> 2, {X{A|B}|Y} -> 3. Single-option blocks are unwrapped
   by parseSpintax, so they only contribute their inner count. */
function countIn(text) {
  let product = 1;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let last = i + 1;
    const parts = [];
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (ch === "|" && depth === 1) {
        parts.push(text.slice(last, j));
        last = j + 1;
      }
    }
    if (end === -1) {
      i += 1;
      continue;
    }
    parts.push(text.slice(last, end));
    if (parts.length === 1) {
      product *= countIn(parts[0]);
    } else {
      let combinations = 0;
      for (const part of parts) combinations += countIn(part);
      product *= Math.max(1, combinations);
    }
    if (product > 1000000) return 1000000;
    i = end + 1;
  }
  return product;
}

export function countVariations(input) {
  const total = countIn(String(input || ""));
  return Math.min(total, 1000000);
}
