"use client";

/**
 * 手元のパソコンで動く相棒を、繋ぐ画面（仕様§29〜§31）。
 *
 * ここで気をつけること
 * --------------------
 * 合言葉は**この1回しか表示できない**。サーバーには照合用の形でしか
 * 残っていないので、見せようがない。だから
 *
 *   ・出したらすぐ写せるようにする（押すだけで写る）
 *   ・「あとで見られます」とは書かない
 *   ・無くしたら作り直せる、と先に書いておく
 *
 * そして「合言葉を作った」と「いま動いている」を**分けて**出す。
 * 作っただけで「繋がりました」と出すと、頼んだあとで無言のまま返事が
 * 来なくなり、どこが悪いのか分からなくなる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, authHeaders } from "@/lib/api";

interface Status {
  paired: boolean;
  online: boolean;
  name?: string;
  waiting?: number;
  last_seen_ago?: number | null;
  why?: string;
  next?: string;
}

async function get<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: authHeaders({ "Content-Type": "application/json" }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default function LocalAgentSettings() {
  const [st, setSt] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  /* 追い越しを捨てる。開いた直後に「合言葉を作る」を押すと、先に始まった
     読み込みが後から返って、作る前の状態で上書きすることがある。 */
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const got = await get<Status>("/local/status");
    if (mine !== seq.current) return;
    if (got) { setSt(got); setFailed(false); } else { setFailed(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 動き出したのが分かるように、繋いだ直後はしばらく見に行く
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [token, load]);

  const pair = useCallback(async () => {
    setBusy(true);
    setCopied(false);
    const got = await get<{ token?: string }>("/local/pair",
      { method: "POST", body: JSON.stringify({ name: "パソコン" }) });
    setBusy(false);
    if (got?.token) { setToken(got.token); void load(); }
    else setFailed(true);
  }, [load]);

  const unpair = useCallback(async () => {
    if (!window.confirm("繋ぎを切ります。いまの合言葉は使えなくなります。")) return;
    setBusy(true);
    await get("/local/unpair", { method: "POST" });
    setBusy(false);
    setToken("");
    void load();
  }, [load]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [token]);

  return (
    <section className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">手元のパソコン</span>
        <span className="text-[10px] label-mono"
              style={{ color: st?.online ? "var(--accent)" : "var(--muted)" }}>
          {failed ? "状態を取得できませんでした"
            : st?.online ? "繋がっています"
            : st?.paired ? "動いていません" : "未接続"}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        ブラウザからは、パソコンの中のファイルを読めません（読めたら、どのサイトからも
        読めることになるので）。小さなプログラムを手元で動かすと、
        <b className="text-fg-strong">Obsidianの日誌に書き足す・決めたフォルダの資料を読む</b>
        ができるようになります。
      </p>

      {/* 「合言葉を作った」と「いま動いている」は別のこと。分けて出す。 */}
      {st?.paired && !st.online && (
        <p className="mb-2 text-[11px] leading-relaxed" style={{ color: "#ffd060" }}>
          {st.why}
          {st.next && <><br />{st.next}</>}
        </p>
      )}

      {token ? (
        <div className="mb-2 rounded-forge border border-[var(--line)] p-2">
          <div className="mb-1 text-[11px] text-fg-strong">
            合言葉ができました。<b>この画面を閉じると二度と見られません。</b>
          </div>
          <pre className="mb-1 overflow-x-auto whitespace-pre-wrap break-all rounded-forge bg-[var(--input-bg)] p-2 text-[11px] text-fg-strong label-mono">
            {token}
          </pre>
          <button type="button" onClick={() => void copy()}
            className="rounded-forge border px-3 py-1 text-[10px] label-mono"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}>
            {copied ? "写しました" : "写す"}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            パソコンで、こう動かします（<span className="label-mono">agent_local/</span> の中）:
          </p>
          <pre className="mt-1 overflow-x-auto rounded-forge bg-[var(--input-bg)] p-2 text-[10px] text-muted label-mono">
{`python aibou_local.py \\
  --url ${API_URL || "https://あなたのAPI"} \\
  --token 上の合言葉 \\
  --dir ~/AIbou`}
          </pre>
        </div>
      ) : null}

      <div className="flex gap-1.5">
        <button type="button" disabled={busy} onClick={() => void pair()}
          className="rounded-forge border px-3 py-1.5 text-[11px] disabled:opacity-40"
          style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}>
          {st?.paired ? "合言葉を作り直す" : "合言葉を作る"}
        </button>
        {st?.paired && (
          <button type="button" disabled={busy} onClick={() => void unpair()}
            className="rounded-forge border border-panel px-3 py-1.5 text-[11px] text-muted disabled:opacity-40">
            繋ぎを切る
          </button>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        触ってよいフォルダは、パソコン側で決めます（<span className="label-mono">--dir</span>）。
        サーバーからは指定できません。消す操作とコマンド実行は
        <b className="text-fg-strong">作っていません</b>。
      </p>
    </section>
  );
}
