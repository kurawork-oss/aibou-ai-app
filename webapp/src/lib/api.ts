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

import { getAccessToken } from "@/lib/supabase";

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
  /** edge-tts rate string, e.g. "+0%", "-20%", "+30%". */
  rate?: string;
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
  // ログイン中は Supabase の JWT を優先（バンドル埋め込みトークン不要の実効認証）。
  const jwt = getAccessToken();
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  else if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;
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
  path = "/chat",
): StreamHandlers {
  const controller = new AbortController();

  (async () => {
    let url: string;
    try {
      url = `${requireApiUrl()}${path}`;
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
    body: JSON.stringify({ text: params.text, voice: params.voice, rate: params.rate }),
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

/* ---------------- Code (AI coding agent) ---------------- */
export interface CodeFile {
  path: string;
  content: string;
  action?: "create" | "update" | "delete";
}

export interface CodeEdit {
  path?: string;
  status?: "applied" | "failed";
  action?: string;
  reason?: string;
}

export interface CodeGenerateResult {
  explanation?: string;
  files?: CodeFile[];
  /** Per-edit results from the SEARCH/REPLACE diff engine. */
  edits?: CodeEdit[];
  error?: string;
}

/** POST /code/generate — run the coding agent over the workspace. */
export async function codeGenerate(
  instruction: string,
  files: CodeFile[],
  history: ChatTurn[] = [],
): Promise<CodeGenerateResult> {
  const res = await fetch(`${requireApiUrl()}/code/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ instruction, files, history }),
  });
  const data = (await res.json().catch(() => ({}))) as CodeGenerateResult;
  if (!res.ok && !data.error) throw new Error(`Code failed (${res.status})`);
  return data;
}

/** GET /code/scaffold — starter workspace (web | python | empty). */
export async function codeScaffold(kind: "web" | "python" | "empty"): Promise<CodeFile[]> {
  const res = await fetch(`${requireApiUrl()}/code/scaffold?kind=${kind}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({ files: [] }))) as { files?: CodeFile[] };
  return data.files ?? [];
}

/* ---------------- Life (ME mode — personal partner) ---------------- */
export interface LifeEntry {
  id: string;
  category: string;
  content: string;
  entry_date?: string;
  created_at?: string;
}

export interface LifeCategory { key: string; label: string }

/** POST /life/chat — consultation stream grounded in the experience box. */
export function streamLifeChat(
  params: StreamChatParams,
  onToken: (token: string) => void,
  onDone: (error?: string) => void,
): StreamHandlers {
  return streamChat(params, onToken, onDone, "/life/chat");
}

/** GET /life/entries — the experience box (optionally by category). */
export async function lifeEntries(category = ""): Promise<{ items: LifeEntry[]; categories: LifeCategory[] }> {
  const q = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await fetch(`${requireApiUrl()}/life/entries${q}`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Life entries failed (${res.status})`);
  return (await res.json().catch(() => ({ items: [], categories: [] }))) as { items: LifeEntry[]; categories: LifeCategory[] };
}

/** POST /life/entries — save one experience. */
export async function lifeAdd(category: string, content: string, entryDate = ""): Promise<LifeEntry> {
  const res = await fetch(`${requireApiUrl()}/life/entries`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ category, content, entry_date: entryDate }),
  });
  const data = (await res.json().catch(() => ({}))) as LifeEntry & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `Life add failed (${res.status})`);
  return data;
}

/** DELETE /life/entries/{id} */
export async function lifeDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/life/entries/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.ok;
}

/** POST /life/extract — propose box entries from recent consultation turns. */
export async function lifeExtract(turns: ChatTurn[]): Promise<{ category: string; content: string }[]> {
  const res = await fetch(`${requireApiUrl()}/life/extract`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ turns }),
  });
  const data = (await res.json().catch(() => ({}))) as { entries?: { category: string; content: string }[]; error?: string };
  if (data.error) throw new Error(data.error);
  return data.entries ?? [];
}

/* ---------------- GitHub (CODE mode integration) ---------------- */
export interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string;
  pushed_at: string;
}

/** GET /github/repos — repositories the token can access (newest first). */
export async function ghRepos(): Promise<GhRepo[]> {
  const res = await fetch(`${requireApiUrl()}/github/repos`, { headers: authHeaders(), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { items?: GhRepo[]; error?: string };
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`GitHub repos failed (${res.status})`);
  return data.items ?? [];
}

/** POST /github/import — pull a repo (or a folder of it) into a workspace. */
export async function ghImport(repo: string, ref = "", path = ""): Promise<{ repo: string; ref: string; files: CodeFile[]; skipped: number }> {
  const res = await fetch(`${requireApiUrl()}/github/import`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ repo, ref, path }),
  });
  const data = (await res.json().catch(() => ({}))) as { repo: string; ref: string; files: CodeFile[]; skipped: number; error?: string };
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`GitHub import failed (${res.status})`);
  return data;
}

/** POST /github/push — push workspace files to a new branch (+ open a PR). */
export async function ghPush(payload: {
  repo: string; base: string; branch: string; message: string;
  files: CodeFile[]; create_pr?: boolean; pr_title?: string;
}): Promise<{ ok?: boolean; branch?: string; commit?: string; pr_url?: string; note?: string }> {
  const res = await fetch(`${requireApiUrl()}/github/push`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ create_pr: true, ...payload }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; branch?: string; commit?: string; pr_url?: string; note?: string; error?: string };
  if (data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`GitHub push failed (${res.status})`);
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

/* ---------------- Document Vault (knowledge / RAG) ---------------- */
export interface VaultNotebook {
  id: string;
  name: string;
  doc_count?: number;
}

/** GET /vault/notebooks */
export async function vaultList(): Promise<VaultNotebook[]> {
  const res = await fetch(`${requireApiUrl()}/vault/notebooks`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Vault list failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: VaultNotebook[] };
  return data.items ?? [];
}

/** POST /vault/create */
export async function vaultCreate(name: string): Promise<VaultNotebook> {
  const res = await fetch(`${requireApiUrl()}/vault/create`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  const data = (await res.json().catch(() => ({}))) as VaultNotebook & { error?: string };
  if (!res.ok && !data.error) throw new Error(`Vault create failed (${res.status})`);
  return data;
}

/** POST /vault/add */
export async function vaultAddText(notebookId: string, title: string, content: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${requireApiUrl()}/vault/add`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, title, content }),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return { ok: Boolean(data.ok) };
}

/** POST /vault/query — RAG answer grounded in the notebook's docs. */
export async function vaultQuery(notebookId: string, question: string): Promise<{ answer: string }> {
  const res = await fetch(`${requireApiUrl()}/vault/query`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, question }),
  });
  const data = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
  if (!res.ok && !data.error) throw new Error(`Vault query failed (${res.status})`);
  return { answer: data.answer ?? data.error ?? "" };
}

/** POST /vault/generate — author a Markdown document grounded in the notebook. */
export async function vaultGenerateDoc(notebookId: string, instruction: string): Promise<{ markdown: string }> {
  const res = await fetch(`${requireApiUrl()}/vault/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, instruction }),
  });
  const data = (await res.json().catch(() => ({}))) as { markdown?: string; error?: string };
  if (!res.ok && !data.error) throw new Error(`Doc generation failed (${res.status})`);
  if (data.error) throw new Error(data.error);
  return { markdown: data.markdown ?? "" };
}

/** POST /vault/diagram — generate a Mermaid diagram (logic tree/flow/mindmap). */
export async function vaultGenerateDiagram(notebookId: string, kind = "tree"): Promise<{ mermaid: string; kind: string }> {
  const res = await fetch(`${requireApiUrl()}/vault/diagram`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, kind }),
  });
  const data = (await res.json().catch(() => ({}))) as { mermaid?: string; kind?: string; error?: string };
  if (!res.ok && !data.error) throw new Error(`Diagram generation failed (${res.status})`);
  if (data.error) throw new Error(data.error);
  return { mermaid: data.mermaid ?? "", kind: data.kind ?? kind };
}

/* ---------------- Tasks (Active Tasks) ---------------- */
export interface Task {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "awaiting_approval" | "completed" | "cancelled";
  content?: string;
  response?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** GET /tasks — list tasks. */
export async function listTasks(status?: string, limit = 100): Promise<Task[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  q.set("limit", String(limit));
  const res = await fetch(`${requireApiUrl()}/tasks?${q}`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Tasks failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: Task[] };
  return data.items ?? [];
}

/** POST /tasks — create a new task. */
export async function createTask(title: string, content = "", status = "pending"): Promise<Task> {
  const res = await fetch(`${requireApiUrl()}/tasks`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, content, status }),
  });
  const data = (await res.json().catch(() => ({}))) as Task & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Create task failed (${res.status})`);
  return data;
}

/** PATCH /tasks/{id} — update task. */
export async function updateTask(id: string, updates: { status?: string; response?: string; content?: string }): Promise<Task> {
  const res = await fetch(`${requireApiUrl()}/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  const data = (await res.json().catch(() => ({}))) as Task & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Update task failed (${res.status})`);
  return data;
}

/** DELETE /tasks/{id} — delete a task. */
export async function deleteTask(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- Studio (Custom AI + Workflows) ---------------- */
export interface StudioAI {
  id: string;
  name: string;
  persona?: string;
  model?: string;
  rules?: string;
  created_at?: string;
}

export interface WorkflowStep {
  name?: string;
  prompt: string;
}

export interface StudioWorkflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  created_at?: string;
}

export interface WorkflowResult {
  workflow_id: string;
  workflow_name: string;
  results: Array<{ step: number; name: string; output: string }>;
  final_output: string;
}

export async function studioListAIs(): Promise<StudioAI[]> {
  const res = await fetch(`${requireApiUrl()}/studio/ais`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Studio AIs failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: StudioAI[] };
  return data.items ?? [];
}

export async function studioCreateAI(ai: { name: string; persona?: string; model?: string; rules?: string }): Promise<StudioAI> {
  const res = await fetch(`${requireApiUrl()}/studio/ais`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(ai),
  });
  const data = (await res.json().catch(() => ({}))) as StudioAI & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Create AI failed (${res.status})`);
  return data;
}

export async function studioDeleteAI(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/studio/ais/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  return res.ok;
}

export async function studioListWorkflows(): Promise<StudioWorkflow[]> {
  const res = await fetch(`${requireApiUrl()}/studio/workflows`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Workflows failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: StudioWorkflow[] };
  return data.items ?? [];
}

export async function studioCreateWorkflow(name: string, steps: WorkflowStep[]): Promise<StudioWorkflow> {
  const res = await fetch(`${requireApiUrl()}/studio/workflows`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, steps }),
  });
  const data = (await res.json().catch(() => ({}))) as StudioWorkflow & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Create workflow failed (${res.status})`);
  return data;
}

export async function studioDeleteWorkflow(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/studio/workflows/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  return res.ok;
}

export async function studioRunWorkflow(id: string, input = ""): Promise<WorkflowResult> {
  const res = await fetch(`${requireApiUrl()}/studio/workflows/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ input }),
  });
  const data = (await res.json().catch(() => ({}))) as WorkflowResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Run workflow failed (${res.status})`);
  return data;
}

/* ---------------- Video ---------------- */
export interface VideoResult {
  video_base64?: string;
  error?: string;
}

export interface VideoScene {
  narration: string;
  visual?: string;
}

/** POST /video — render an MP4 from image+narration scenes (ffmpeg backend). */
export async function videoGenerate(scenes: VideoScene[], imagePrompt = ""): Promise<VideoResult> {
  const res = await fetch(`${requireApiUrl()}/video`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ scenes, image_prompt: imagePrompt }),
  });
  const data = (await res.json().catch(() => ({}))) as VideoResult;
  if (!res.ok && !data.error) return { error: `Video failed (${res.status})` };
  return data;
}

/* ---------------- Autopilot (goal-based autonomous missions) ---------------- */
export interface MissionStep {
  n: number;
  title: string;
  status: "pending" | "done" | "failed";
  result?: string;
}

export interface Mission {
  id: string;
  goal: string;
  status: "active" | "completed" | "failed" | "paused";
  steps: MissionStep[];
  current: number;
  log?: string[];
  notify?: boolean;
  created_at?: string;
}

export interface StepResult {
  mission?: Mission;
  done?: boolean;
  step?: MissionStep;
  error?: string;
  message?: string;
}

export async function autopilotList(): Promise<Mission[]> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Missions failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: Mission[] };
  return data.items ?? [];
}

export async function autopilotCreate(goal: string, notify = true): Promise<Mission> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ goal, notify }),
  });
  const data = (await res.json().catch(() => ({}))) as Mission & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Create mission failed (${res.status})`);
  return data;
}

export async function autopilotStep(id: string): Promise<StepResult> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions/${encodeURIComponent(id)}/step`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
  });
  const data = (await res.json().catch(() => ({}))) as StepResult;
  if (!res.ok && !data.mission) throw new Error(data.error ?? `Step failed (${res.status})`);
  return data;
}

export async function autopilotDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/** POST /notify — send a test/manual notification to configured channels. */
export async function sendNotify(message: string): Promise<{ ok: boolean; sent?: string[]; skipped?: boolean }> {
  const res = await fetch(`${requireApiUrl()}/notify`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message }),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean; sent?: string[]; skipped?: boolean };
  if (!res.ok) throw new Error(`Notify failed (${res.status})`);
  return { ok: Boolean(data.ok), sent: data.sent, skipped: data.skipped };
}

/* ---------------- Automations (no-code flows / Zapier-style) ---------------- */
export type StepType = "ai_generate" | "notify" | "create_task";

export interface AutomationStep {
  id?: string;
  n?: number;
  type: StepType;
  name?: string;
  params?: Record<string, string>;
}

export interface Automation {
  id: string;
  name: string;
  enabled?: boolean;
  trigger?: { type: string; config?: Record<string, unknown> };
  steps: AutomationStep[];
  status?: string;
  created_at?: string;
}

export interface AutomationRunResult {
  automation_id: string;
  name: string;
  results: Array<{ step: number; name: string; type: string; ok: boolean; output: string; error?: string }>;
  final_output: string;
}

export async function automationsList(): Promise<Automation[]> {
  const res = await fetch(`${requireApiUrl()}/automations`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Automations failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: Automation[] };
  return data.items ?? [];
}

export async function automationsCreate(name: string, steps: AutomationStep[], trigger?: { type: string }): Promise<Automation> {
  const res = await fetch(`${requireApiUrl()}/automations`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, steps, trigger }),
  });
  const data = (await res.json().catch(() => ({}))) as Automation & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Create automation failed (${res.status})`);
  return data;
}

export async function automationsDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/automations/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

export async function automationsRun(id: string, input = ""): Promise<AutomationRunResult> {
  const res = await fetch(`${requireApiUrl()}/automations/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ input }),
  });
  const data = (await res.json().catch(() => ({}))) as AutomationRunResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Run automation failed (${res.status})`);
  return data;
}

/* ---------------- Home / Agenda / Notifications (personal cockpit) ---------------- */
export interface AgendaEvent {
  id: string;
  title: string;
  date?: string;
  time?: string;
  note?: string;
}

export interface AppNotification {
  id: string;
  message: string;
  channel?: string;
  read?: boolean;
  created_at?: string;
}

export interface HomeSummary {
  tasks: { total: number; by_status: Record<string, number>; open: number };
  missions: { total: number; active: number };
  automations: { total: number };
  income: { pending: number };
  events: { total: number; upcoming: AgendaEvent[] };
  notifications: { unread: number };
}

export async function homeSummary(): Promise<HomeSummary> {
  const res = await fetch(`${requireApiUrl()}/home/summary`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Home summary failed (${res.status})`);
  const empty: HomeSummary = {
    tasks: { total: 0, by_status: {}, open: 0 },
    missions: { total: 0, active: 0 },
    automations: { total: 0 },
    income: { pending: 0 },
    events: { total: 0, upcoming: [] },
    notifications: { unread: 0 },
  };
  return (await res.json().catch(() => empty)) as HomeSummary;
}

export async function agendaList(): Promise<AgendaEvent[]> {
  const res = await fetch(`${requireApiUrl()}/agenda`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Agenda failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: AgendaEvent[] };
  return data.items ?? [];
}

export async function agendaAdd(title: string, date = "", time = "", note = ""): Promise<AgendaEvent> {
  const res = await fetch(`${requireApiUrl()}/agenda`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, date, time, note }),
  });
  const data = (await res.json().catch(() => ({}))) as AgendaEvent & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Add event failed (${res.status})`);
  return data;
}

/** Natural-language → parsed event ("明日15時に歯医者"). */
export async function agendaParse(text: string, today = ""): Promise<AgendaEvent> {
  const res = await fetch(`${requireApiUrl()}/agenda/parse`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text, today }),
  });
  const data = (await res.json().catch(() => ({}))) as AgendaEvent & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Parse event failed (${res.status})`);
  return data;
}

export async function agendaDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/agenda/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

export async function notificationsList(): Promise<{ items: AppNotification[]; unread: number }> {
  const res = await fetch(`${requireApiUrl()}/notifications`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Notifications failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [], unread: 0 }))) as { items?: AppNotification[]; unread?: number };
  return { items: data.items ?? [], unread: data.unread ?? 0 };
}

export async function notificationsMarkRead(): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/notifications/read`, { method: "POST", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- Evolve (self-evolution: instruction → proposal) ---------------- */
export type EvolveType = "app" | "custom_ai" | "automation" | "answer";

export interface EvolveProposal {
  type: EvolveType;
  summary: string;
  params: Record<string, unknown>;
  raw?: string;
}

/** POST /evolve/propose — turn a natural-language wish into a buildable proposal. */
export async function evolvePropose(instruction: string): Promise<EvolveProposal> {
  const res = await fetch(`${requireApiUrl()}/evolve/propose`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ instruction }),
  });
  const data = (await res.json().catch(() => ({}))) as EvolveProposal & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `Evolve failed (${res.status})`);
  return data;
}

/* ---------------- Keychain (API key vault) ---------------- */
export interface ApiKeyInfo {
  name: string;
  label?: string;
  hint?: string;
  masked: string;
  set: boolean;
}

/** GET /keys — masked list of known + stored API keys (full values never returned). */
export async function listKeys(): Promise<ApiKeyInfo[]> {
  const res = await fetch(`${requireApiUrl()}/keys`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Keys failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: ApiKeyInfo[] };
  return data.items ?? [];
}

/** POST /keys — store/update a key. */
export async function setKey(name: string, value: string): Promise<{ ok: boolean; masked?: string }> {
  const res = await fetch(`${requireApiUrl()}/keys`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, value }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; masked?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Set key failed (${res.status})`);
  return { ok: Boolean(data.ok), masked: data.masked };
}

/** DELETE /keys/{name} — remove a stored key. */
export async function deleteKey(name: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/keys/${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- Proactive ---------------- */
/** GET /briefing — today's proactive briefing text. */
export async function getBriefing(): Promise<{ text: string }> {
  const res = await fetch(`${requireApiUrl()}/briefing`, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  if (!res.ok) throw new Error(`Briefing failed (${res.status})`);
  return { text: data.text ?? "" };
}
