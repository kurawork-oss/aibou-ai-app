"use client";

/**
 * Extensions — 「拡張機能」モード。連携をサービス単位で選ぶ。
 *
 * これまでは設定のKEYCHAINに鍵の名前が縦に並ぶだけだった。
 * GITHUB_TOKEN と書かれていても、入れると何ができるようになるのかが
 * 分からないので、結局だれも入れない。
 *
 * ここでは「LINE」のような見慣れた名前と印を先に見せ、押したら
 * ①何ができるようになるか ②必要な値 ③取り方 ④保存 の順で出す。
 * つないだ直後に、その場で試せるようにもする（通知はテスト送信）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  API_URL, connectDisconnect, connectStartUrl, connectStatus, deleteKey, googleStatus,
  keyOrphans, keyRescue, listKeys, myDatabase, profileGet, rulesSync, sendNotify, setKey,
  type ApiKeyInfo, type ConnectProvider, type GoogleStatus, type OrphanKey,
} from "@/lib/api";
import {
  EXTENSIONS, GROUP_LABEL, GROUP_ORDER, NO_KEY_FEATURES, isConnected, visibleExtensions,
  type Extension,
} from "@/lib/extensions";
import { explain } from "@/lib/needs";
import BrandIcon from "@/components/BrandIcon";
import MyDatabase from "@/components/MyDatabase";

export default function Extensions({ onNavigate }: { onNavigate?: (v: "guide") => void }) {
  const [keysSet, setKeysSet] = useState<Set<string>>(new Set());
  const [keyInfo, setKeyInfo] = useState<Map<string, ApiKeyInfo>>(new Map());
  const [orphans, setOrphans] = useState<OrphanKey[]>([]);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  // 押すだけで繋げる先の状態（提供元ごと）。key → 状態。
  const [providers, setProviders] = useState<Map<string, ConnectProvider>>(new Map());
  const [dbOn, setDbOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Extension | null>(null);

  const load = useCallback(async () => {
    if (!API_URL) { setLoading(false); return; }
    setError(null);
    const [keys, prof, g, db, orph, conn] = await Promise.all([
      listKeys().catch((e) => { setError(explain(e, "連携状況の読み込み")); return null; }),
      profileGet().catch(() => null),
      googleStatus().catch(() => null),
      myDatabase().catch(() => null),
      keyOrphans().catch(() => null),
      connectStatus().catch(() => null),
    ]);
    if (keys) {
      setKeysSet(new Set(keys.filter((k) => k.set).map((k) => k.name)));
      setKeyInfo(new Map(keys.map((k) => [k.name, k])));
    }
    if (prof) setIsOwner(Boolean(prof.is_owner));
    setGoogle(g);
    setProviders(new Map((conn?.providers ?? []).map((p) => [p.key, p])));
    setOrphans(orph?.items ?? []);
    // 既定DBに保存されている人も「保存先は決まっている」ので済み扱いにする
    setDbOn(Boolean(db?.connected) || Boolean(db?.using_server_db));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const exts = useMemo(() => visibleExtensions(isOwner), [isOwner]);

  /** 連携済みか。
   *
   * 押すだけで繋げる先は「許可」が済んでいれば連携済み。まだなら、手で貼った
   * 鍵でも動くので、そちらも見る（両方の道を塞がない）。 */
  const connectedOf = useCallback((e: Extension) => {
    if (e.oauth && providers.get(e.oauth)?.connected) return true;
    if (e.kind === "oauth") return Boolean(google?.connected);
    if (e.kind === "database") return dbOn;
    return isConnected(e, keysSet);
  }, [google, providers, keysSet, dbOn]);

  const doneCount = exts.filter((e) => connectedOf(e) === true).length;

  /** 入っているが、更新すると消える鍵。 */
  const volatile = useMemo(
    () => [...keyInfo.values()].filter((k) => k.set && k.where === "memory"),
    [keyInfo],
  );

  if (!API_URL) {
    return (
      <div className="panel p-6 text-center text-[11px] leading-relaxed text-muted">
        連携は、バックエンドに繋がってから使えます。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pb-2">
      <div className="panel p-3">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[10px] tracking-[0.2em] text-muted label-mono">連携</span>
          <span className="text-[10px] text-muted label-mono">{doneCount} / {exts.length} 連携済み</span>
        </div>
        <p className="text-[11px] leading-relaxed text-fg">
          使いたいサービスを選んでつなぐと、その分だけできることが増えます。
          <span className="text-muted">つながなくても、CHATと基本の機能は動きます。</span>
        </p>
      </div>

      {error && <div className="panel p-3 text-[11px] leading-relaxed text-[#ff9b9b]">⚠️ {error}</div>}

      {/* 前の保存先に残っている鍵。「入れたのに未設定に戻った」の正体はこれ */}
      {orphans.length > 0 && <RescueBanner items={orphans} onDone={() => void load()} />}

      {/* 更新すると消える鍵。持っていること自体は伝わっているので、
          消えてから気づくのではなく、いま伝える */}
      {volatile.length > 0 && (
        <div className="panel p-3 text-[11px] leading-relaxed"
             style={{ borderColor: "#ffd07f55", color: "#ffd07f" }}>
          ⚠️ 次の鍵は、いまサーバーのメモリにだけ置かれています。アプリを更新すると消えます:
          <span className="text-fg-strong"> {volatile.map((k) => k.label || k.name).join("、")}</span>
          <br />
          <span className="text-muted">
            「連携」の Supabase で保存先をつなぐと、更新しても残るようになります。
          </span>
        </div>
      )}

      {loading ? (
        <div className="panel p-6 text-center text-[10px] tracking-[0.2em] text-muted label-mono">
          ◈ LOADING…
        </div>
      ) : (
        GROUP_ORDER.map((g) => {
          const items = exts.filter((e) => e.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g}>
              <div className="mb-1.5 text-[10px] tracking-[0.2em] text-muted label-mono">
                {GROUP_LABEL[g]}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((e) => (
                  <Card key={e.id} ext={e} state={connectedOf(e)} onOpen={() => setOpen(e)} />
                ))}
              </div>
            </div>
          );
        })
      )}

      {/* 一覧に無い＝できない、と読めてしまうので、無いことの意味を書く */}
      <details className="panel p-3">
        <summary className="cursor-pointer text-[11px] text-fg">
          鍵を入れなくても、もう使えるもの
        </summary>
        <div className="mt-2 grid gap-1.5">
          {NO_KEY_FEATURES.map((f) => (
            <div key={f.title} className="text-[11px] leading-relaxed">
              <span className="text-fg-strong">{f.title}</span>
              <span className="ml-1.5 text-[10px] text-muted label-mono">{f.where}</span>
              <p className="text-muted">{f.detail}</p>
            </div>
          ))}
        </div>
      </details>

      <p className="px-1 text-[10px] leading-relaxed text-muted/70">
        入れた値はサーバーで暗号化して保管され、画面には伏せ字でしか出ません。
        いつでも「連携を外す」で消せます。
        {onNavigate && (
          <button type="button" onClick={() => onNavigate("guide")}
                  className="ml-1 text-[var(--accent)] underline">
            説明書を見る
          </button>
        )}
      </p>

      {open && (
        <Detail
          ext={open}
          connected={connectedOf(open)}
          google={google}
          provider={open.oauth ? providers.get(open.oauth) : undefined}
          info={keyInfo}
          onClose={() => setOpen(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

/* ── 鍵がどこに入っているか ───────────────────────────────────────
   「設定済み」だけでは、更新で消えるものと残るものが見分けられない。  */
function WhereBadge({ info }: { info?: ApiKeyInfo }) {
  if (!info?.set) return null;
  const s = info.where === "db"
    ? { text: "保存済み", color: "#60d394" }
    : info.where === "server"
      ? { text: "サーバー設定", color: "var(--muted)" }
      : { text: "一時・更新で消えます", color: "#ffd07f" };
  return (
    <span className="ml-1.5 text-[10px] label-mono" style={{ color: s.color }}>
      {info.masked} · {s.text}
    </span>
  );
}

/* ── 前の保存先に取り残された鍵 ───────────────────────────────────
   利用者ごとにDBを分ける前、鍵はサーバー既定のDBに入っていた。
   あとから自分のDBを繋ぐと読む先がそちらに変わるので、前に入れた鍵が
   「未設定」に見える。消えたのではなく、前の場所に残っている。      */
function RescueBanner({ items, onDone }: { items: OrphanKey[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await keyRescue(items.map((i) => i.name));
      setNote(r.count > 0 ? `${r.count}件を取り込みました` : "取り込めるものがありませんでした");
      onDone();
    } catch (e) {
      setNote(explain(e, "取り込み"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel p-3" style={{ borderColor: "#ffd07f55" }}>
      <div className="mb-1 text-[11px] leading-relaxed" style={{ color: "#ffd07f" }}>
        以前この端末で入れた鍵が、いまの保存先とは別の場所に残っています。
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        自分のデータベースを繋ぐ前に保存したものです。消えてはいません。
        取り込むと、いまの保存先へ写して、そのまま使えるようになります。
      </p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i.name}
                className="rounded-forge border border-panel px-2 py-1 text-[10px] text-fg label-mono">
            {i.label} <span className="text-muted">{i.masked}</span>
          </span>
        ))}
      </div>
      <button type="button" onClick={() => void run()} disabled={busy}
              className="rounded-forge border px-3 py-2 text-[11px] label-mono disabled:opacity-40"
              style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}>
        {busy ? "…" : "いまの保存先に取り込む"}
      </button>
      {note && <p role="status" aria-live="polite" className="mt-1.5 text-[11px] text-muted">{note}</p>}
    </div>
  );
}

/* ── カード ───────────────────────────────────────────────────── */
function Card({ ext, state, onOpen }:
  { ext: Extension; state: boolean | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="panel flex w-full items-start gap-2.5 p-3 text-left transition hover:shadow-glow"
    >
      <span className="mt-0.5 shrink-0"><BrandIcon id={ext.id} size={24} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-fg-strong">{ext.name}</span>
          {state === true && <span className="shrink-0 text-[10px]" style={{ color: "#60d394" }}>✓ 連携済み</span>}
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{ext.tagline}</span>
      </span>
    </button>
  );
}

/* ── 詳細（本文に出す。祖先の transform に captured されないように） ── */
function Detail({ ext, connected, google, provider, info, onClose, onChanged }: {
  ext: Extension;
  provider?: ConnectProvider;
  connected: boolean | null;
  google: GoogleStatus | null;
  info: Map<string, ApiKeyInfo>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  // 押すだけで繋げる先では、貼る欄は「使わなくてよい道」。前に出さない。
  const foldKeys = Boolean(provider) || ext.fields.some((f) => f.appOnly);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  /** この連携の鍵が、保存先に残っていない（更新すると消える）。 */
  const fragile = ext.fields.some((f) => {
    const k = info.get(f.name);
    return Boolean(k?.set) && k?.where === "memory";
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const entries = ext.fields
        .map((f) => [f.name, (values[f.name] ?? "").trim()] as const)
        .filter(([, v]) => v !== "");
      if (entries.length === 0) {
        setNote({ text: "値を入れてから保存してください", ok: false });
        return;
      }
      // 「保存しました」と言い切れるのは、本当に残ったときだけ。
      // 書けていないのに成功と出すと、次の更新で消えた理由が分からなくなる。
      const warnings: string[] = [];
      for (const [name, value] of entries) {
        const r = await setKey(name, value);
        if (!r.persisted && r.warning) warnings.push(r.warning);
      }
      setValues({});
      onChanged();
      setNote(warnings.length > 0
        ? { text: warnings[0], ok: false }
        : { text: "保存しました", ok: true });
    } catch (e) {
      setNote({ text: explain(e, "保存"), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`${ext.name} の連携を外しますか？（保存した値を消します）`)) return;
    setBusy(true);
    setNote(null);
    try {
      for (const f of ext.fields) await deleteKey(f.name).catch(() => false);
      onChanged();
      setNote({ text: "連携を外しました", ok: true });
    } finally {
      setBusy(false);
    }
  };

  /** GitHubのメモを取り込む。読み込みはここだけで、会話中には走らせない。 */
  const syncRules = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await rulesSync();
      if (r.count === 0) {
        setNote({ text: r.warning || "読めるメモがありませんでした", ok: false });
      } else {
        const kinds = r.by_applies || {};
        const detail = [
          kinds.always ? `常時${kinds.always}` : "",
          kinds.tool ? `ツール${kinds.tool}` : "",
          kinds.mode ? `モード${kinds.mode}` : "",
          kinds.topic ? `話題${kinds.topic}` : "",
        ].filter(Boolean).join("・");
        setNote({
          text: `${r.count}件のルールを取り込みました${detail ? `（${detail}）` : ""}`
              + (r.persisted ? "" : "。ただし保存先に書けていないため、更新すると消えます"),
          ok: r.persisted,
        });
      }
      onChanged();
    } catch (e) {
      setNote({ text: explain(e, "ルールの同期"), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await sendNotify(`AIbou のテスト送信です（${ext.name}）`);
      const mine = r.results?.find((x) => x.channel === ext.id);
      if (mine?.ok) setNote({ text: "送りました。届いているか確認してください", ok: true });
      else if (mine?.error) setNote({ text: mine.error, ok: false });
      else setNote({ text: "まだ設定が足りないため送れませんでした", ok: false });
    } catch (e) {
      setNote({ text: explain(e, "テスト送信"), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-[rgba(4,6,12,0.72)] p-3 backdrop-blur-sm"
         onClick={onClose}>
      <div className="panel my-6 w-full max-w-lg p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <BrandIcon id={ext.id} size={26} />
            <div className="min-w-0">
              <div className="truncate text-[15px] text-fg-strong">{ext.name}</div>
              <div className="text-[11px] text-muted">{ext.tagline}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="閉じる"
                  className="shrink-0 rounded-forge border border-panel px-2 py-1 text-[11px] text-muted">✕</button>
        </div>

        {connected === true && (
          fragile ? (
            /* いま動くことと、残ることは別。緑で「できています」と出したうえで
               下の欄に「消えます」と書くと、どちらを信じればいいか分からない。 */
            <div className="mb-2 rounded-forge border p-2 text-[11px] leading-relaxed"
                 style={{ borderColor: "#ffd07f55", color: "#ffd07f" }}>
              いまは使えますが、この鍵は保存先に残っていません。アプリを更新すると消えます。
            </div>
          ) : (
            <div className="mb-2 rounded-forge border p-2 text-[11px]"
                 style={{ borderColor: "#60d39455", color: "#60d394" }}>
              ✓ 連携できています
            </div>
          )
        )}

        {/* ① 何ができるようになるか。ここが「入れる理由」 */}
        <div className="mb-3 rounded-forge border border-panel p-2.5">
          <div className="mb-1 text-[10px] tracking-[0.16em] text-muted label-mono">
            連携すると、できるようになること
          </div>
          <ul className="ml-4 list-disc space-y-0.5 text-[11px] leading-relaxed text-fg">
            {ext.unlocks.map((u) => <li key={u}>{u}</li>)}
          </ul>
        </div>

        {ext.warning && (
          <p className="mb-3 rounded-forge border p-2 text-[11px] leading-relaxed"
             style={{ borderColor: "#ffd07f55", color: "#ffd07f" }}>
            {ext.warning}
          </p>
        )}

        {/* ② 保存先はここで直接つなぐ。
            以前は「設定→KEYCHAINへ」と案内していたが、拡張機能を開いた人が
            そこから設定できないなら、拡張機能である意味がない。 */}
        {ext.kind === "database" && (
          <div className="mb-3">
            <MyDatabase compact />
          </div>
        )}

        {/* ③ まずは「押すだけ」。鍵を貼る道は、その下に畳んで残す。 */}
        {provider && (
          <div className="mb-3">
            {provider.configured ? (
              <>
                {provider.connected ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {provider.account && (
                      <span className="rounded-forge border border-panel px-2 py-1 text-[11px] text-fg">
                        {provider.account} と繋がっています
                      </span>
                    )}
                    <button type="button" disabled={busy}
                            onClick={() => { setBusy(true); void connectDisconnect(provider.key)
                              .finally(() => { setBusy(false); onChanged(); }); }}
                            className="rounded-forge border border-panel px-3 py-2 text-[11px] text-[#ff9b9b] label-mono disabled:opacity-40">
                      連携を解除
                    </button>
                  </div>
                ) : (
                  <a href={connectStartUrl(provider.key)} target="_blank" rel="noreferrer"
                     className="inline-flex min-h-[44px] items-center rounded-forge border px-3.5 text-[12px] label-mono"
                     style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}>
                    {provider.label}と連携する
                  </a>
                )}
                {provider.note && !provider.connected && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{provider.note}</p>
                )}
              </>
            ) : (
              /* 「持ち主の登録がまだ」と「この人がまだ許可していない」は別のこと。
                 混ぜると、利用者が自分では直せないことを直そうとして詰まる。 */
              <p className="rounded-forge border p-2 text-[11px] leading-relaxed"
                 style={{ borderColor: "#ffd07f55", color: "#ffd07f" }}>
                このアプリの持ち主が {provider.label} へのアプリ登録をまだ済ませていないため、
                押すだけの連携は使えません。下の欄に値を貼れば、いまでも使えます。
              </p>
            )}
          </div>
        )}

        {/* ④ 値の入力。
            「押すだけ」で済むようになった今、貼る欄は主役ではない。
            ・アプリ登録の値（appOnly）は持ち主がサーバーに置く物なので常に畳む
            ・繋がっているなら、貼る欄も畳む（両方の道は残すが、前には出さない） */}
        {ext.fields.length > 0 && (
          <div className="mb-3 grid gap-1.5">
            {foldKeys && (
              <button type="button" onClick={() => setShowKeys((v) => !v)}
                      className="self-start rounded-forge border border-panel px-3 py-2 text-[11px] text-muted label-mono">
                {showKeys ? "▲ 手で入れる欄を隠す" : "▼ 手で入れる（上級者向け）"}
              </button>
            )}
            {(!foldKeys || showKeys) && ext.fields.map((f) => (
              <div key={f.name}>
                <label htmlFor={`ext-${f.name}`}
                       className="text-[10px] tracking-[0.14em] text-muted label-mono">
                  {f.label}
                </label>
                <WhereBadge info={info.get(f.name)} />
                <input
                  id={`ext-${f.name}`}
                  value={values[f.name] ?? ""}
                  onChange={(e) => { setValues((v) => ({ ...v, [f.name]: e.target.value })); setNote(null); }}
                  type={f.secret ? "password" : "text"}
                  placeholder={f.placeholder ?? (connected ? "設定済み（変えるときだけ入力）" : "")}
                  /* ブラウザの自動入力に、保存済みのログイン情報を差し込まれないようにする */
                  name={`ext-${f.name}`}
                  autoComplete={f.secret ? "new-password" : "off"}
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  className="mt-0.5 min-h-[44px] w-full rounded-forge border border-[var(--input-bd)] bg-[var(--input-bg)] px-3 text-[13px] text-fg-strong placeholder:text-muted focus:border-[var(--line)] focus:outline-none"
                />
              </div>
            ))}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(!foldKeys || showKeys) && (
              <button type="button" onClick={() => void save()} disabled={busy}
                      className="rounded-forge border px-3 py-2 text-[11px] label-mono disabled:opacity-40"
                      style={{ borderColor: "var(--accent)", color: "var(--fg-strong)", background: "var(--btn-bg)" }}>
                {busy ? "…" : "保存する"}
              </button>
              )}
              {connected === true && (
                <button type="button" onClick={() => void remove()} disabled={busy}
                        className="rounded-forge border border-panel px-3 py-2 text-[11px] text-[#ff9b9b] label-mono disabled:opacity-40">
                  連携を外す
                </button>
              )}
              {/* つないだ直後に試せる。届かないことに後で気づくのが一番困る */}
              {ext.group === "notify" && connected === true && (
                <button type="button" onClick={() => void test()} disabled={busy}
                        className="rounded-forge border border-panel px-3 py-2 text-[11px] text-fg-strong label-mono disabled:opacity-40">
                  テスト送信
                </button>
              )}
              {/* ルールは「同期したときだけ」GitHubを読む。
                  会話のたびに読むと、その往復がそのまま返事の待ち時間になる。 */}
              {ext.id === "rules" && connected === true && (
                <button type="button" onClick={() => void syncRules()} disabled={busy}
                        className="rounded-forge border border-panel px-3 py-2 text-[11px] text-fg-strong label-mono disabled:opacity-40">
                  ルールを同期
                </button>
              )}
            </div>
          </div>
        )}

        {/* どのアカウントに作られるのかを先に見せる。
            「作ったと言われたのにドライブに無い」の原因が、見に行ったのと
            違うアカウントに繋いでいた、ということがある。 */}
        {ext.oauth === "google" && provider?.connected && provider.account && (
          <p className="mb-2 rounded-forge border border-panel p-2 text-[11px] leading-relaxed text-muted">
            ファイルは <span className="text-fg-strong">{provider.account}</span> のドライブに作られます。
            別のアカウントのドライブを見ていると、見つかりません。
          </p>
        )}

        {note && (
          <p role="status" aria-live="polite" className="mb-2 text-[11px] leading-relaxed"
             style={{ color: note.ok ? "#60d394" : "#ff9b9b" }}>
            {note.text}
          </p>
        )}

        {/* ⑤ 取り方。ここが無いと、値を持っていない人はここで止まる */}
        <details open={connected !== true}>
          <summary className="cursor-pointer text-[11px] text-[var(--accent)]">
            値のとり方（画面の手順）
          </summary>
          <ol className="ml-4 mt-1.5 list-decimal space-y-1 text-[11px] leading-relaxed text-muted">
            {ext.howto.map((h) => <li key={h}>{h}</li>)}
          </ol>
        </details>
      </div>
    </div>
  );

  // 祖先に transform があると position:fixed がその中に閉じ込められる（GUIDEで踏んだ）
  return mounted ? createPortal(body, document.body) : null;
}
