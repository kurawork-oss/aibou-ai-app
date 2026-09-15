"use client";

/**
 * ModelRouter — どの仕事を、どのAIへ回すか（仕様§15・§16）。
 *
 * なぜ要るか
 * ----------
 * AIは1つではない。得意が違うし、料金も違う。
 *
 *   ふつうの会話       … 速さと無料枠がすべて
 *   こみ入ったコード   … 得意なモデルがある
 *   人に見せたくない物 … 外へ出したくない（手元のOllama）
 *
 * いちばん大事な決まり
 * --------------------
 * **勝手に課金しない。** 鍵を入れただけの従量課金サービスを、こちらの
 * 判断で使い始めてはいけない。請求は使う人に行く。鍵を入れる理由は
 * 「たまに使いたい」であって「これから全部これで」ではない。
 *
 * だから画面でも、お金がかかる提供元には**その印を出す**。選ぶのは本人。
 *
 * 何も選ばなければ、無料の中から自動で決まる（既定は Gemini）。
 */

import { useCallback, useEffect, useState } from "react";

import {
  API_URL, aiRoutesGet, aiRoutesSet, type AiRoutes,
} from "@/lib/api";

/** 仕事の名前を、人の言葉にする。 */
const TASK_LABEL: Record<string, string> = {
  chat: "ふつうの会話",
  code: "コードを書く・直す",
  long: "長い文章をまとめる",
  private: "人に見せたくない物",
  vision: "画像を見て答える",
};

const TASK_HINT: Record<string, string> = {
  private: "手元のOllamaがあれば、外へ出さずに処理します",
};

export default function ModelRouter() {
  const [data, setData] = useState<AiRoutes | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      setData(await aiRoutesGet());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "取得できませんでした");
    }
  }, []);

  useEffect(() => { if (API_URL) void load(); }, [load]);

  if (!API_URL || !data) return null;

  const ready = data.providers.filter((p) => p.ready);

  const choose = async (task: string, provider: string) => {
    setBusy(task);
    setErr("");
    try {
      setData(await aiRoutesSet(task, provider));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="mb-4 rounded-forge border border-panel p-3">
      <div className="mb-1 text-[10px] tracking-[0.2em] text-muted label-mono">
        どのAIに任せるか
      </div>
      <p className="mb-2.5 text-[11px] leading-relaxed text-muted">
        何も選ばなければ、<b className="text-fg">無料で使えるものから自動</b>で決まります。
        お金がかかるAIは、<b className="text-fg">ここで選んだ仕事にだけ</b>使います
        （鍵を入れただけでは使いません）。
      </p>

      {err && <p className="mb-2 text-[11px] text-[#ff9b9b]">⚠ {err}</p>}

      {ready.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted">
          使えるAIがまだありません。設定 →「つなぐ」 に鍵を入れてください
          （GEMINI_API_KEY には無料枠があります）。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {data.tasks.map((task) => (
            /* 名前を付けた箱にする。付けないと、外から「この仕事の欄」を
               名指しできない（テストが入れ子のどこかを掴んで、たまたま
               通ったり落ちたりする）。読み上げにも効く。 */
            <div key={task} role="group" aria-label={TASK_LABEL[task] || task}
                 className="rounded-forge border border-panel p-2.5">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[12px] text-fg-strong">
                  {TASK_LABEL[task] || task}
                </span>
                <span className="flex-1" />
                <span className="text-[10px] text-muted label-mono">
                  いま: {label(data, data.routes[task])}
                </span>
              </div>
              {TASK_HINT[task] && (
                <p className="mb-1 text-[10px] leading-relaxed text-muted">{TASK_HINT[task]}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Pick
                  on={!data.named[task]}
                  busy={busy === task}
                  onClick={() => void choose(task, "")}
                >
                  おまかせ
                </Pick>
                {ready.map((p) => (
                  <Pick
                    key={p.id}
                    on={data.named[task] === p.id}
                    busy={busy === task}
                    onClick={() => void choose(task, p.id)}
                  >
                    {p.label}{p.paid ? " ¥" : ""}
                  </Pick>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 何が使えて、どれがお金のかかる物か。鍵の値は出さない（名前だけ）。 */}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted">
          使えるAIの一覧（{ready.length} / {data.providers.length}）
        </summary>
        <ul className="mt-1.5 flex list-none flex-col gap-1 p-0">
          {data.providers.map((p) => (
            <li key={p.id} className="text-[11px] leading-relaxed">
              <span style={{ color: p.ready ? "var(--accent)" : "var(--muted)" }}>
                {p.ready ? "✓" : "—"}
              </span>{" "}
              <span className="text-fg">{p.label}</span>
              {p.paid && <span className="text-[10px] text-muted"> ¥ かかります</span>}
              <span className="block pl-4 text-muted">
                {p.note}{!p.ready && `（${p.key} が未設定）`}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function label(data: AiRoutes, id: string): string {
  if (!id || id === "none") return "なし";
  return data.providers.find((p) => p.id === id)?.label || id;
}

function Pick({ on, busy, onClick, children }: {
  on: boolean; busy: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={on}
      className="min-h-[44px] rounded-forge border px-3 text-[11px] transition disabled:opacity-40"
      style={{
        borderColor: on ? "var(--accent)" : "var(--panel-bd)",
        color: on ? "var(--fg-strong)" : "var(--muted)",
        background: on ? "var(--btn-bg)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}
