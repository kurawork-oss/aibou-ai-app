"use client";

/**
 * CapabilityPanel — 「いま何ができて、何ができないか」を1画面で。
 *
 * なぜ要るか
 * ----------
 * できることは30以上あり、どれが**いま本当に使えるか**は鍵・連携・保存先・
 * 機能のパックが絡み合って決まる。これまでその答えは1か所に無く、利用者は
 * **押して失敗してから**理由を知っていた。
 *
 *     「Notionから議事録を探して」→ 実行 → 失敗 →「Notionが繋がっていません」
 *
 * 先に分かっていれば、失敗する必要はない。
 *
 * 出し方の決め
 * ------------
 *   ・使えない物を**上**に出す。ここを開く人が知りたいのは、そちら
 *   ・「使えません」で終わらせない。理由と、次に押す場所を必ず書く
 *   ・押しても始まらない物（持ち主のアプリ登録がまだ）は、**ボタンを出さない**。
 *     出すと、押しても何も起きないボタンを何度も押させることになる
 *   ・使える物は畳んでおく。全部広げると、長いだけで読まれない
 */

import { useCallback, useEffect, useState } from "react";

import { API_URL, capabilityStatus, type CapabilityState } from "@/lib/api";

/** 状態ごとの見せ方。ここに無い状態が来たら「調べられなかった」に寄せる。 */
const LOOK: Record<CapabilityState["status"], { mark: string; word: string; tone: string }> = {
  connected: { mark: "✓", word: "つながっている", tone: "var(--accent)" },
  available: { mark: "✓", word: "使える", tone: "var(--accent)" },
  not_connected: { mark: "—", word: "つないでいない", tone: "var(--muted)" },
  authentication_required: { mark: "!", word: "つなぎ直しが要る", tone: "#ffd07f" },
  permission_required: { mark: "!", word: "権限が足りない", tone: "#ffd07f" },
  configuration_required: { mark: "…", word: "設定が要る", tone: "#ffd07f" },
  unavailable: { mark: "·", word: "使わない設定", tone: "var(--muted)" },
  error: { mark: "⚠", word: "調べられなかった", tone: "#ff9b9b" },
};

const USABLE = new Set(["connected", "available"]);

export default function CapabilityPanel() {
  const [items, setItems] = useState<CapabilityState[] | null>(null);
  const [err, setErr] = useState("");
  const [showOk, setShowOk] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      setItems(await capabilityStatus());
    } catch (e) {
      /* 取れなかったことを黙って空で見せない。空の一覧は「何も使えない」と
         読めてしまい、実際とは違う。 */
      setErr(e instanceof Error ? e.message : "状態を取得できませんでした");
      setItems([]);
    }
  }, []);

  useEffect(() => { if (API_URL) void load(); }, [load]);

  if (!API_URL) return null;

  if (items === null) {
    return <p className="mb-4 text-[11px] text-muted">いまの状態を調べています…</p>;
  }

  const ng = items.filter((c) => !USABLE.has(c.status));
  const ok = items.filter((c) => USABLE.has(c.status));

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] tracking-[0.2em] text-muted label-mono">SELF CHECK</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-[44px] rounded-forge border border-panel px-3 text-[11px] text-muted transition hover:text-fg-strong"
        >
          調べ直す
        </button>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        いま <b className="text-fg">{ok.length}</b> 件が使えます。
        {ng.length > 0 && <> あと <b className="text-fg">{ng.length}</b> 件は、下のとおりです。</>}
      </p>

      {err && (
        <p className="mb-2 rounded-forge border border-panel p-2 text-[11px] text-[#ff9b9b]">
          ⚠ {err}
        </p>
      )}

      {/* 使えない物が先。ここを開く人が知りたいのはそちら。 */}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {ng.map((c) => <Row key={c.id} cap={c} />)}
      </ul>

      {ok.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowOk((v) => !v)}
            aria-expanded={showOk}
            className="mt-2 min-h-[44px] w-full rounded-forge border border-panel px-3 text-left text-[11px] text-muted transition hover:text-fg-strong"
          >
            使えるもの {ok.length}件 {showOk ? "▲" : "▼"}
          </button>
          {showOk && (
            <ul className="mt-1.5 flex list-none flex-col gap-1.5 p-0">
              {ok.map((c) => <Row key={c.id} cap={c} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Row({ cap }: { cap: CapabilityState }) {
  const look = LOOK[cap.status] ?? LOOK.error;
  const act = cap.action;
  /* 押しても始まらない物にはボタンを出さない。出すと、何も起きないボタンを
     押し続けることになる（持ち主のアプリ登録がまだ、がこれ）。 */
  const canGo = !cap.needs_owner && act?.kind === "oauth" && act.path;

  return (
    <li className="rounded-forge border border-panel p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-[12px]" style={{ color: look.tone }}>{look.mark}</span>
        <span className="min-w-0 flex-1 text-[12px] text-fg-strong">{cap.name}</span>
        <span className="shrink-0 text-[10px] label-mono" style={{ color: look.tone }}>
          {look.word}
        </span>
      </div>
      {cap.account && (
        <p className="mt-0.5 pl-5 text-[10px] text-muted">{cap.account}</p>
      )}
      {cap.why && (
        <p className="mt-1 pl-5 text-[11px] leading-relaxed text-muted">{cap.why}</p>
      )}
      {cap.next && (
        <p className="mt-0.5 pl-5 text-[11px] leading-relaxed text-muted">→ {cap.next}</p>
      )}
      {canGo && (
        <a
          href={`${API_URL}${act!.path}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 ml-5 inline-flex min-h-[44px] items-center rounded-forge border px-3 text-[11px] label-mono"
          style={{ borderColor: "var(--accent)", color: "var(--fg-strong)",
                   background: "var(--btn-bg)" }}
        >
          いま繋ぐ
        </a>
      )}
    </li>
  );
}
