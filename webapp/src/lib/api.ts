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

import { asArray, asNumber } from "@/lib/shape";

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
  /** edge-tts pitch string, e.g. "+0Hz", "-20Hz". */
  pitch?: string;
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
/**
 * 「通してよいか（通行証）」と「誰か（本人確認）」は別物として送る。
 *
 * 以前はログインすると Authorization を JWT で上書きしていた。サーバーが
 * SUPABASE_JWT_SECRET を持たない構成では JWT を検証できないため、
 * それまで通っていた共通トークンを捨てた結果「ログインした瞬間に全部401」に
 * なった（実際に踏んだ）。
 *
 * そこで、確実に通る資格情報があるならそれを Authorization に残し、
 * 本人確認は別のヘッダで渡す。サーバーの設定がどの段階でも動く。
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const jwt = getAccessToken();

  if (API_TOKEN) {
    headers["Authorization"] = `Bearer ${API_TOKEN}`;   // 通行証（確実に通る）
    if (jwt) headers["X-Supabase-Token"] = jwt;         // 誰か（利用者ごとの分離用）
  } else if (jwt) {
    headers["Authorization"] = `Bearer ${jwt}`;         // 通行証も本人確認もJWT
  }
  return headers;
}

/** Throw a friendly error if the API base URL is missing. */
function requireApiUrl(): string {
  if (!API_URL) {
    throw new Error("NEXT_PUBLIC_API_URL is not set. Configure it in your environment (.env.local / Vercel).");
  }
  return API_URL;
}

/**
 * 失敗した応答を、画面が見ている形（`{ error }`）に揃える。
 *
 * なぜ要るか
 * ----------
 * サーバー（FastAPI）は失敗を `{"detail": "…"}` で返す。ところが画面の
 * 多くは `.error` だけを見て、無ければ成功として扱っていた。つまり
 *
 *   POST /vault/upload → 409 {"detail": "保存先がつながっていないため…"}
 *   画面 → 「✓ a.txt を取り込みました（0字）」
 *
 * サーバーは正しく断り、理由まで書いているのに、画面が「入りました」と
 * 言っていた。本物のバックエンドで再現して確かめた。同じ形が9か所
 * あった（資料・LP・スライド修正・ナレーション・DB移行・HFモデル…）。
 *
 * ここで揃えるので、呼ぶ側は今まで通り `.error` を見ればよい。
 * 直し方を1か所にしたのは、同じ間違いが今後も足されるため——
 * 呼ぶ側の作法を変えるより、返す形を正しくするほうが崩れない。
 */
/**
 * 応答の中から「サーバーが書いた理由」を取り出す。
 *
 * FastAPI は `{"detail": …}`、こちらで足した口は `{"error": …}` を返す。
 * どちらか片方しか見ないと、たとえば
 *
 *   409 {"detail": "保存先がつながっていないため…接続してください。"}
 *   → 画面「Create mission failed (409)」
 *
 * のように、次の手が書いてある文を捨てて英字だけを残すことになる。
 */
function reason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const d = body as Record<string, unknown>;
  const v = d.error ?? d.detail;
  if (typeof v === "string" && v.trim()) return v;
  // FastAPI の入力検査は配列で返る。そのまま出しても読めない。
  if (Array.isArray(v)) return "送った内容の形が正しくありません";
  return undefined;
}

async function failable<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) {
    // 200 なのに中身が読めない＝壊れた応答。成功として通さない。
    if (body === null) return { error: `${fallback}（応答を読めませんでした）` } as T;
    return body as T;
  }
  const detail = body?.detail ?? body?.error;
  const msg =
    typeof detail === "string" && detail.trim() ? detail
      // FastAPI の入力検査は配列で返る。そのまま出しても読めない。
      : Array.isArray(detail) ? "送った内容の形が正しくありません"
        : `${fallback}（${res.status}）`;
  return { ...(body ?? {}), error: msg } as T;
}

/**
 * GET /diagnose — うまく動かないときに、サーバー自身に理由を答えさせる。
 *
 * 認証不要。ログインしている場合はその資格情報も一緒に送るので、
 * 「なぜ通らないのか」までサーバー側が判断して返してくれる。
 * 中身は人が読む前提の日本語キーなので、型は決め打ちにせず素直に扱う。
 */
export async function diagnose(): Promise<Record<string, unknown>> {
  const res = await fetch(`${requireApiUrl()}/diagnose`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Diagnose failed (${res.status})`);
  return (await res.json()) as Record<string, unknown>;
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

/** Parse one SSE event's `data:` line(s) into an arbitrary JSON object. */
function parseSSEJson(rawEvent: string): Record<string, unknown> | null {
  const parts: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("data:")) parts.push(t.slice(5).trimStart());
  }
  const joined = parts.join("\n").trim();
  if (!joined) return null;
  try { return JSON.parse(joined) as Record<string, unknown>; } catch { return null; }
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
    throw new Error(reason(data) ?? `Vision failed (${res.status})`);
  }
  return data.text ?? "";
}

/** POST /tts — server-side text-to-speech. Returns base64-encoded mp3 (or ""). */
export async function tts(params: TTSParams): Promise<string> {
  const res = await fetch(`${requireApiUrl()}/tts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      text: params.text, voice: params.voice, rate: params.rate, pitch: params.pitch,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { audio_base64?: string; error?: string };
  if (!res.ok) throw new Error(reason(data) ?? `TTS failed (${res.status})`);
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
export interface CodeProgress {
  phase: string;
  detail?: string;
  plan?: string;
  provider?: string;
}

/** POST /code/generate (SSE) — streams live progress phases then the result. */
export function codeGenerateStream(
  instruction: string,
  files: CodeFile[],
  history: ChatTurn[],
  depth: "normal" | "deep",
  onProgress: (p: CodeProgress) => void,
  onDone: (result: CodeGenerateResult) => void,
): StreamHandlers {
  const controller = new AbortController();
  (async () => {
    let url: string;
    try { url = `${requireApiUrl()}/code/generate`; } catch (e) {
      onDone({ error: e instanceof Error ? e.message : "Missing API URL" });
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify({ instruction, files, history, depth }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) { onDone({ error: `Code failed (${res.status})` }); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = indexOfEventBoundary(buffer)) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
          const ev = parseSSEJson(rawEvent) as (CodeProgress & CodeGenerateResult) | null;
          if (!ev) continue;
          if (ev.phase === "done") {
            onDone({ explanation: ev.explanation, files: ev.files, edits: ev.edits });
            finished = true; break;
          } else if (ev.phase === "error") {
            onDone({ error: ev.error });
            finished = true; break;
          } else {
            onProgress(ev);
          }
        }
      }
      if (!finished) onDone({ error: "ストリームが途中で終了しました" });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") { onDone({}); return; }
      onDone({ error: err instanceof Error ? err.message : "Stream failed" });
    }
  })();
  return { cancel: () => controller.abort() };
}

/* ---------------- HOME agent (手足となって動く) ---------------- */
/**
 * 道具が「作った物」。会話の隣（キャンバス）に出すためのもの。
 *
 * 道具の戻り値（文字列）とは役目が違う。あちらはAIに読ませる文章、
 * こちらは人に見せる物。作った画像も資料も検索結果も、これまでは
 * 文字列の中のURLでしかなく、「HOMEの生成物から見てください」と
 * 案内するだけだった。
 */
export interface MadeItem {
  kind: "image" | "document" | "slides" | "table" | "search" | "page" | "diagram" | "link";
  title?: string;
  /** image / page / link */
  url?: string;
  /** document / table … 中身そのもの（Markdown・CSV） */
  content?: string;
  /** document / slides / table … 保存された生成物のID（開き直せる） */
  artifact_id?: string;
  /** slides */
  deck?: SlideDeck;
  /** search */
  query?: string;
  results?: { title: string; url: string; snippet: string }[];
  /** page … 読み取った本文 */
  text?: string;
  /** diagram … mermaid の記法 */
  source?: string;
  /** link … どこに出来たか（Googleドキュメント等） */
  where?: string;
}

export interface AgentEvent {
  phase: "start" | "prepare" | "thinking" | "tool" | "observation" | "approval"
    | "setup_required" | "show" | "final" | "done" | "error";
  step?: number;
  tool?: string;
  params?: Record<string, unknown>;
  note?: string;
  result?: string;
  text?: string;
  detail?: string;
  steps?: number;
  awaiting_approval?: boolean;
  /** prepare のとき、何の準備だったか（記憶の読み込み・指示文の組み立てなど）。 */
  what?: string;
  /** 直前のイベントからの経過ミリ秒＝その工程にかかった時間。 */
  ms?: number;
  /** 開始からの合計ミリ秒。 */
  total_ms?: number;

  /* ── approval のとき ── */
  /** 危なさ（0 読むだけ / 1 中が変わる / 2 外に残る / 3 取り返せない）。 */
  level?: number;
  level_label?: string;
  /** 何が起きるのか（「送ったメールは取り消せません」など）。 */
  why?: string;
  /** 承認モードを切っていても必ず聞く操作か。 */
  always_confirm?: boolean;
  /**
   * 危なさではなく「連鎖」で聞いているか。
   *
   * すでに外のページを読んだ後は、次に読むURLがそのページに書かれていた
   * ものかもしれない。読むだけの操作なのに確認が出る理由がこれ。
   */
  chained?: boolean;

  /* ── setup_required のとき ── */
  /** 足りない連携（google / slack / notion / github）。 */
  provider?: string;
  label?: string;
  /** 同意画面へ向かう入口。 */
  connect_path?: string;
  can_connect?: boolean;
  /** 持ち主のアプリ登録がまだで、利用者では繋げない。 */
  needs_owner?: boolean;
  /** 連携待ちで止まっている（用事は預けてある）。 */
  awaiting_setup?: boolean;

  /* ── show のとき ── */
  /** その手で出来た物（画像・資料・検索結果など）。 */
  item?: MadeItem;
}

/**
 * POST /agent/act (SSE) — the HOME agent runs a plan→act→observe loop and
 * streams each step (thinking / tool / observation) then a final report.
 * onEvent fires for every phase; onDone fires once when the stream closes.
 */
export function agentActStream(
  instruction: string,
  history: ChatTurn[],
  name: string | undefined,
  approval: boolean,
  onEvent: (ev: AgentEvent) => void,
  onDone: (error?: string) => void,
): StreamHandlers {
  const controller = new AbortController();
  (async () => {
    let url: string;
    try { url = `${requireApiUrl()}/agent/act`; } catch (e) {
      onDone(e instanceof Error ? e.message : "Missing API URL");
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify({ instruction, history, name, approval }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) { onDone(`Agent failed (${res.status})`); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      let serverError: string | undefined;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = indexOfEventBoundary(buffer)) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
          const ev = parseSSEJson(rawEvent) as AgentEvent | null;
          if (!ev) continue;
          onEvent(ev);
          if (ev.phase === "error" && typeof ev.detail === "string") serverError = ev.detail;
          if (ev.phase === "done") { finished = true; break; }
        }
      }
      onDone(serverError);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") { onDone(); return; }
      onDone(err instanceof Error ? err.message : "Stream failed");
    }
  })();
  return { cancel: () => controller.abort() };
}

/** POST /agent/execute — run a single approved tool (approval-mode confirm). */
export async function agentExecute(
  tool: string, params: Record<string, unknown>,
): Promise<{ result: string; show: MadeItem[] }> {
  const res = await fetch(`${requireApiUrl()}/agent/execute`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ tool, params }),
  });
  const data = (await res.json().catch(() => ({}))) as
    { result?: string; show?: MadeItem[] };
  // 承認して実行した物も、そのまま隣に出す（押したあとに行き先を探させない）
  return { result: data.result ?? "", show: asArray<MadeItem>(data.show) };
}

/* ---------------- CAPTURE: 文字起こし / ナレーション ---------------- */
export interface CaptureStatus {
  ffmpeg: boolean;
  transcribe: boolean;      // 文字起こしが使えるか（ffmpeg + Gemini または HFのASRモデル）
  narrate: boolean;
  voiceover: boolean;
  styles: { key: string; label: string }[];
  max_mb: number;
  engines?: { gemini: boolean; hf: boolean };
  asr_model?: string;       // HFに割り当てた文字起こしモデル（未設定なら空）
}

/** GET /capture/status — この環境で何ができるか。 */
export async function captureStatus(): Promise<CaptureStatus> {
  const res = await fetch(`${requireApiUrl()}/capture/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Capture status failed (${res.status})`);
  return (await res.json()) as CaptureStatus;
}

/** POST /capture/transcribe — 録画/録音を文字起こしする（サーバーで音声抽出）。
 *  engine: auto（既定・HFにASRを割り当ててあればHF）/ gemini / hf。 */
export async function captureTranscribe(blob: Blob, name = "rec.webm", engine = "auto"):
  Promise<{ ok?: boolean; text?: string; seconds?: number; truncated?: boolean;
            engine?: string; model?: string; error?: string }> {
  const form = new FormData();
  form.append("file", blob, name);
  form.append("engine", engine);
  const res = await fetch(`${requireApiUrl()}/capture/transcribe`, {
    method: "POST", headers: authHeaders(), body: form,
  });
  return failable(res, "文字起こしに失敗しました");
}

/** POST /capture/narrate — 文字起こし/メモから読み上げ台本を作る。 */
export async function captureNarrate(opts: {
  source: string; style?: string; seconds?: number; instruction?: string;
}): Promise<{ ok?: boolean; script?: string; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/capture/narrate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      source: opts.source, style: opts.style ?? "explain",
      seconds: Math.round(opts.seconds ?? 0), instruction: opts.instruction ?? "",
    }),
  });
  return failable(res, "台本の生成に失敗しました");
}

/** POST /capture/voiceover — 台本を読み上げて録画に重ねた mp4 を返す。 */
export async function captureVoiceover(opts: {
  blob: Blob; script: string; keepOriginal?: boolean; name?: string;
}): Promise<{ ok?: boolean; video_base64?: string; seconds?: number; mixed?: boolean; error?: string }> {
  const form = new FormData();
  form.append("file", opts.blob, opts.name ?? "rec.webm");
  form.append("script", opts.script);
  form.append("keep_original", opts.keepOriginal ? "1" : "0");
  const res = await fetch(`${requireApiUrl()}/capture/voiceover`, {
    method: "POST", headers: authHeaders(), body: form,
  });
  return failable(res, "ナレーションの合成に失敗しました");
}

/* ---------------- CODE: server-side command run (opt-in) ---------------- */
export interface ShellStatus {
  enabled: boolean;
  allowed: string[];
  timeout_default: number;
  timeout_max: number;
  note?: string;
}
export interface ShellResult {
  ok?: boolean; code?: number; stdout?: string; stderr?: string;
  truncated?: boolean; timed_out?: boolean; cmd?: string; seconds?: number;
  files?: number; error?: string;
}

/** GET /code/shell — サーバー実行が有効か（既定は無効）。 */
export async function codeShellStatus(): Promise<ShellStatus> {
  const res = await fetch(`${requireApiUrl()}/code/shell`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Shell status failed (${res.status})`);
  return (await res.json()) as ShellStatus;
}

/** POST /code/shell — ワークスペースを一時ディレクトリに展開して1コマンド実行。 */
export async function codeShellRun(
  command: string, files: CodeFile[], timeout = 60,
): Promise<ShellResult> {
  const res = await fetch(`${requireApiUrl()}/code/shell`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ command, files, timeout }),
  });
  return failable<ShellResult>(res, "実行に失敗しました");
}

/* ---------------- Whiteboard (Miro-style, multi-board) ---------------- */
export interface BoardNode {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;   // yellow | cyan | green | pink | purple | orange
  w?: number;
  h?: number;      // 0/undefined = auto height
  kind?: "sticky" | "text" | "frame";
}
export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  /** 線の見た目。未指定は矢印（従来の保存データもそのまま表示できる）。 */
  style?: "arrow" | "line" | "dashed";
  /** 線の中央に出すラベル（「〜のため」「原因」など関係の説明）。 */
  label?: string;
}
export interface BoardData { nodes: BoardNode[]; edges: BoardEdge[] }
export interface BoardMeta { id: string; name: string; updated_at?: string; count?: number }

/** GET /boards — board list (meta only, newest first; creates a default when empty). */
export async function boardsList(): Promise<BoardMeta[]> {
  const res = await fetch(`${requireApiUrl()}/boards`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Boards failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: BoardMeta[] };
  return data.items ?? [];
}

/** POST /boards — create a board. */
export async function boardCreate(name = ""): Promise<BoardMeta> {
  const res = await fetch(`${requireApiUrl()}/boards`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Board create failed (${res.status})`);
  return (await res.json()) as BoardMeta;
}

/** GET /boards/{id} — one board with content. */
export async function boardGetById(id: string): Promise<BoardData & BoardMeta> {
  const res = await fetch(`${requireApiUrl()}/boards/${id}`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Board failed (${res.status})`);
  const d = (await res.json()) as BoardData & BoardMeta;
  return { ...d, nodes: d.nodes ?? [], edges: d.edges ?? [] };
}

/** POST /boards/{id} — save one board (full replace; call debounced). */
export async function boardSaveById(id: string, data: BoardData): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/boards/${id}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  return res.ok;
}

/** PATCH /boards/{id} — rename. */
export async function boardRename(id: string, name: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/boards/${id}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  return res.ok;
}

/** POST /boards/{id}/duplicate — copy a board. */
export async function boardDuplicate(id: string): Promise<BoardMeta> {
  const res = await fetch(`${requireApiUrl()}/boards/${id}/duplicate`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Board duplicate failed (${res.status})`);
  return (await res.json()) as BoardMeta;
}

/** DELETE /boards/{id}. */
export async function boardDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/boards/${id}`, { method: "DELETE", headers: authHeaders() });
  return res.ok;
}

/* ---------------- File extract (PDF / text) ---------------- */
/** POST /file/extract — upload a file, get its extracted text. */
export async function fileExtract(file: File): Promise<{ name: string; chars: number; text: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${requireApiUrl()}/file/extract`, {
    method: "POST",
    headers: authHeaders(), // do NOT set Content-Type; the browser adds the multipart boundary
    body: form,
  });
  if (!res.ok) throw new Error(`File extract failed (${res.status})`);
  return (await res.json()) as { name: string; chars: number; text: string };
}

/* ---------------- Scheduler (recurring agent runs) ---------------- */
export interface ScheduleItem {
  id: string;
  instruction: string;
  time: string;
  days?: string;        // "daily" | "mon,wed,fri"
  enabled?: boolean;
  last_run?: string;
  automation_id?: string;   // 指定時は BOARD の自動化を回す
}

export async function schedulesList(): Promise<ScheduleItem[]> {
  return (await schedulesWithHealth()).items;
}

/** 見回りが生きているか。無料プランのサーバーは無操作で寝るので、
 *  時刻になっても発火しないことがある。登録できたのに何も来ないのが
 *  いちばん困るので、状態を一緒に取る。 */
export interface SchedulerHealth {
  at: string;
  users: number;
  ran: number;
}

export async function schedulesWithHealth():
  Promise<{ items: ScheduleItem[]; health: SchedulerHealth | null }> {
  const res = await fetch(`${requireApiUrl()}/scheduler`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Schedules failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const h = (d.last_tick ?? null) as SchedulerHealth | null;
  return { items: asArray<ScheduleItem>(d.items), health: h && h.at ? h : null };
}

/** 見回りが止まっていないか。3分以上あいていたら寝ている疑い。 */
export function schedulerLooksAsleep(h: SchedulerHealth | null): boolean {
  if (!h || !h.at) return true;
  const t = Date.parse(h.at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > 3 * 60 * 1000;
}

/** POST /scheduler — 定期実行を登録する。
 *  automationId を渡すと、指示ではなく BOARD の自動化を時刻で回す。 */
export async function scheduleAdd(
  instruction: string, time: string, days = "daily", automationId = "",
): Promise<ScheduleItem> {
  const res = await fetch(`${requireApiUrl()}/scheduler`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ instruction, time, days, automation_id: automationId }),
  });
  if (!res.ok) throw new Error(`Schedule add failed (${res.status})`);
  return (await res.json()) as ScheduleItem;
}

export async function scheduleDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/scheduler/${id}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- Google integration (Sheets / Docs) ---------------- */
export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  /**
   * 繋いでいるGoogleアカウント。
   * 「作ったと言われたのにドライブに無い」の原因が、見に行ったのと違う
   * アカウントに繋いでいた、ということがある。どこに作られるのかを出す。
   */
  account?: string;
}

/** GET /google/status — whether Google is configured + connected. */
export async function googleStatus(): Promise<GoogleStatus> {
  const res = await fetch(`${requireApiUrl()}/google/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Google status failed (${res.status})`);
  return (await res.json()) as GoogleStatus;
}

/** URL that starts the Google OAuth consent flow (open in a new tab). */
export function googleAuthStartUrl(): string {
  return `${requireApiUrl()}/google/auth/start`;
}

/** POST /google/disconnect — forget the stored refresh token. */
export async function googleDisconnect(): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/google/disconnect`, { method: "POST", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- 押すだけの連携（OAuth） ---------------- */
/**
 * 連携先1つぶんの状態。
 *
 * configured と connected を分けているのが肝。
 *   configured … アプリの持ち主が提供元にアプリ登録を済ませたか
 *   connected  … この利用者が「許可」を押したか
 * 混ぜると、利用者が自分では直せないこと（アプリ登録）を直そうとして詰まる。
 */
export interface ConnectProvider {
  key: string;
  label: string;
  configured: boolean;
  connected: boolean;
  account?: string;
  unlocks: string[];
  note?: string;
}

/** GET /connect — 連携できる先と、その状態。 */
export async function connectStatus(): Promise<{
  providers: ConnectProvider[];
  noOauth: Record<string, string>;
}> {
  const res = await fetch(`${requireApiUrl()}/connect`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return { providers: [], noOauth: {} };
  const d = (await res.json().catch(() => ({}))) as
    { providers?: ConnectProvider[]; no_oauth?: Record<string, string> };
  return { providers: asArray<ConnectProvider>(d.providers), noOauth: d.no_oauth ?? {} };
}

/** 同意画面へ向かうURL（新しいタブで開く）。 */
export function connectStartUrl(provider: string): string {
  // Google は以前からこのURLで動いており、提供元にも登録されているので変えない
  return provider === "google"
    ? `${requireApiUrl()}/google/auth/start`
    : `${requireApiUrl()}/connect/${provider}/start`;
}

/** POST /connect/{provider}/disconnect — 保存したトークンを忘れる。 */
export async function connectDisconnect(provider: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/connect/${provider}/disconnect`, {
    method: "POST", headers: authHeaders(),
  });
  const d = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(d.ok);
}

/* ---------------- DB persistence (auto-migration) ---------------- */
export interface DbStatus {
  connected: boolean;
  db_url_set: boolean;
  present: string[];
  missing: string[];
  error?: string;
}

/** GET /admin/db/status — which tables exist (persistence readiness).
 *  配列が欠けた応答でも設定画面を落とさない（normalizeAiConfig と同じ理由）。 */
export async function dbStatus(): Promise<DbStatus> {
  const res = await fetch(`${requireApiUrl()}/admin/db/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`DB status failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Partial<DbStatus>;
  return {
    connected: Boolean(d.connected),
    db_url_set: Boolean(d.db_url_set),
    present: Array.isArray(d.present) ? d.present : [],
    missing: Array.isArray(d.missing) ? d.missing : [],
    error: d.error,
  };
}

/** POST /admin/migrate — create missing tables via SUPABASE_DB_URL. */
export async function dbMigrate(): Promise<{ ok: boolean; error?: string; skipped?: boolean; reason?: string }> {
  const res = await fetch(`${requireApiUrl()}/admin/migrate`, { method: "POST", headers: authHeaders() });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string; skipped?: boolean; reason?: string };
}

/* ---------------- Programmatic SEO ---------------- */
export interface PseoSpec { slug: string; title: string; keywords: string }
export interface PseoPage {
  slug: string;
  title: string;
  keywords?: string;
  status: "draft" | "approved" | "rejected";
  updated_at?: string;
  content?: {
    disclosure?: string;
    lead?: string;
    meta_description?: string;
    sections?: { h2?: string; body?: string }[];
    faq?: { q?: string; a?: string }[];
  };
}

/** POST /pseo/plan — preview the keyword-matrix page plan (no generation). */
export async function pseoPlan(axes: string[][], template = "", limit = 20): Promise<PseoSpec[]> {
  const res = await fetch(`${requireApiUrl()}/pseo/plan`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ axes, template, limit }),
  });
  if (!res.ok) throw new Error(`Plan failed (${res.status})`);
  const d = (await res.json()) as { items?: PseoSpec[] };
  return d.items ?? [];
}

/** POST /pseo/generate — generate + save as drafts (never auto-published). */
export async function pseoGenerate(axes: string[][], template = "", limit = 5): Promise<{ count: number; created: { slug: string; title: string }[]; failed?: unknown[]; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/pseo/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ axes, template, limit }),
  });
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    count: asNumber(d.count),
    created: asArray<{ slug: string; title: string }>(d.created),
    failed: asArray<unknown>(d.failed),
    error: typeof d.error === "string" ? d.error : undefined,
  };
}

/** GET /pseo/pages — list pages (optionally by status). */
export async function pseoPages(status?: string): Promise<PseoPage[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(`${requireApiUrl()}/pseo/pages${q}`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Pages failed (${res.status})`);
  const d = (await res.json()) as { items?: PseoPage[] };
  return d.items ?? [];
}

/** PATCH /pseo/pages/{slug} — approve / reject (semi-auto gate). */
export async function pseoSetStatus(slug: string, status: "draft" | "approved" | "rejected"): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/pseo/pages/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ status }),
  });
  return res.ok;
}

/** DELETE /pseo/pages/{slug}. */
export async function pseoDelete(slug: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/pseo/pages/${encodeURIComponent(slug)}`, { method: "DELETE", headers: authHeaders() });
  return res.ok;
}

/* ---------------- LP / HP / Web app builder ---------------- */
export interface LpResult {
  ok?: boolean; html?: string; title?: string; kind?: string;
  error?: string; artifact?: { id: string };
}

/** POST /lp/generate — build (or refine) a single-file page (kind="lp") or web app (kind="app"). */
export async function lpGenerate(opts: {
  brief: string; style?: string; sections?: string; current?: string;
  save?: boolean; kind?: "lp" | "app";
}): Promise<LpResult> {
  const res = await fetch(`${requireApiUrl()}/lp/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      brief: opts.brief, style: opts.style ?? "modern",
      sections: opts.sections ?? "", current: opts.current ?? "",
      save: !!opts.save, kind: opts.kind ?? "lp",
    }),
  });
  return failable<LpResult>(res, "生成に失敗しました");
}

/* ---------------- Image studio (multi-variant) ---------------- */
export interface ImageAspect { key: string; w: number; h: number; label: string }
export interface ImageVariant { url: string; seed: number; provider?: string }
export interface ImageResult {
  ok?: boolean; images?: ImageVariant[]; aspect?: string; width?: number; height?: number;
  prompt?: string; offset?: number; artifacts?: { id: string }[]; error?: string;
  engine?: string; model?: string; max_variants?: number; partial_error?: string;
}
export interface ImageEngine { label: string; ready: boolean; model: string; hint?: string }

/** GET /image/engines — 無料エンジン / HFの割り当てモデル、それぞれ使えるか。 */
export async function imageEngines(): Promise<Record<string, ImageEngine>> {
  const res = await fetch(`${requireApiUrl()}/image/engines`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Engines failed (${res.status})`);
  const d = (await res.json()) as { engines?: Record<string, ImageEngine> };
  return d.engines ?? {};
}

/** GET /image/aspects — aspect-ratio presets (1:1, 4:5, 9:16, 16:9, 3:2). */
export async function imageAspects(): Promise<ImageAspect[]> {
  const res = await fetch(`${requireApiUrl()}/image/aspects`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Aspects failed (${res.status})`);
  const d = (await res.json()) as { aspects?: ImageAspect[] };
  return d.aspects ?? [];
}

/** POST /image/generate — n variants of one prompt (save=true → artifacts).
 *  offset shifts the seeds so the same prompt can yield further alternatives. */
export async function imageGenerate(opts: {
  prompt: string; aspect?: string; n?: number; save?: boolean; offset?: number; engine?: string;
}): Promise<ImageResult> {
  const res = await fetch(`${requireApiUrl()}/image/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      prompt: opts.prompt, aspect: opts.aspect ?? "1:1",
      n: opts.n ?? 2, save: !!opts.save, offset: opts.offset ?? 0,
      engine: opts.engine ?? "auto",
    }),
  });
  return failable<ImageResult>(res, "生成に失敗しました");
}

/* ---------------- SNS post support ---------------- */
export interface SnsPost {
  text: string;
  hashtags: string[];
  image_prompt?: string;
  image_url?: string;
  thread?: string[];
  length: number;
  over_limit: boolean;
}
export interface SnsResult {
  ok?: boolean; platform?: string; label?: string; limit?: number;
  posts?: SnsPost[]; error?: string;
}

/** POST /sns/generate — draft posts for X / Instagram (never auto-posts). */
export async function snsGenerate(opts: {
  platform: string; topic: string; n?: number; tone?: string;
  promo?: boolean; thread?: boolean; withImages?: boolean;
}): Promise<SnsResult> {
  const res = await fetch(`${requireApiUrl()}/sns/generate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      platform: opts.platform, topic: opts.topic, n: opts.n ?? 3, tone: opts.tone ?? "",
      promo: !!opts.promo, thread: !!opts.thread, with_images: !!opts.withImages,
    }),
  });
  return failable<SnsResult>(res, "生成に失敗しました");
}

/* ---------------- Newsletter (list building + broadcast) ---------------- */
export interface Subscriber { email: string; status: string; source?: string; created_at?: string }
export interface NewsletterStats { total: number; pending: number; confirmed: number; unsubscribed: number }
export interface NewsletterIssue { id: string; subject: string; body: string; status: string; sent_count?: number; created_at?: string }

export async function newsletterSubscribers(): Promise<{ items: Subscriber[]; stats: NewsletterStats }> {
  const res = await fetch(`${requireApiUrl()}/newsletter/subscribers`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Subscribers failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { items: asArray<Subscriber>(d.items), stats: (d.stats ?? {}) as NewsletterStats };
}

export async function newsletterIssues(): Promise<NewsletterIssue[]> {
  const res = await fetch(`${requireApiUrl()}/newsletter/issues`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Issues failed (${res.status})`);
  const d = (await res.json()) as { items?: NewsletterIssue[] };
  return d.items ?? [];
}

/** Draft an issue; pass topic to have the AI write the body. Never sends. */
export async function newsletterDraft(subject: string, body = "", topic = ""): Promise<NewsletterIssue & { error?: string }> {
  const res = await fetch(`${requireApiUrl()}/newsletter/issues`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ subject, body, topic }),
  });
  return (await res.json().catch(() => ({}))) as NewsletterIssue & { error?: string };
}

/** Send an issue to confirmed subscribers (or only to testTo). */
export async function newsletterSend(id: string, testTo = ""): Promise<{ ok?: boolean; sent?: number; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/newsletter/issues/${encodeURIComponent(id)}/send`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ test_to: testTo }),
  });
  return (await res.json().catch(() => ({}))) as { ok?: boolean; sent?: number; error?: string };
}

/* ---------------- Keep-alive (prevent Supabase auto-pause) ---------------- */
export interface KeepaliveStatus {
  supabase_configured: boolean;
  db_url_set: boolean;
  last_at: string;
  last_ok: boolean;
  last_detail: string;
}

/** GET /keepalive/status — when the DB was last touched. */
export async function keepaliveStatus(): Promise<KeepaliveStatus> {
  const res = await fetch(`${requireApiUrl()}/keepalive/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Keepalive status failed (${res.status})`);
  return (await res.json()) as KeepaliveStatus;
}

/** GET /keepalive — touch the DB now (also what the daily cron calls). */
export async function keepalivePing(): Promise<{ ok: boolean; detail?: string; at?: string }> {
  const res = await fetch(`${requireApiUrl()}/keepalive`, { headers: authHeaders(), cache: "no-store" });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; detail?: string; at?: string };
}

/* ---------------- AI provider / model config ---------------- */
export interface AiConfig {
  provider: string;
  hf_model: string;
  code_model: string;
  active: string;
  gemini_ready: boolean;
  hf_ready: boolean;
  presets: { chat: string[]; code: string[] };
}

/** バックエンドの応答に欠けた項目を埋める。
 *  フロント(Vercel)とバックエンド(Render)は別々に配るので、片方が古いと
 *  presets などが無い応答が来ることがある。そのとき設定画面が丸ごと落ちて
 *  KEYCHAINタブにも入れなくなる（＝直せなくなる）ので、必ず既定で埋める。 */
function normalizeAiConfig(raw: unknown): AiConfig {
  const d = (raw ?? {}) as Partial<AiConfig> & { presets?: Partial<AiConfig["presets"]> };
  return {
    provider: d.provider ?? "auto",
    hf_model: d.hf_model ?? "",
    code_model: d.code_model ?? "",
    active: d.active ?? "none",
    gemini_ready: Boolean(d.gemini_ready),
    hf_ready: Boolean(d.hf_ready),
    presets: {
      chat: Array.isArray(d.presets?.chat) ? d.presets!.chat : [],
      code: Array.isArray(d.presets?.code) ? d.presets!.code : [],
    },
  };
}

/** GET /ai/config — current provider/model + options. */
export async function aiConfigGet(): Promise<AiConfig> {
  const res = await fetch(`${requireApiUrl()}/ai/config`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`AI config failed (${res.status})`);
  return normalizeAiConfig(await res.json().catch(() => ({})));
}

/** POST /ai/config — set provider/model. */
export async function aiConfigSet(patch: { provider?: string; hf_model?: string; code_model?: string }): Promise<AiConfig> {
  const res = await fetch(`${requireApiUrl()}/ai/config`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`AI config save failed (${res.status})`);
  return normalizeAiConfig(await res.json().catch(() => ({})));
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
  // 配列が欠けた応答で画面ごと落とさない。categories が undefined のまま
  // 渡ると LifeMode の categories.length で例外になり、MEが真っ白になる（実際に起きた）。
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { items: asArray<LifeEntry>(d.items), categories: asArray<LifeCategory>(d.categories) };
}

/** POST /life/entries — save one experience. */
export async function lifeAdd(category: string, content: string, entryDate = ""): Promise<LifeEntry> {
  const res = await fetch(`${requireApiUrl()}/life/entries`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ category, content, entry_date: entryDate }),
  });
  const data = (await res.json().catch(() => ({}))) as LifeEntry & { error?: string };
  if (!res.ok || data.error) throw new Error(reason(data) ?? `Life add failed (${res.status})`);
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
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
export interface VaultSource { n: number; title: string }
export interface VaultAnswer {
  answer: string;
  sources: VaultSource[];
  cited: number[];      // 回答が実際に引用した資料の番号
  /** 資料が多く、関連箇所だけを見て答えた場合に true（全部読んだと誤解させないため） */
  partial?: boolean;
}

export async function vaultQuery(notebookId: string, question: string): Promise<VaultAnswer> {
  const res = await fetch(`${requireApiUrl()}/vault/query`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, question }),
  });
  const data = (await res.json().catch(() => ({}))) as
    { answer?: string; sources?: VaultSource[]; cited?: number[]; partial?: boolean; error?: string };
  if (!res.ok && !data.error) throw new Error(`Vault query failed (${res.status})`);
  return {
    answer: data.answer ?? data.error ?? "",
    sources: data.sources ?? [],
    cited: data.cited ?? [],
    partial: !!data.partial,
  };
}

export interface VaultDoc { n: number; title: string; chars: number }

/** GET /vault/docs — 資料の一覧（出典番号つき）。 */
export async function vaultDocs(notebookId: string): Promise<VaultDoc[]> {
  const res = await fetch(`${requireApiUrl()}/vault/docs?notebook_id=${encodeURIComponent(notebookId)}`,
    { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Vault docs failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: VaultDoc[] };
  return data.items ?? [];
}

/** POST /vault/docs/delete — 資料を1件消す。 */
export async function vaultDocDelete(notebookId: string, title: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/vault/docs/delete`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ notebook_id: notebookId, title }),
  });
  return res.ok;
}

/** POST /vault/upload — PDF等をサーバー側で抽出して資料にする。
 *  ブラウザで PDF をテキストとして読むと文字化けするので、必ずこちらを通す。 */
export async function vaultUpload(notebookId: string, file: File, title = ""):
  Promise<{ ok?: boolean; title?: string; chars?: number; error?: string }> {
  const form = new FormData();
  form.append("notebook_id", notebookId);
  form.append("file", file);
  if (title) form.append("title", title);
  const res = await fetch(`${requireApiUrl()}/vault/upload`, {
    method: "POST",
    headers: authHeaders(),   // Content-Type は FormData に任せる（boundary付与のため）
    body: form,
  });
  return failable(res, "取り込みに失敗しました");
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
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
  if (data.error) throw new Error(reason(data) ?? "失敗しました");
  return { mermaid: data.mermaid ?? "", kind: data.kind ?? kind };
}

/* ---------------- Tasks (Active Tasks) ---------------- */
export interface Task {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "awaiting_approval" | "completed" | "cancelled";
  content?: string;
  response?: string;
  priority?: "high" | "mid" | "low";
  due?: string;       // YYYY-MM-DD
  project?: string;   // グループ名
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
export async function createTask(
  title: string,
  content = "",
  status = "pending",
  extra: { priority?: string; due?: string; project?: string } = {},
): Promise<Task> {
  const res = await fetch(`${requireApiUrl()}/tasks`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, content, status, ...extra }),
  });
  const data = (await res.json().catch(() => ({}))) as Task & { error?: string };
  if (!res.ok) throw new Error(reason(data) ?? `Create task failed (${res.status})`);
  return data;
}

/** PATCH /tasks/{id} — update task. */
export async function updateTask(id: string, updates: { status?: string; response?: string; content?: string; priority?: string; due?: string; project?: string }): Promise<Task> {
  const res = await fetch(`${requireApiUrl()}/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  const data = (await res.json().catch(() => ({}))) as Task & { error?: string };
  if (!res.ok) throw new Error(reason(data) ?? `Update task failed (${res.status})`);
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
  /** 指示。type/params 形式のステップでは省略できる（flow_engine が両方読む）。 */
  prompt?: string;
  /** ステップ種別。省略時は ai_generate として扱われる。 */
  type?: StepType;
  params?: Record<string, string>;
  ai_id?: string;        // このステップを担当するカスタムAI（人格＋ルール）
  notebook_id?: string;  // VAULTのノートブックを根拠資料にする（RAG）
  when?: string;         // 条件（満たさなければこのステップを飛ばす）
}

export interface StudioWorkflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  created_at?: string;
}

export interface WorkflowStepResult {
  step: number;
  name: string;
  output: string;
  skipped?: boolean;
  reason?: string;
  ai?: string;
  knowledge?: string;
  warning?: string;
}

export interface WorkflowResult {
  workflow_id: string;
  workflow_name: string;
  results: WorkflowStepResult[];
  final_output: string;
  ran?: number;
  skipped?: number;
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
  if (!res.ok) throw new Error(reason(data) ?? `Create AI failed (${res.status})`);
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
  if (!res.ok) throw new Error(reason(data) ?? `Create workflow failed (${res.status})`);
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
  if (!res.ok) throw new Error(reason(data) ?? `Run workflow failed (${res.status})`);
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
export async function videoGenerate(
  scenes: VideoScene[],
  imagePrompt = "",
  opts?: { aspect?: string; subtitles?: boolean },
): Promise<VideoResult> {
  const res = await fetch(`${requireApiUrl()}/video`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      scenes, image_prompt: imagePrompt,
      aspect: opts?.aspect ?? "16:9",
      subtitles: opts?.subtitles ?? true,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as VideoResult;
  if (!res.ok && !data.error) return { error: `Video failed (${res.status})` };
  return data;
}

export interface VideoAspect { key: string; w: number; h: number; label: string }
export interface VideoCaps {
  aspects: VideoAspect[];
  available: boolean;
  subtitles_available: boolean;
}

/** GET /video/aspects — presets + whether ffmpeg and a JP font are present. */
export async function videoCaps(): Promise<VideoCaps> {
  const res = await fetch(`${requireApiUrl()}/video/aspects`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Video caps failed (${res.status})`);
  return (await res.json()) as VideoCaps;
}

export interface StoryboardResult {
  ok?: boolean; title?: string; scenes?: VideoScene[]; error?: string;
}

/** POST /video/storyboard — turn a topic into narration + image prompts. */
export async function videoStoryboard(opts: {
  topic: string; n?: number; aspect?: string; tone?: string; style?: string;
}): Promise<StoryboardResult> {
  const res = await fetch(`${requireApiUrl()}/video/storyboard`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      topic: opts.topic, n: opts.n ?? 5, aspect: opts.aspect ?? "16:9",
      tone: opts.tone ?? "friendly", style: opts.style ?? "",
    }),
  });
  return failable<StoryboardResult>(res, "絵コンテの生成に失敗しました");
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
  if (!res.ok) throw new Error(reason(data) ?? `Create mission failed (${res.status})`);
  return data;
}

export async function autopilotStep(id: string): Promise<StepResult> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions/${encodeURIComponent(id)}/step`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
  });
  const data = (await res.json().catch(() => ({}))) as StepResult;
  if (!res.ok && !data.mission) throw new Error(reason(data) ?? `Step failed (${res.status})`);
  return data;
}

export async function autopilotDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/autopilot/missions/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/** 1チャンネルぶんの送信結果。どこで失敗したかを画面に出すのに使う。 */
export interface NotifyChannelResult {
  channel: string;
  ok?: boolean;
  skipped?: boolean;
  error?: string;
}

/** POST /notify — send a test/manual notification to configured channels.
 *  チャンネルごとの結果まで返す。「送りました」だけだと、実際は
 *  どこにも届いていなくても成功に見えてしまう。 */
export async function sendNotify(message: string):
  Promise<{ ok: boolean; sent?: string[]; skipped?: boolean; results?: NotifyChannelResult[] }> {
  const res = await fetch(`${requireApiUrl()}/notify`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message }),
  });
  const data = (await res.json().catch(() => ({ ok: false }))) as
    { ok?: boolean; sent?: string[]; skipped?: boolean; results?: NotifyChannelResult[] };
  if (!res.ok) throw new Error(`Notify failed (${res.status})`);
  return {
    ok: Boolean(data.ok),
    sent: data.sent,
    skipped: data.skipped,
    results: Array.isArray(data.results) ? data.results : [],
  };
}

/* ---------------- Automations (no-code flows / Zapier-style) ---------------- */
/**
 * 手順の種類。
 *
 * fetch は「外のURLを読む」。これが無かったので、自動化は外の値を1つも
 * 見られず、AIに書かせるだけの仕組みになっていた。
 * 読む先はサーバー側の門番（netguard）を必ず通る。
 */
export type StepType = "ai_generate" | "fetch" | "notify" | "create_task";

export interface AutomationStep {
  id?: string;
  n?: number;
  type: StepType;
  name?: string;
  params?: Record<string, string>;
  // AI STUDIO のワークフローと共通の拡張（未指定なら従来どおり動く）
  prompt?: string;
  ai_id?: string;
  notebook_id?: string;
  when?: string;
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
  // AI STUDIO のワークフローと同じ実行エンジンなので trace の形も共通
  results: Array<{
    step: number; name: string; type: string; ok: boolean; output: string;
    error?: string; skipped?: boolean; reason?: string; ai?: string;
    knowledge?: string; warning?: string;
  }>;
  final_output: string;
  ran?: number;
  skipped?: number;
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
  if (!res.ok) throw new Error(reason(data) ?? `Create automation failed (${res.status})`);
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
  if (!res.ok) throw new Error(reason(data) ?? `Run automation failed (${res.status})`);
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
  const data = (await res.json().catch(() => ({}))) as Partial<HomeSummary>;
  // セクションごとに既定値へ被せる。JSONとしては読めても項目が欠けている
  // （古いバックエンドや部分デプロイ）場合に summary.tasks.open で落ちないように。
  const keys = Object.keys(empty) as (keyof HomeSummary)[];
  const out = { ...empty };
  for (const k of keys) {
    const v = data[k];
    if (v && typeof v === "object") {
      Object.assign(out[k] as object, v);
    }
  }
  return out;
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
  if (!res.ok) throw new Error(reason(data) ?? `Add event failed (${res.status})`);
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
  if (!res.ok) throw new Error(reason(data) ?? `Parse event failed (${res.status})`);
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

/* ---------------- Artifacts (agent-generated documents / spreadsheets) ---------------- */
export interface ArtifactMeta {
  id: string;
  kind: string;       // "document" | "spreadsheet" | "image"
  title: string;
  mime: string;
  size: number;
  preview?: string;
  url?: string;       // image artifacts only (thumbnail / open)
  created_at?: string;
}
export interface ArtifactFull extends ArtifactMeta {
  content: string;
}

/** GET /artifacts — metadata list (no content), newest first. */
export async function artifactsList(): Promise<ArtifactMeta[]> {
  const res = await fetch(`${requireApiUrl()}/artifacts`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Artifacts failed (${res.status})`);
  const data = (await res.json().catch(() => ({ items: [] }))) as { items?: ArtifactMeta[] };
  return data.items ?? [];
}

/** GET /artifacts/{id} — full artifact with content (for download). */
export async function artifactGet(id: string): Promise<ArtifactFull> {
  const res = await fetch(`${requireApiUrl()}/artifacts/${id}`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Artifact failed (${res.status})`);
  return (await res.json()) as ArtifactFull;
}

/** DELETE /artifacts/{id}. */
export async function artifactDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/artifacts/${id}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* Slide deck (artifact kind="slides", content = JSON of this shape). */
export type SlideLayout = "title" | "section" | "bullets" | "two_col" | "stat" | "quote" | "image";
export interface Slide {
  layout?: SlideLayout;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  stat?: string;
  quote?: string;
  author?: string;
  image?: string;   // URL
  notes?: string;
}
export interface SlideDeck { title: string; theme?: string; slides: Slide[] }

export interface SlideLayoutDef { key: SlideLayout; label: string; fields: string[] }

/** GET /slides/layouts — which fields each layout uses (drives the edit form). */
export async function slideLayouts(): Promise<{ layouts: SlideLayoutDef[]; themes: string[] }> {
  const res = await fetch(`${requireApiUrl()}/slides/layouts`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Layouts failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { layouts: asArray<SlideLayoutDef>(d.layouts), themes: asArray<string>(d.themes) };
}

/** POST /slides/revise — rewrite ONE slide with AI, leaving the rest of the deck alone. */
export async function slideRevise(opts: {
  slide: Slide; instruction: string; deckTitle?: string; layout?: string; context?: string;
}): Promise<{ ok?: boolean; slide?: Slide; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/slides/revise`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      slide: opts.slide, instruction: opts.instruction,
      deck_title: opts.deckTitle ?? "", layout: opts.layout ?? "", context: opts.context ?? "",
    }),
  });
  return failable<{ ok?: boolean; slide?: Slide; error?: string }>(res, "修正に失敗しました");
}

/** POST /slides/google — convert a deck to Google Slides, returns the URL. */
export async function slidesToGoogle(title: string, deckSlides: Slide[], theme = ""): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/slides/google`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ title, slides: deckSlides, theme }),
  });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; url?: string; error?: string };
}

/** PATCH /artifacts/{id} — update an artifact's content/title (e.g. slide theme). */
export async function artifactUpdate(id: string, patch: { content?: string; title?: string }): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/artifacts/${id}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  return res.ok;
}

/** Fetch an artifact and trigger a browser download (CSV/Markdown). */
export async function artifactDownload(meta: ArtifactMeta): Promise<void> {
  const full = await artifactGet(meta.id);
  const ext = full.mime === "text/csv" ? "csv" : "md";
  const safe = (meta.title || "artifact").replace(/[^\p{L}\p{N}_\- ]/gu, "_").slice(0, 60).trim() || "artifact";
  const blob = new Blob([full.content], { type: `${full.mime || "text/plain"};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  if (!res.ok || data.error) throw new Error(reason(data) ?? `Evolve failed (${res.status})`);
  return data;
}

/* ---------------- Keychain (API key vault) ---------------- */
export interface ApiKeyInfo {
  name: string;
  label?: string;
  hint?: string;
  masked: string;
  set: boolean;
  /**
   * どこに入っているか。ここが無いと「入れたのに未設定に戻る」の原因が分からない。
   *   db     … 保存先のデータベース（アプリを更新しても残る）
   *   server … 管理者がサーバーに入れた共通の鍵
   *   memory … プロセスの中だけ。更新すると消える
   */
  where?: "db" | "server" | "memory" | "";
  persisted?: boolean;
}

/** 前の保存先に取り残された鍵（持ち主のみ）。値は返ってこない。 */
export interface OrphanKey {
  name: string;
  label: string;
  masked: string;
}

/**
 * いま飛んでいる /keys の問い合わせ。
 *
 * 同じ画面の別々の部品（設定の案内・初回の案内・拡張機能）が、それぞれ
 * 自分のために鍵の一覧を取る。作りとしては正しいが、開くたびに同じ物を
 * 2回聞いていた（管理タブで実測）。無料のバックエンドは寝ているので、
 * 1往復の無駄がそのまま体感の遅さになる。
 *
 * **溜め込みはしない。**同じ瞬間に飛んでいる物だけを束ねる。
 * 少しでも溜めると、鍵を保存した直後に古い一覧を見せることになり、
 * 「入れたのに未設定に戻る」に逆戻りする。
 */
let keysInFlight: Promise<ApiKeyInfo[]> | null = null;
let keysSeq = 0;

/** GET /keys — masked list of known + stored API keys (full values never returned). */
export function listKeys(): Promise<ApiKeyInfo[]> {
  if (keysInFlight) return keysInFlight;
  const mine = ++keysSeq;
  const run = (async () => {
    try {
      const res = await fetch(`${requireApiUrl()}/keys`, { headers: authHeaders(), cache: "no-store" });
      if (!res.ok) throw new Error(`Keys failed (${res.status})`);
      const data = (await res.json().catch(() => ({ items: [] }))) as { items?: ApiKeyInfo[] };
      return data.items ?? [];
    } finally {
      // 決着と同時に手放す。ここを外の .finally() に置くと、片付けが
      // 1〜2手おくれて、返事が来た直後に聞いた人へ古い約束を渡してしまう。
      // 失敗も握らない（握ると、次に聞いた人にも同じ失敗を返し続ける）。
      if (keysSeq === mine) keysInFlight = null;
    }
  })();
  keysInFlight = run;
  return run;
}

/**
 * POST /keys — store/update a key.
 *
 * persisted は「本当に残ったか」。false のときは、サーバーが更新されると
 * その鍵は消える。呼び出し側は warning をそのまま画面に出すこと
 * （黙って握ると「入れたのに未設定に戻る」に逆戻りする）。
 */
export async function setKey(
  name: string,
  value: string,
): Promise<{ ok: boolean; masked?: string; persisted: boolean; warning?: string }> {
  const res = await fetch(`${requireApiUrl()}/keys`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, value }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean; masked?: string; error?: string; persisted?: boolean; warning?: string;
  };
  if (!res.ok) throw new Error(reason(data) ?? `Set key failed (${res.status})`);
  return {
    ok: Boolean(data.ok),
    masked: data.masked,
    persisted: data.persisted !== false,
    warning: data.warning,
  };
}

/** GET /keys/orphans — 自分のDBを繋ぐ前の保存先に残っている鍵（持ち主のみ）。 */
export async function keyOrphans(): Promise<{ available: boolean; items: OrphanKey[] }> {
  const res = await fetch(`${requireApiUrl()}/keys/orphans`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) return { available: false, items: [] };   // 持ち主でなければ静かに何も出さない
  const data = (await res.json().catch(() => ({}))) as { available?: boolean; items?: OrphanKey[] };
  return { available: Boolean(data.available), items: asArray<OrphanKey>(data.items) };
}

/** POST /keys/rescue — 前の保存先に残っている鍵を、いまの保存先へ写す。 */
export async function keyRescue(names: string[] = []): Promise<{ moved: string[]; count: number }> {
  const res = await fetch(`${requireApiUrl()}/keys/rescue`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ names }),
  });
  const data = (await res.json().catch(() => ({}))) as
    { moved?: string[]; count?: number; error?: string };
  if (!res.ok) throw new Error(reason(data) ?? `Rescue failed (${res.status})`);
  return { moved: asArray<string>(data.moved), count: asNumber(data.count) };
}

/** DELETE /keys/{name} — remove a stored key. */
export async function deleteKey(name: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/keys/${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  const data = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(data.ok);
}

/* ---------------- Rules (AIbouに守らせる決まりごと) ---------------- */
export interface RuleInfo {
  path: string;
  title: string;
  applies: "always" | "tool" | "mode" | "topic";
  targets: string[];
  preview: string;
}

/** GET /rules — 取り込み済みのルール。GitHubには触らない（保存済みを読むだけ）。 */
export async function rulesStatus(): Promise<{ repo: string; count: number; items: RuleInfo[] }> {
  const res = await fetch(`${requireApiUrl()}/rules`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return { repo: "", count: 0, items: [] };
  const d = (await res.json().catch(() => ({}))) as
    { repo?: string; count?: number; items?: RuleInfo[] };
  return { repo: d.repo ?? "", count: asNumber(d.count), items: asArray<RuleInfo>(d.items) };
}

/**
 * POST /rules/sync — GitHubのメモを取り込む。
 *
 * GitHubに触るのはここだけ。会話のたびに取りに行くと、その往復がそのまま
 * 返事の待ち時間になるので、取り込みは押したときだけにしてある。
 */
export async function rulesSync(repo = "", path = ""): Promise<{
  count: number; persisted: boolean; warning?: string;
  by_applies?: Record<string, number>;
}> {
  const res = await fetch(`${requireApiUrl()}/rules/sync`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ repo, path }),
  });
  const d = (await res.json().catch(() => ({}))) as {
    count?: number; persisted?: boolean; warning?: string; error?: string;
    by_applies?: Record<string, number>;
  };
  if (!res.ok) throw new Error(reason(d) ?? `Rules sync failed (${res.status})`);
  return {
    count: asNumber(d.count),
    persisted: d.persisted !== false,
    warning: d.warning,
    by_applies: d.by_applies,
  };
}

/* ---------------- WATCH（見張り） ---------------- */
export interface WatchItem {
  key: string;
  title: string;
  detail?: string;
  when?: string;
  url?: string;
  urgent?: boolean;
  is_new?: boolean;
}

/**
 * 監視対象1つぶんの状態。
 *
 * ok と setup_needed を分けているのが肝。「読めなかった」と「まだ設定していない」を
 * 同じ扱いにすると、未設定のSlackが毎回エラーとして出て、本物の失敗が埋もれる。
 */
export interface WatchSource {
  key: string;
  label: string;
  enabled: boolean;
  ok: boolean;
  error: string;
  hint: string;
  warning?: string;
  skipped: boolean;
  setup_needed?: boolean;
  started?: boolean;
  fresh?: boolean;
  items: WatchItem[];
  new: WatchItem[];
}

export interface WatchReport {
  text: string;
  checked_at: string;
  sources: WatchSource[];
}

/**
 * GET /watch — いま気にすべきものと、各対象を読めているかどうか。
 *
 * force を付けない限り、サーバーは外（メール・Slack・カレンダー）へ繋ぎに
 * 行かず、前回の中身を返す。画面を開くたびに繋ぐと、開くだけで数秒待たされる。
 */
export async function watchReport(newOnly = false, force = false): Promise<WatchReport> {
  const q = `new_only=${newOnly ? "true" : "false"}&force=${force ? "true" : "false"}`;
  const res = await fetch(`${requireApiUrl()}/watch?${q}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return { text: "", checked_at: "", sources: [] };
  const d = (await res.json().catch(() => ({}))) as Partial<WatchReport>;
  return {
    text: d.text ?? "",
    checked_at: d.checked_at ?? "",
    sources: asArray<WatchSource>(d.sources),
  };
}

/** POST /watch/check — いますぐ見回って、新着があれば通知する。 */
export async function watchCheck(): Promise<{ notified: boolean; new: number; text?: string }> {
  const res = await fetch(`${requireApiUrl()}/watch/check`, {
    method: "POST",
    headers: authHeaders(),
  });
  const d = (await res.json().catch(() => ({}))) as
    { notified?: boolean; new?: number; text?: string };
  return { notified: d.notified === true, new: asNumber(d.new), text: d.text };
}

/** POST /watch/source — 対象ごとに見張りを止める / 再開する。 */
export async function watchSetSource(source: string, enabled: boolean): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/watch/source`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ source, enabled }),
  });
  return res.ok;
}

export interface InboxMessage {
  id: string; channel: string; sender: string; text: string;
  read?: boolean; created_at?: string;
}

/** GET /watch/inbox — 外から届いたメッセージと、受信の窓口URL。 */
export async function watchInbox(): Promise<{
  items: InboxMessage[]; path: string; token: string; secret_set: boolean; unread: number;
}> {
  const res = await fetch(`${requireApiUrl()}/watch/inbox`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) return { items: [], path: "", token: "", secret_set: false, unread: 0 };
  const d = (await res.json().catch(() => ({}))) as {
    items?: InboxMessage[]; path?: string; token?: string;
    secret_set?: boolean; unread?: number;
  };
  return {
    items: asArray<InboxMessage>(d.items),
    path: d.path ?? "",
    token: d.token ?? "",
    secret_set: d.secret_set === true,
    unread: asNumber(d.unread),
  };
}


/* ---------------- できること（# コマンドとパック） ---------------- */
export interface CommandItem {
  cmd: string;
  label: string;
  arg: string;
  icon: string;
  pack: string;
  /** 読み（かな・英語）。日本語入力はかなを通るので、これで絞れないと窓が使えない。 */
  yomi?: string;
  view: string;
  /** true なら、AIに考えさせず道具へ直行できる。 */
  direct: boolean;
}

export interface FeaturePack {
  key: string;
  label: string;
  hint: string;
  enabled: boolean;
  /** 切れないパック（切ると相棒がほぼ何もできなくなる）。 */
  always: boolean;
}

/** GET /capabilities — # の一覧と、機能パックの状態。 */
export async function capabilities(): Promise<{
  packs: FeaturePack[]; commands: CommandItem[];
}> {
  const res = await fetch(`${requireApiUrl()}/capabilities`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) return { packs: [], commands: [] };
  const d = (await res.json().catch(() => ({}))) as
    { packs?: FeaturePack[]; commands?: CommandItem[] };
  return { packs: asArray<FeaturePack>(d.packs), commands: asArray<CommandItem>(d.commands) };
}

/**
 * POST /capabilities/packs — 使う機能のかたまりを切り替える。
 *
 * 断られた理由をそのまま返す。保存先が無いとき（自分のデータベースを
 * 繋いでいない）サーバーは 409 とその理由を返すので、握りつぶすと
 * 画面が「通信を確かめてください」と嘘の案内をすることになる。
 */
export async function setPacks(
  packs: string[],
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/capabilities/packs`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ packs }),
  });
  if (res.ok) return { ok: true };
  const d = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  return { ok: false, error: d.error || d.detail || `保存できませんでした（${res.status}）` };
}

export interface CommandResult {
  ok: boolean;
  /** done=実行した / view=画面を開く / needs_arg=引数が要る
   *  / delegate=AIに任せる / unknown=知らないコマンド */
  kind?: "done" | "view" | "needs_arg" | "delegate";
  unknown?: boolean;
  tool?: string;
  label?: string;
  view?: string;
  result?: string;
  message?: string;
  cmd?: string;
  arg?: string;
  /** その近道で出来た物（画像・資料・検索結果など）。 */
  show?: MadeItem[];
}

/**
 * POST /command — 「#画像 猫の絵」を、AIに考えさせず直行させる。
 *
 * kind が delegate / unknown のときは、ふつうの指示としてAIへ投げ直すこと。
 * # を覚えないと使えないアプリにしないための逃げ道。
 */
export async function runCommand(text: string): Promise<CommandResult> {
  const res = await fetch(`${requireApiUrl()}/command`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text }),
  });
  const d = (await res.json().catch(() => ({ ok: false }))) as CommandResult;
  return d;
}

/* ---------------- 連携待ちで預かった用事 ---------------- */
/** GET /setup/pending — 連携から戻ったときに「続きをやりますか」を出すため。 */
export async function setupPending(): Promise<{
  waiting: boolean; provider?: string; instruction?: string; auto_resume?: boolean;
}> {
  const res = await fetch(`${requireApiUrl()}/setup/pending`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) return { waiting: false };
  return (await res.json().catch(() => ({ waiting: false }))) as
    { waiting: boolean; provider?: string; instruction?: string; auto_resume?: boolean };
}

/** POST /setup/resume — 預かった用事を取り出す（実行はしない）。 */
export async function setupResume(): Promise<{
  ok: boolean; instruction?: string; auto?: boolean;
}> {
  const res = await fetch(`${requireApiUrl()}/setup/resume`, {
    method: "POST", headers: authHeaders(),
  });
  if (!res.ok) return { ok: false };
  return (await res.json().catch(() => ({ ok: false }))) as
    { ok: boolean; instruction?: string; auto?: boolean };
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

/* ---------------- HF MODELS（HuggingFaceのモデル台帳） ---------------- */
export interface HfTask {
  key: string; label: string; hf_task: string;
  input: "text" | "audio"; output: "text" | "image" | "audio" | "labels" | "vector";
  wired: string;        // 空なら「お試し実行だけ」＝まだ機能には組み込まれていない
  note: string;
}
export interface HfRole {
  key: string; label: string; task: string; where: string; model: string;
}
export interface HfModel {
  id: string; model: string; task: string; label: string; note: string;
  verified?: boolean; last_error?: string; checked_at?: string | null; created_at?: string;
}
export interface HfStatus {
  token_ready: boolean;
  tasks: HfTask[];
  roles: HfRole[];
  assignments: Record<string, string>;
  registered: number;
  by_task: Record<string, string[]>;
  suggested: Record<string, string[]>;
}
export interface HfTestResult {
  ok?: boolean; sample?: string; endpoint?: string;
  error?: string; retry?: boolean; detail?: string;
}
export interface HfRunResult {
  ok?: boolean; kind?: "text" | "image" | "audio" | "labels" | "vector";
  text?: string; url?: string; mime?: string; bytes?: number;
  labels?: { label: string; score: number }[];
  dim?: number; head?: number[]; audio_base64?: string;
  error?: string; retry?: boolean; detail?: string;
}

/** GET /hf/status — 扱えるタスク・役割の割り当て・登録数。
 *  aiConfigGet と同じ理由で、欠けた配列は空で埋める（画面を落とさない）。 */
export async function hfStatus(): Promise<HfStatus> {
  const res = await fetch(`${requireApiUrl()}/hf/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`HF status failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Partial<HfStatus>;
  return {
    token_ready: Boolean(d.token_ready),
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    roles: Array.isArray(d.roles) ? d.roles : [],
    assignments: d.assignments ?? {},
    registered: d.registered ?? 0,
    by_task: d.by_task ?? {},
    suggested: d.suggested ?? {},
  };
}

/** GET /hf/models — 登録済みモデルの台帳。 */
export async function hfModels(): Promise<HfModel[]> {
  const res = await fetch(`${requireApiUrl()}/hf/models`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`HF models failed (${res.status})`);
  const d = (await res.json()) as { models?: HfModel[] };
  return d.models ?? [];
}

/** POST /hf/models — モデルを台帳に登録する。 */
export async function hfModelAdd(opts: { model: string; task: string; label?: string; note?: string }):
  Promise<{ ok?: boolean; model?: HfModel; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/hf/models`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: opts.model, task: opts.task, label: opts.label ?? "", note: opts.note ?? "" }),
  });
  return failable(res, "登録に失敗しました");
}

/** DELETE /hf/models/{id} — 台帳から削除（割り当ても外れる）。 */
export async function hfModelDelete(id: string): Promise<{ ok?: boolean; cleared_roles?: string[] }> {
  const res = await fetch(`${requireApiUrl()}/hf/models/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: authHeaders(),
  });
  return (await res.json().catch(() => ({ ok: false })));
}

/** POST /hf/models/{id}/test — 台帳のモデルを実際に叩いて確かめる。 */
export async function hfModelTest(id: string): Promise<HfTestResult> {
  const res = await fetch(`${requireApiUrl()}/hf/models/${encodeURIComponent(id)}/test`, {
    method: "POST", headers: authHeaders(),
  });
  return failable(res, "テストに失敗しました");
}

/** POST /hf/test — 登録前にモデルIDとタスクの組み合わせを試す。 */
export async function hfTest(model: string, task: string): Promise<HfTestResult> {
  const res = await fetch(`${requireApiUrl()}/hf/test`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model, task }),
  });
  return failable(res, "テストに失敗しました");
}

/** POST /hf/assign — 役割にモデルを割り当てる（空文字で解除）。 */
export async function hfAssign(role: string, model: string):
  Promise<{ ok?: boolean; assignments?: Record<string, string>; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/hf/assign`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ role, model }),
  });
  return failable(res, "割り当てに失敗しました");
}

/** GET /hf/search — HuggingFace Hub からモデルを探す。 */
export async function hfSearch(q: string, task: string, limit = 12):
  Promise<{ ok?: boolean; models?: { id: string; downloads: number; likes: number; task: string }[];
            error?: string; suggested?: string[] }> {
  const p = new URLSearchParams({ q, task, limit: String(limit) });
  const res = await fetch(`${requireApiUrl()}/hf/search?${p}`, { headers: authHeaders(), cache: "no-store" });
  return failable(res, "検索に失敗しました");
}

/** POST /hf/run — お試し実行（結果はテキスト/画像URL/ラベル/ベクトル）。 */
export async function hfRun(opts: { model: string; task: string; text?: string; labels?: string[] }):
  Promise<HfRunResult> {
  const res = await fetch(`${requireApiUrl()}/hf/run`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: opts.model, task: opts.task, text: opts.text ?? "", labels: opts.labels ?? null }),
  });
  return failable(res, "実行に失敗しました");
}

/* ---------------- 使い方ガイド ---------------- */
export interface GuideSection {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  notes: string[];
}
/** 全モードの説明書1件（実画面つき）。 */
export interface GuideMode {
  id: string;
  label: string;      // 画面上の名前（CHAT など）
  name: string;       // 日本語の呼び名
  image: string;      // /guide/xxx.webp（実際に撮った初期画面）
  what: string;
  how: string[];
  tips: string[];
}
export interface GuideDoc {
  app: string;
  sections: GuideSection[];
  modes: GuideMode[];
  /** このアプリの持ち主か（持ち主専用モードの説明を出すかの判断に使う）。 */
  is_owner: boolean;
  section_count: number;
  mode_count: number;
  beta: boolean;
  /** true = 利用者ごとにデータが分かれていない（共有環境）。 */
  shared_data: boolean;
}

/* ---------------- その人の立場（画面の出し分け用） ---------------- */
export interface Profile {
  signed_in: boolean;
  user_id: string;
  email: string;
  /** このアプリの持ち主か。持ち主専用モードの表示可否に使う。 */
  is_owner: boolean;
  /** 持ち主だけが使えるモードのキー。 */
  owner_only_modes: string[];
  /** サーバーにオーナーが設定されているか（未設定＝1人運用）。 */
  owner_configured: boolean;
}

/**
 * GET /account/profile — 持ち主かどうか。
 *
 * 画面から隠すのは「使えない物を見せない」ためで、守りではない。
 * 実際の遮断はサーバー側（require_owner）が行う。
 */
export async function profileGet(): Promise<Profile> {
  const res = await fetch(`${requireApiUrl()}/account/profile`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Profile failed (${res.status})`);
  const d = (await res.json()) as Partial<Profile>;
  return {
    signed_in: Boolean(d.signed_in),
    user_id: d.user_id ?? "",
    email: d.email ?? "",
    is_owner: Boolean(d.is_owner),
    owner_only_modes: Array.isArray(d.owner_only_modes) ? d.owner_only_modes : [],
    owner_configured: Boolean(d.owner_configured),
  };
}

/** GET /guide — アプリの説明。CHATが答える内容と同じ出どころ。 */
export async function guideGet(): Promise<GuideDoc> {
  const res = await fetch(`${requireApiUrl()}/guide`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`Guide failed (${res.status})`);
  const d = (await res.json()) as Partial<GuideDoc>;
  return {
    app: d.app ?? "AIbou",
    sections: Array.isArray(d.sections) ? d.sections : [],
    modes: Array.isArray(d.modes) ? d.modes : [],
    is_owner: Boolean(d.is_owner),
    section_count: d.section_count ?? 0,
    mode_count: d.mode_count ?? 0,
    beta: Boolean(d.beta),
    shared_data: Boolean(d.shared_data),
  };
}

/* ---------------- 自分のデータベース（利用者ごと） ---------------- */
export interface MyDatabase {
  available: boolean;      // ログインしていないと使えない
  reason?: string;
  connected?: boolean;
  /** 個人接続は無いが、サーバーの既定DBに保存されている（持ち主のみ）。
   *  これが true のときに「保存されていません」と出すと嘘になる。 */
  using_server_db?: boolean;
  url?: string;
  masked_key?: string;
  db_url_set?: boolean;
  label?: string;
  verified_at?: string | null;
}

/** GET /account/database — 自分のDBの接続状態（鍵はマスクのみ）。 */
export async function myDatabase(): Promise<MyDatabase> {
  const res = await fetch(`${requireApiUrl()}/account/database`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`DB status failed (${res.status})`);
  return (await res.json()) as MyDatabase;
}

/** POST /account/database/test — 保存せず接続だけ試す。 */
export async function myDatabaseTest(body: { url: string; service_key: string }):
  Promise<{ ok?: boolean; tables_ready?: boolean; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/account/database/test`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return failable(res, "接続を確認できませんでした");
}

/** POST /account/database — 接続して保存する。 */
export async function myDatabaseConnect(body: {
  url: string; service_key: string; db_url?: string; label?: string;
}): Promise<MyDatabase & {
  ok?: boolean;
  tables_ready?: boolean;
  /** 実際に1行書いて消せたか。ここが false なら保存されない */
  writable?: boolean;
  /** 繋がったが保存できないときの、次にやること */
  warning?: string;
  migrate_error?: string;
  error?: string;
}> {
  const res = await fetch(`${requireApiUrl()}/account/database`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...body, db_url: body.db_url ?? "", label: body.label ?? "" }),
  });
  return failable(res, "接続に失敗しました");
}

/** POST /account/database/migrate — 自分のDBに必要なテーブルを作る。 */
export async function myDatabaseMigrate():
  Promise<{ ok?: boolean; ran?: boolean; skipped?: boolean; tables?: number; error?: string; reason?: string }> {
  const res = await fetch(`${requireApiUrl()}/account/database/migrate`, {
    method: "POST", headers: authHeaders(),
  });
  return failable(res, "テーブル作成に失敗しました");
}

/** DELETE /account/database — 接続を外す。 */
export async function myDatabaseDisconnect(): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/account/database`, {
    method: "DELETE", headers: authHeaders(),
  });
  return failable(res, "解除に失敗しました");
}

/* ---------------- Calendar (app agenda + Google merged) ---------------- */
export interface CalendarItem {
  id: string;
  title: string;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM（終日なら空）
  note: string;
  source: "app" | "google";
  url: string;
}

/** GET /agenda/calendar — アプリ内の予定と Googleカレンダーをまとめて取る。 */
export async function calendarItems(days = 30):
  Promise<{ items: CalendarItem[]; google_connected: boolean }> {
  const res = await fetch(`${requireApiUrl()}/agenda/calendar?days=${days}`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Calendar failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as
    { items?: CalendarItem[]; google_connected?: boolean };
  return {
    items: Array.isArray(d.items) ? d.items : [],
    google_connected: Boolean(d.google_connected),
  };
}

/* ---------------- X (Twitter) posting ---------------- */
export interface XStatus {
  configured: boolean;
  missing: string[];
  autopost_allowed: boolean;
  limit: number;
}

/** GET /x/status — Xに投稿できる状態か（値そのものは返らない）。 */
export async function xStatus(): Promise<XStatus> {
  const res = await fetch(`${requireApiUrl()}/x/status`, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) throw new Error(`X status failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    configured: Boolean(d.configured),
    missing: asArray<string>(d.missing),
    autopost_allowed: Boolean(d.autopost_allowed),
    limit: asNumber(d.limit, 280),
  };
}

/** POST /x/post — 実際に1件投稿する。人が押したときだけ呼ぶ。 */
export async function xPost(text: string): Promise<{ ok?: boolean; id?: string; url?: string; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/x/post`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text }),
  });
  return failable<{ ok?: boolean; id?: string; url?: string; error?: string }>(res, "投稿できませんでした");
}

/** Xの数え方に合わせた長さ（日本語は1文字＝2）。画面で事前に出すため。 */
export function xWeightedLength(text: string): number {
  let n = 0;
  for (const ch of text || "") {
    const o = ch.codePointAt(0) ?? 0;
    n += (o <= 0x10ff || (o >= 0x2000 && o <= 0x200a)
      || (o >= 0x2028 && o <= 0x202f) || (o >= 0x2060 && o <= 0x206f)) ? 1 : 2;
  }
  return n;
}

/* ---------------- Conversations (CHAT history on your own DB) ---------------- */
export interface ConversationMeta {
  id: string;
  title: string;
  updated_at?: string;
  created_at?: string;
}

export interface ConversationBody extends ConversationMeta {
  messages: { role: "user" | "assistant"; content: string }[];
}

/** GET /conversations — 一覧（本文なし）。 */
export async function conversationsList(limit = 50): Promise<ConversationMeta[]> {
  const res = await fetch(`${requireApiUrl()}/conversations?limit=${limit}`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Conversations failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return asArray<ConversationMeta>(d.items);
}

/** GET /conversations/{id} — 本文つきで1件。 */
export async function conversationGet(id: string): Promise<ConversationBody | null> {
  const res = await fetch(`${requireApiUrl()}/conversations/${encodeURIComponent(id)}`, {
    headers: authHeaders(), cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Conversation failed (${res.status})`);
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    id: String(d.id ?? id),
    title: typeof d.title === "string" ? d.title : "",
    messages: asArray<{ role: "user" | "assistant"; content: string }>(d.messages),
  };
}

/** POST /conversations — 保存（同じidなら上書き）。 */
export async function conversationSave(
  id: string,
  messages: { role: "user" | "assistant"; content: string }[],
  title = "",
): Promise<{ ok?: boolean; id?: string; title?: string; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/conversations`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id, messages, title }),
  });
  const d = (await res.json().catch(() => ({}))) as
    { ok?: boolean; id?: string; title?: string; error?: string; detail?: string };
  if (!res.ok && !d.error) return { error: d.detail ?? `保存できませんでした (${res.status})` };
  return d;
}

/** DELETE /conversations/{id} */
export async function conversationDelete(id: string): Promise<boolean> {
  const res = await fetch(`${requireApiUrl()}/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: authHeaders(),
  });
  const d = (await res.json().catch(() => ({ ok: false }))) as { ok?: boolean };
  return Boolean(d.ok);
}

/** POST /artifacts — 作ったものを自分のDBに保管する。 */
export async function artifactCreate(
  kind: string, title: string, content: string, mime = "",
): Promise<{ id?: string; error?: string }> {
  const res = await fetch(`${requireApiUrl()}/artifacts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ kind, title, content, mime }),
  });
  const d = (await res.json().catch(() => ({}))) as { id?: string; error?: string; detail?: string };
  if (!res.ok && !d.error) return { error: d.detail ?? `保管できませんでした (${res.status})` };
  return d;
}
