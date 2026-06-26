/**
 * THE FORGE OS — typed client for the AIbou Brain API.
 *
 * Contract (FastAPI backend):
 *   GET  /health         → { status: "ok" }
 *   POST /chat (SSE)     → streams `data: {"token":"..."}` then `data: {"done":true}`
 *                          (may also emit `data: {"error":"..."}`)
 *   POST /vision         → { text }
 *   POST /tts            → { audio_base64 }  (mp3 base64)
 *   GET  /income/summary → { pending, approved, ..., total } | {}
 *
 * Auth: if NEXT_PUBLIC_API_TOKEN is set, send `Authorization: Bearer <token>`.
 */

export const API_URL: string = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");
const API_TOKEN: string = process.env.NEXT_PUBLIC_API_TOKEN || "";

export type Role = "user" | "assistant";

export interface ChatTurn {
  role: Role;
  content: string;
}

export interface StreamChatParams {
  message: string;
  history?: ChatTurn[];
  persona?: string;
  name?: string;
}

export interface VisionParams {
  prompt: string;
  imageBase64: string;
  mime: string;
}

export interface TTSParams {
  text: string;
  voice?: string;
}

export interface IncomeSummary {
  pending?: number;
  approved?: number;
  rejected?: number;
  completed?: number;
  failed?: number;
  total?: number;
  [key: string]: number | undefined;
}

/** Build request headers, adding the bearer token when configured. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;
  return headers;
}

/** Throw a friendly error if the API base URL is missing. */
function requireApiUrl(): string {
  if (!API_URL) {
    throw new Error("NEXT_PUBLIC_API_URL is not set. Configure it in your environment (.env.local / Vercel).");
  }
  return API_URL;
}

/** GET /health — returns true when the backend reports ok. Never throws. */
export async function health(signal?: AbortSignal): Promise<boolean> {
  if (!API_URL) return false;
  try {
    const res = await fetch(`${API_URL}/health`, {
      method: "GET",
      signal,
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data?.status === "ok";
  } catch {
    return false;
  }
}

export interface StreamHandlers {
  /** Aborts the in-flight request. */
  cancel: () => void;
}

/**
 * POST /chat — read the SSE stream and surface tokens as they arrive.
 *
 * @param onToken called for each `{"token":"..."}` chunk.
 * @param onDone  called once when the stream ends (gracefully or via `{"done":true}`).
 *                Receives an error string if the backend emitted `{"error":"..."}`
 *                or the request failed.
 * @returns handlers with a `cancel()` to abort streaming.
 */
export function streamChat(
  params: StreamChatParams,
  onToken: (token: string) => void,
  onDone: (error?: string) => void,
): StreamHandlers {
  const controller = new AbortController();

  (async () => {
    let url: string;
    try {
      url = `${requireApiUrl()}/chat`;
    } catch (e) {
      onDone(e instanceof Error ? e.message : "Missing API URL");
      return;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
        body: JSON.stringify({
          message: params.message,
          history: params.history ?? [],
          persona: params.persona ?? undefined,
          name: params.name ?? undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        onDone(`Request failed (${res.status})`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let serverError: string | undefined;
      let done = false;

      // SSE: events are separated by a blank line; each line may start with "data: ".
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        // Handle both \n\n and \r\n\r\n event separators.
        while (
          (sepIndex = indexOfEventBoundary(buffer)) !== -1
        ) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex).replace(/^(\r?\n)+/, "");

          const payload = parseSSEData(rawEvent);
          if (payload == null) continue;

          if (typeof payload.token === "string") {
            onToken(payload.token);
          }
          if (typeof payload.error === "string") {
            serverError = payload.error;
          }
          if (payload.done === true) {
            done = true;
            break;
          }
        }
      }

      // Flush any trailing buffered event (no trailing blank line).
      if (!done && buffer.trim()) {
        const payload = parseSSEData(buffer);
        if (payload?.token) onToken(payload.token);
        if (typeof payload?.error === "string") serverError = payload.error;
      }

      onDone(serverError);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        onDone();
        return;
      }
      onDone(err instanceof Error ? err.message : "Stream failed");
    }
  })();

  return { cancel: () => controller.abort() };
}

/** Find the end of the first complete SSE event (\n\n or \r\n\r\n). */
function indexOfEventBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

interface SSEPayload {
  token?: string;
  done?: boolean;
  error?: string;
}

/** Parse the `data:` line(s) of one SSE event into JSON. */
function parseSSEData(rawEvent: string): SSEPayload | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("data:")) {
      dataParts.push(trimmed.slice(5).trimStart());
    }
  }
  if (dataParts.length === 0) return null;
  const joined = dataParts.join("\n").trim();
  if (!joined || joined === "[DONE]") return joined === "[DONE]" ? { done: true } : null;
  try {
    return JSON.parse(joined) as SSEPayload;
  } catch {
    return null;
  }
}

/** POST /vision — multimodal image understanding. Returns the model's text. */
export async function vision(params: VisionParams): Promise<string> {
  const res = await fetch(`${requireApiUrl()}/vision`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      prompt: params.prompt,
      image_base64: params.imageBase64,
      mime: params.mime,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error || `Vision failed (${res.status})`);
  }
  return data.text ?? "";
}

/** POST /tts — server-side text-to-speech. Returns base64-encoded mp3 (or ""). */
export async function tts(params: TTSParams): Promise<string> {
  const res = await fetch(`${requireApiUrl()}/tts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text: params.text, voice: params.voice }),
  });
  const data = (await res.json().catch(() => ({}))) as { audio_base64?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `TTS failed (${res.status})`);
  return data.audio_base64 ?? "";
}

/** GET /income/summary — status counts + total. Returns {} when unconfigured. */
export async function incomeSummary(): Promise<IncomeSummary> {
  const res = await fetch(`${requireApiUrl()}/income/summary`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Income summary failed (${res.status})`);
  return (await res.json().catch(() => ({}))) as IncomeSummary;
}

/* ---------------- Forge (creation) ---------------- */
export type ForgeKind = "app" | "image" | "slides" | "sheet" | "doc";

export interface ForgeResult {
  kind: string;
  code?: string;        // app
  csv?: string;         // sheet
  markdown?: string;    // slides | doc
  image_url?: string;   // image
  image_prompt?: string;
  note?: string;
  error?: string;
}

/** POST /forge/generate — generate an artifact (app/image/slides/sheet/doc). */
export async function forgeGenerate(kind: ForgeKind, prompt: string): Promise<ForgeResult> {
  const res = await fetch(`${requireApiUrl()}/forge/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ kind, prompt }),
  });
  const data = (await res.json().catch(() => ({}))) as ForgeResult;
  if (!res.ok && !data.error) throw new Error(`Forge failed (${res.status})`);
  return data;
}

/* ---------------- Income (Mission Control) ---------------- */
export interface IncomeJob {
  id?: string;
  theme?: string;
  status?: string;
  payload?: Record<string, unknown>;
  log?: string;
  created_at?: string;
  [key: string]: unknown;
}

/** GET /income/jobs — recent jobs (optionally filtered by status). */
export async function incomeJobs(status?: string, limit = 50): Promise<IncomeJob[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  q.set("limit", String(limit));
  const res = await fetch(`${requireApiUrl()}/income/jobs?${q.toString()}`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Jobs failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: IncomeJob[] };
  return data.items ?? [];
}

/** POST /income/enqueue — generate metadata for a theme and queue it as pending. */
export async function incomeEnqueue(theme: string): Promise<IncomeJob> {
  const res = await fetch(`${requireApiUrl()}/income/enqueue`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ theme }),
  });
  const data = (await res.json().catch(() => ({}))) as IncomeJob & { error?: string };
  if (!res.ok && !data.error) throw new Error(`Enqueue failed (${res.status})`);
  return data;
}

/** POST /income/approve | /income/reject */
export async function incomeSetStatus(id: string, action: "approve" | "reject"): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/income/${action}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id }),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}
