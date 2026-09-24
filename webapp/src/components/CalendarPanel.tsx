"use client";

/**
 * CalendarPanel — 予定を月のカレンダーで見る。
 *
 * これまで予定は「次の数件」が箇条書きで並ぶだけだった。それだと
 * 「来週の火曜は空いているか」が分からない。Googleカレンダーを繋いだ人は
 * なおさら、アプリの中で形が見えないと繋いだ実感がない。
 *
 * アプリ内の予定とGoogleの予定を1枚にまとめ、出どころだけ印で分ける。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarItems, openConnect, type CalendarItem } from "@/lib/api";
import {
  groupByDate, monthCells, monthLabel, shiftMonth, WEEKDAYS, ymd,
} from "@/lib/calendar";
import { explain } from "@/lib/needs";

export default function CalendarPanel() {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month0, setMonth0] = useState(today.getMonth());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [googleOn, setGoogleOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(ymd(today));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 表示中の月をまたいで取れるよう、少し広めに取る
      const r = await calendarItems(90);
      setItems(r.items);
      setGoogleOn(r.google_connected);
    } catch (e) {
      setError(explain(e, "予定の読み込み"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byDate = useMemo(() => groupByDate(items), [items]);
  const cells = useMemo(() => monthCells(year, month0), [year, month0]);
  const todayStr = ymd(today);
  const dayItems = byDate[picked] ?? [];

  const move = (d: number) => {
    const n = shiftMonth(year, month0, d);
    setYear(n.year);
    setMonth0(n.month0);
  };

  return (
    <div className="panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => move(-1)} aria-label="前の月"
                  className="rounded-forge border border-panel px-2 py-1 text-[11px] text-muted">‹</button>
          <span className="text-[12px] text-fg-strong tabular-nums">{monthLabel(year, month0)}</span>
          <button type="button" onClick={() => move(1)} aria-label="次の月"
                  className="rounded-forge border border-panel px-2 py-1 text-[11px] text-muted">›</button>
          <button type="button"
                  onClick={() => { setYear(today.getFullYear()); setMonth0(today.getMonth()); setPicked(todayStr); }}
                  className="ml-1 rounded-forge border border-panel px-2 py-1 text-[10px] text-muted label-mono">
            今日
          </button>
        </div>
        <span className="text-[10px] text-muted label-mono">
          {googleOn ? "◆ Google カレンダー連携中" : "アプリ内の予定のみ"}
        </span>
      </div>

      {error && <p className="mb-2 text-[11px] leading-relaxed text-[#ff9b9b]">⚠️ {error}</p>}

      <div className="grid grid-cols-7 gap-px text-center">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className="pb-1 text-[9px] label-mono"
               style={{ color: i === 0 ? "#ff9b9b" : i === 6 ? "#8ab4f8" : "var(--muted)" }}>
            {w}
          </div>
        ))}
        {cells.map((c) => {
          const evs = byDate[c.date] ?? [];
          const isToday = c.date === todayStr;
          const isPicked = c.date === picked;
          return (
            <button
              key={c.date}
              type="button"
              onClick={() => setPicked(c.date)}
              aria-label={`${c.date} の予定 ${evs.length}件`}
              aria-pressed={isPicked}
              className="min-h-[42px] rounded border p-1 text-left transition"
              style={{
                borderColor: isPicked ? "var(--accent)" : "transparent",
                background: isToday ? "var(--btn-bg)" : "transparent",
                opacity: c.inMonth ? 1 : 0.35,
              }}
            >
              <span className="block text-[10px] tabular-nums"
                    style={{ color: isToday ? "var(--fg-strong)" : "var(--muted)" }}>
                {c.day}
              </span>
              {/* 件数を数字で出すより、点のほうが一目で密度が分かる */}
              <span className="mt-0.5 flex flex-wrap gap-[2px]">
                {evs.slice(0, 3).map((e, i) => (
                  <span key={i} className="inline-block h-[4px] w-[4px] rounded-full"
                        style={{ background: e.source === "google" ? "#8ab4f8" : "var(--accent)" }} />
                ))}
                {evs.length > 3 && <span className="text-[11px] text-muted">+{evs.length - 3}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 border-t border-panel pt-2">
        <div className="mb-1 text-[10px] tracking-[0.16em] text-muted label-mono">{picked}</div>
        {loading ? (
          <p className="text-[11px] text-muted">読み込み中…</p>
        ) : dayItems.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted">
            この日の予定はありません。会話で「{picked.slice(5).replace("-", "月")}日15時に打ち合わせ」
            のように頼むと登録できます。
          </p>
        ) : (
          <ul className="grid gap-1">
            {dayItems.map((e, i) => (
              <li key={`${e.id}-${i}`} className="flex items-baseline gap-2 text-[11px]">
                <span className="w-10 shrink-0 tabular-nums text-muted label-mono">{e.time || "終日"}</span>
                <span className="min-w-0 flex-1 text-fg">
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer" className="underline">{e.title}</a>
                  ) : e.title}
                  {e.note && <span className="ml-1 text-muted">{e.note}</span>}
                </span>
                <span className="shrink-0 text-[9px] label-mono"
                      style={{ color: e.source === "google" ? "#8ab4f8" : "var(--accent)" }}>
                  {e.source === "google" ? "Google" : "アプリ"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!googleOn && (
        <p className="mt-2 border-t border-panel pt-2 text-[10px] leading-relaxed text-muted">
          Googleカレンダーを繋ぐと、こちらの予定もここに並びます。
          <button type="button" onClick={() => void openConnect("google")}
             className="ml-1 text-[var(--accent)] underline">Googleと接続</button>
        </p>
      )}
    </div>
  );
}
