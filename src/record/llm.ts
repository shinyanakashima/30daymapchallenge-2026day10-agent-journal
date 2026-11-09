// OpenAI Chat Completions, called directly from this browser with the user's own key.
// The key is kept in localStorage on this device only. It is never written to the journal.
const KEY_STORAGE = 'day10-openai-key';
const MODEL_STORAGE = 'day10-openai-model';
const API = 'https://api.openai.com/v1';

export function loadKey(): string {
  try { return localStorage.getItem(KEY_STORAGE) ?? ''; } catch { return ''; }
}
export function saveKey(key: string) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* storage unavailable */ }
}
export function forgetKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}
export function loadModel(): string {
  try { return localStorage.getItem(MODEL_STORAGE) ?? ''; } catch { return ''; }
}
export function saveModel(m: string) {
  try { localStorage.setItem(MODEL_STORAGE, m); } catch { /* ignore */ }
}

async function call(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body?.error?.message ?? res.statusText}`);
  return body;
}

const NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|dall-e|image|embedding|moderation|search|davinci|babbage|instruct)/;

/** Chat-capable model IDs available to this key, newest names first. */
export async function listModels(key: string): Promise<string[]> {
  const body = await call('/models', key);
  const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
  return ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id)).sort().reverse();
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ChatResult = { content: string; model: string; usage: unknown };

export async function chat(key: string, model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<ChatResult> {
  const body = await call('/chat/completions', key, { method: 'POST', body: JSON.stringify({ model, messages }), signal });
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('The model returned no text.');
  return { content, model: body.model ?? model, usage: body.usage ?? null };
}

export const SYSTEM_PROMPT = `You are making a static map together with the user, one step at a time.

The map is drawn by one JavaScript file, map/main.js. It runs as the body of an async function with these variables:
- d3: D3 v7
- svg: a d3 selection of an empty <svg> that is 1200 × 900 px
- width = 1200, height = 900
- data: an object keyed by file path (for example data["data/towns.geojson"]). JSON and GeoJSON are parsed objects; CSV and TSV are arrays from d3.csvParse with d3.autoType; other files are strings.

Rules:
- Draw everything inside svg. Use SVG only (no canvas, no HTML elements, no external images).
- The code cannot load anything from the network. Use only the files in data.
- Use inline attributes or a <style> element inside the svg. Use system fonts (for example "sans-serif").
- Keep the map extent the same between steps unless the user asks to change it.
- Fill the background yourself if you want a colour other than white.

Reply in this format:
Summary (en): one short sentence on what changed
Summary (ja): the same in Japanese
Then a short explanation, then the complete new map/main.js in a single \`\`\`js code block.
If no code change is needed, give the summaries and the explanation without a code block.`;

/** The user turn sent to the model: the prompt plus the current code and a list of data files. */
export function contextMessage(prompt: string, code: string, files: { path: string; size: number; preview: string }[]): string {
  const list = files.length
    ? files.map((f) => `- ${f.path} (${f.size.toLocaleString('en')} bytes)\n  ${f.preview.replace(/\n/g, '\n  ')}`).join('\n')
    : '- (no data files)';
  return `${prompt}

---
Current map/main.js:
\`\`\`js
${code}
\`\`\`

Data files:
${list}`;
}

export function parseReply(text: string): { code: string | null; summaryEn: string | null; summaryJa: string | null } {
  const blocks = [...text.matchAll(/```(?:js|javascript|mjs)?[ \t]*\n([\s\S]*?)```/g)];
  const code = blocks.length ? blocks[blocks.length - 1][1].replace(/\s+$/, '') + '\n' : null;
  const en = text.match(/^\s*\**Summary \(en\)\**\s*[:：]\s*(.+)$/im)?.[1]?.trim() ?? null;
  const ja = text.match(/^\s*\**Summary \(ja\)\**\s*[:：]\s*(.+)$/im)?.[1]?.trim() ?? null;
  return { code, summaryEn: en, summaryJa: ja };
}

/** Earlier assistant replies are sent back with their code blocks shortened, to keep requests small. */
export function shortenCode(text: string): string {
  return text.replace(/```(?:js|javascript|mjs)?[ \t]*\n[\s\S]*?```/g, '```js\n// (code from this step omitted; the current file is sent below)\n```');
}
