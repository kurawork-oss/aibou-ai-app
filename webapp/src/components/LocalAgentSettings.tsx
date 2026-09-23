"use client";

/**
 * 手元のパソコンを繋ぐ画面（仕様§29〜§31）。
 *
 * 何台でも繋げる
 * --------------
 * 最初は1台ぶんの表示だった。「スマホとノートPCとデスクトップで使いたい」で
 * 足りなくなった——**ノートとデスクトップは両方繋いだままにしたい**。
 * スマホには相棒が要らない（ブラウザだけで動く）。
 *
 * だから一覧にする。そして**名前を付けられる**ようにする。2台あるときに
 * 「ノートの資料を読んで」と言えないと、どちらに頼んだのか分からない。
 *
 * ここで気をつけること
 * --------------------
 * 合言葉は**この1回しか表示できない**。サーバーには照合用の形でしか
 * 残っていないので、見せようがない。だから
 *
 *   ・出したらすぐ写せるようにする（押すだけで写る）
 *   ・「あとで見られます」とは書かない
 *   ・無くしたらその台だけ作り直せる、と先に書いておく
 *
 * そして「合言葉を作った」と「いま動いている」を**台ごとに**分けて出す。
 * 作っただけで「繋がりました」と出すと、頼んだあとで無言のまま返事が
 * 来なくなり、どこが悪いのか分からなくなる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, authHeaders } from "@/lib/api";

interface Device {
  device: string;
  name: string;
  online: boolean;
  waiting?: number;
  last_seen_ago?: number | null;
}

interface Status {
  paired: boolean;
  online: boolean;
  devices?: Device[];
  why?: string;
  next?: string;
}

async function call<T>(path: string, body?: unknown): Promise<T | null> {
  if (!API_URL) return null;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
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
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  /* 追い越しを捨てる。開いた直後に「合言葉を作る」を押すと、先に始まった
     読み込みが後から返って、作る前の状態で上書きすることがある。 */
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const got = await call<Status>("/local/status");
    if (mine !== seq.current) return;
    if (got) { setSt(got); setFailed(""); } else { setFailed("状態を取得できませんでした"); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 動き出したのが分かるように、繋いだ直後はしばらく見に行く
  useEffect(() => {
    if (!fresh) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [fresh, load]);

  const pair = useCallback(async () => {
    setBusy(true);
    setCopied(false);
    const got = await call<{ ok?: boolean; token?: string; name?: string; error?: string }>(
      "/local/pair", { name: newName.trim() || "パソコン" });
    setBusy(false);
    if (got?.token) {
      setFresh({ token: got.token, name: got.name || "" });
      setAdding(false);
      setNewName("");
      void load();
    } else {
      setFailed(got?.error || "合言葉を作れませんでした");
    }
  }, [newName, load]);

  const drop = useCallback(async (d: Device) => {
    if (!window.confirm(`「${d.name}」の繋ぎを切ります。この台の合言葉は使えなくなります。`)) return;
    setBusy(true);
    await call("/local/unpair", { device: d.device });
    setBusy(false);
    void load();
  }, [load]);

  const rename = useCallback(async (d: Device) => {
    const name = window.prompt("この台の名前", d.name);
    if (!name || name.trim() === d.name) return;
    setBusy(true);
    await call("/local/rename", { device: d.device, name: name.trim() });
    setBusy(false);
    void load();
  }, [load]);

  const copy = useCallback(async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [fresh]);

  const devices = st?.devices ?? [];
  const live = devices.filter((d) => d.online).length;

  return (
    <section className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">手元のパソコン</span>
        <span className="text-[10px] label-mono"
              style={{ color: live ? "var(--accent)" : "var(--muted)" }}>
          {failed ? failed
            : live ? `${live}台が動いています`
            : st?.paired ? "動いていません" : "未接続"}
        </span>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        ブラウザからは、パソコンの中のファイルを読めません（読めたら、どのサイトからも
        読めることになるので）。小さなプログラムを手元で動かすと、
        <b className="text-fg-strong">Obsidianの日誌に書き足す・決めたフォルダの資料を読む</b>
        ができるようになります。
        <b className="text-fg-strong">ノートPCとデスクトップを、両方繋いだままにできます</b>
        （スマホには要りません）。
      </p>

      {/* 繋いである台の一覧。台ごとに「動いているか」を分けて出す。 */}
      {devices.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {devices.map((d) => (
            <div key={d.device} className="flex items-center gap-2 rounded-forge border border-panel p-2">
              <span className="shrink-0 text-[11px]"
                    style={{ color: d.online ? "var(--accent)" : "var(--muted)" }}>
                {d.online ? "●" : "○"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-fg-strong">{d.name}</div>
                <div className="text-[10px] text-muted">
                  {d.online ? "動いています"
                    : d.last_seen_ago === null || d.last_seen_ago === undefined
                      ? "まだ一度も動いていません"
                      : `最後に来たのは${d.last_seen_ago}秒前`}
                </div>
              </div>
              <button type="button" disabled={busy}
                aria-label={`${d.name} の名前を変える`}
                onClick={() => void rename(d)}
                className="shrink-0 text-[10px] text-muted underline label-mono disabled:opacity-40">
                名前
              </button>
              <button type="button" disabled={busy}
                aria-label={`${d.name} の繋ぎを切る`}
                onClick={() => void drop(d)}
                className="shrink-0 text-[10px] text-muted underline label-mono disabled:opacity-40">
                切る
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 動いている台が2つ以上あるときは、頼み方が変わる。先に言っておく。 */}
      {live > 1 && (
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          2台以上動いているので、<b className="text-fg-strong">どちらに頼むかは名前で言ってください</b>
          （「ノートの資料を読んで」）。言わなかったときは、勝手に選ばずに聞き返します。
        </p>
      )}

      {st?.paired && !live && st.why && (
        <p className="mb-2 text-[11px] leading-relaxed" style={{ color: "#ffd060" }}>
          {st.why}
          {st.next && <><br />{st.next}</>}
        </p>
      )}

      {fresh ? (
        <div className="mb-2 rounded-forge border border-[var(--line)] p-2">
          <div className="mb-1 text-[11px] text-fg-strong">
            「{fresh.name}」の合言葉ができました。<b>この画面を閉じると二度と見られません。</b>
          </div>
          <pre className="mb-1 overflow-x-auto whitespace-pre-wrap break-all rounded-forge bg-[var(--input-bg)] p-2 text-[11px] text-fg-strong label-mono">
            {fresh.token}
          </pre>
          <button type="button" onClick={() => void copy()}
            className="rounded-forge border px-3 py-1 text-[10px] label-mono"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}>
            {copied ? "写しました" : "写す"}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            その<b className="text-fg-strong">パソコンで</b>、こう動かします
            （<span className="label-mono">agent_local/</span> の中）:
          </p>
          <pre className="mt-1 overflow-x-auto rounded-forge bg-[var(--input-bg)] p-2 text-[10px] text-muted label-mono">
{`python aibou_local.py \\
  --url ${API_URL || "https://あなたのAPI"} \\
  --token 上の合言葉 \\
  --dir ~/AIbou`}
          </pre>
        </div>
      ) : null}

      {/* 足す。名前を先に決めてもらう——あとから変えられるが、
          2台目を足す時点で名前が付いていないと、どちらか分からない。 */}
      {adding ? (
        <div className="flex gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void pair(); }}
            placeholder="この台の名前（例：しごとのノート）"
            aria-label="この台の名前"
            autoFocus
            className="min-w-0 flex-1 rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-2.5 py-2 text-sm text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
          />
          <button type="button" disabled={busy} onClick={() => void pair()}
            className="shrink-0 rounded-forge border px-3 py-2 text-[11px] disabled:opacity-40"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}>
            合言葉を作る
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button type="button" disabled={busy} onClick={() => setAdding(true)}
            className="rounded-forge border px-3 py-1.5 text-[11px] disabled:opacity-40"
            style={{ borderColor: "var(--btn-bd)", background: "var(--btn-bg)", color: "var(--fg-strong)" }}>
            {devices.length ? "もう1台つなぐ" : "合言葉を作る"}
          </button>
        </div>
      )}

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        触ってよいフォルダは、パソコン側で決めます（<span className="label-mono">--dir</span>）。
        サーバーからは指定できません。消す操作とコマンド実行は
        <b className="text-fg-strong">作っていません</b>。
      </p>

      {/* ここを書かないと、いちばん価値のある使い方に気づかれない。
          同時に、いちばん危ない使い方でもあるので、条件も一緒に出す。 */}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted">
          ログインが要るサイトも見せる（あなたのブラウザを動かす）
        </summary>
        <div className="mt-1.5 text-[11px] leading-relaxed text-muted">
          <p>
            サーバー側のブラウザは<b className="text-fg-strong">誰にもログインしていません</b>。
            社内ツールや会員サイトの中は、そこからは見えません。
            手元のブラウザを使うと、あなたがログインしたまま読めます。
          </p>
          <pre className="mt-1.5 overflow-x-auto rounded-forge bg-[var(--input-bg)] p-2 text-[10px] label-mono">
{`--allow-browser --site 社内ツールのドメイン`}
          </pre>
          <p className="mt-1.5">
            <b className="text-fg-strong">開いてよいサイトを先に決めます</b>
            （「全部」は選べません）。読むだけの操作と、押す・打ち込む操作は
            分けてあり、<b className="text-fg-strong">押すほうは設定に関わらず必ず確認します</b>。
            パスワードをAIbouに渡すことはありません——ログインは一度、
            ご自身の手で通します。
          </p>
        </div>
      </details>
    </section>
  );
}
