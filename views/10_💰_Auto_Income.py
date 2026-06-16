# views/10_💰_Auto_Income.py — Mission Control（副業オートメーション管理画面）
# 「1日1分、スマホからポチポチ承認するだけで全てが回る」セミオート承認ステーション。
# core.py の exec() で読み込まれるため st / datetime / income_engine の各関数は
# グローバル名前空間から直接利用できる。

st.markdown("""
<style>
[data-testid="stAppViewContainer"], .stApp { background-color: #0b0b12 !important; }
.mc-title { text-align:center; color:#e6e8ec; font-weight:900; letter-spacing:8px;
    font-family:'Share Tech Mono','Segoe UI',sans-serif; margin-bottom:4px; }
.mc-sub { text-align:center; color:#9aa0a8; letter-spacing:3px; font-size:12px; margin-bottom:22px; }
[data-testid="stMetric"] { background:#0b0b12; border-radius:18px; padding:16px 8px;
    box-shadow: 6px 6px 12px #000000, -6px -6px 12px #15151c; text-align:center; }
[data-testid="stMetricValue"] { color:#2b6cb0 !important; font-weight:800 !important; }
div.stButton > button { background:#0b0b12 !important; border:none !important; border-radius:12px !important;
    color:#c7ccd4 !important; font-weight:700 !important; letter-spacing:1px !important;
    box-shadow:5px 5px 10px #000000,-5px -5px 10px #15151c !important; transition:all .2s ease !important; }
div.stButton > button:hover { color:#00f3ff !important;
    box-shadow: inset 4px 4px 8px #000000, inset -4px -4px 8px #15151c !important; }
.inbox-theme { font-weight:800; color:#e6e8ec; letter-spacing:1px; font-size:16px; }
</style>
""", unsafe_allow_html=True)

st.markdown("<div class='mc-title'>💰 MISSION CONTROL</div>", unsafe_allow_html=True)
st.markdown("<div class='mc-sub'>ASSET MULTI-USE · AI INCOME ORCHESTRATOR</div>", unsafe_allow_html=True)
room_help("Auto Income")

if not globals().get("INCOME_AVAILABLE", False):
    st.error("⚠️ income_engine を読み込めませんでした。リポジトリ直下に income_engine.py があるか確認してください。")
    st.stop()

# ------------------------------------------------------------------
# 🛰️ サイドバー：システムステータス & ログ（信号機カラー）
# ------------------------------------------------------------------
_status = system_status()
def _light(ok):
    return "🟢" if ok else "🔴"

st.sidebar.markdown("---")
st.sidebar.markdown("### 🛰️ SYSTEM STATUS")
st.sidebar.write(f"{_light(_status['ai_engine'] and _status['ai_key'])} AI Engine")
st.sidebar.write(f"{_light(_status['db'])} Database (Supabase)")
_c = _status["counts"]
st.sidebar.caption("QUEUE")
st.sidebar.write(f"🟡 承認待ち {_c['pending']}　/　✅ 承認済 {_c['approved']}")
st.sidebar.write(f"🟢 完了 {_c['completed']}　/　🔴 失敗 {_c['failed']}")
_total = max(_status["total"], 1)
st.sidebar.progress(min(_c["approved"] + _c["completed"], _total) / _total, text="キュー消化率")
if not _status["db"]:
    st.sidebar.warning("DB未接続：データはこのセッション内のみ保持されます（永続化にはSupabaseのincome_jobsテーブルが必要）。")
st.sidebar.caption("※ GitHub Actions 配信レイヤ / API無料枠メーターは Phase 2 で接続予定")

# ------------------------------------------------------------------
# 🔝 TOP：KGI / KPI サマリーパネル（モチベーション管理用）
# ------------------------------------------------------------------
_stats = get_stats()
_rev = _stats.get("revenue", {}) or {}
_total_rev = sum(v for v in _rev.values() if isinstance(v, (int, float)))
try:
    _days = (datetime.date.today() - datetime.date.fromisoformat(_stats.get("uptime_start"))).days
except Exception:
    _days = 0

k1, k2, k3 = st.columns(3)
k1.metric("💴 今月の収益", f"¥{_total_rev:,.0f}")
k2.metric("👁 PV / 表示回数", f"{int(_stats.get('pv', 0)):,}")
k3.metric("⚙️ 稼働日数", f"{_days} 日")

with st.expander("▸ KPIを更新（手動入力）"):
    with st.form("kpi_form"):
        cc1, cc2, cc3 = st.columns(3)
        _ss_rev = cc1.number_input("Shutterstock収益", value=int(_rev.get("shutterstock", 0)), step=1000)
        _yt_rev = cc2.number_input("YouTube収益", value=int(_rev.get("youtube", 0)), step=1000)
        _nt_rev = cc3.number_input("note収益", value=int(_rev.get("note", 0)), step=1000)
        _pv = st.number_input("PV / 表示回数", value=int(_stats.get("pv", 0)), step=100)
        if st.form_submit_button("💾 保存", use_container_width=True):
            update_stats({
                "revenue": {"shutterstock": _ss_rev, "youtube": _yt_rev, "note": _nt_rev},
                "pv": _pv,
                "uptime_start": _stats.get("uptime_start"),
            })
            st.success("KPIを更新しました。")
            st.rerun()

# ------------------------------------------------------------------
# ⚡ 手動シード注入（強制トリガー）：要件 §4.3-4「雪のロッジ」等
# ------------------------------------------------------------------
st.markdown("---")
st.markdown("#### ⚡ 新規生成トリガー（手動シード注入）")
if "ai_theme_suggestion" not in st.session_state:
    st.session_state.ai_theme_suggestion = ""

tc1, tc2 = st.columns([4, 1])
_theme = tc1.text_input(
    "テーマ", value=st.session_state.ai_theme_suggestion,
    placeholder="例：雪のロッジ / 集中できるカフェの環境音", label_visibility="collapsed",
)
if tc2.button("🎲 AI提案", use_container_width=True):
    with st.spinner("テーマを考えています..."):
        _s = suggest_theme()
    if _s:
        st.session_state.ai_theme_suggestion = _s
        st.rerun()
    else:
        st.warning("テーマ提案に失敗しました（AIキーを確認してください）。")

if st.button("⚡ 生成して Inbox へ", use_container_width=True):
    if _theme.strip():
        with st.spinner("各媒体メタデータを生成中..."):
            _job, _msg = enqueue_theme(_theme.strip())
        st.session_state.ai_theme_suggestion = ""
        if _job and _job.get("status") != "failed":
            st.success(_msg)
        else:
            st.error(_msg)
        st.rerun()
    else:
        st.warning("テーマを入力してください。")

# ------------------------------------------------------------------
# 📥 MIDDLE：本日の生成アセット Inbox（承認待ち）
# ------------------------------------------------------------------
st.markdown("---")
_pending = list_jobs(status="pending")
_failed = list_jobs(status="failed")

h1, h2 = st.columns([3, 2])
h1.markdown(f"#### 📥 生成アセット Inbox（承認待ち {len(_pending)}）")
if _pending:
    with h2:
        if st.button("✅ Approve & Deploy All", use_container_width=True):
            _n = approve_all_pending()
            st.success(f"{_n}件を承認し、配信キューに送りました。（実配信は Phase 2 の配信レイヤが実行）")
            st.rerun()

if not _pending and not _failed:
    st.info("承認待ちのアセットはありません。上の『生成トリガー』からテーマを投入してください。")

for _job in _pending:
    _p = _job.get("payload", {}) or {}
    with st.container(border=True):
        st.markdown(f"<span class='inbox-theme'>🧩 {_job.get('theme', '(無題)')}</span>", unsafe_allow_html=True)
        st.caption(f"生成: {_job.get('created_at', '')}　ID: {str(_job.get('id', ''))[:8]}")

        t_note, t_yt, t_ss = st.tabs(["📝 note記事", "▶️ YouTube", "📷 Shutterstock"])
        with t_note:
            _note = _p.get("note", {}) or {}
            st.markdown(f"**{_note.get('title', '(タイトル未生成)')}**")
            st.markdown(_note.get("markdown", "_本文なし_"))
        with t_yt:
            _yt = _p.get("youtube", {}) or {}
            st.markdown(f"**{_yt.get('title', '')}**")
            st.write(_yt.get("description", ""))
            if _yt.get("timestamps"):
                st.markdown("**タイムスタンプ**\n" + "\n".join(f"- {x}" for x in _yt["timestamps"]))
            if _yt.get("hashtags"):
                st.caption(" ".join(_yt["hashtags"]))
        with t_ss:
            _ss = _p.get("shutterstock", {}) or {}
            st.markdown(f"**{_ss.get('title_en', '')}**")
            _tags = _ss.get("tags", []) or []
            st.caption(f"{len(_tags)} tags（50個以内）")
            st.write(", ".join(_tags))

        if globals().get("ASSET_AVAILABLE", False):
            with st.expander("🎨 アセット試作（サムネ / 環境音 / AI画像）"):
                a1, a2, a3 = st.columns(3)
                if a1.button("🖼 サムネ生成", key=f"btn_thumb_{_job['id']}", use_container_width=True):
                    st.session_state[f"out_thumb_{_job['id']}"] = generate_thumbnail(
                        _job.get("theme", ""), subtitle=(_p.get("youtube", {}) or {}).get("title", ""))
                if a2.button("🔊 環境音10秒", key=f"btn_amb_{_job['id']}", use_container_width=True):
                    st.session_state[f"out_amb_{_job['id']}"] = generate_ambient_wav(_job.get("theme", ""), duration_sec=10)
                if a3.button("🖌 AI画像(Gemini)", key=f"btn_img_{_job['id']}", use_container_width=True):
                    try:
                        import key_manager as _km
                        _common = (st.session_state.get("global_api_keys", {}) or {}).get("gemini", "") or get_secret("GEMINI_API_KEY")
                        _prov, _ikey = _km.resolve_key("asset_image", slots=st.session_state.get("key_slots", {}), common=_common)
                    except Exception:
                        _ikey = ""
                    _prompt = (_p.get("shutterstock", {}) or {}).get("title_en") or _job.get("theme", "")
                    with st.spinner("画像生成中..."):
                        st.session_state[f"out_img_{_job['id']}"] = generate_image(_prompt, gemini_key=_ikey)
                _t = st.session_state.get(f"out_thumb_{_job['id']}")
                if _t:
                    st.image(_t, caption="サムネイル試作（1280x720）", use_container_width=True)
                _aw = st.session_state.get(f"out_amb_{_job['id']}")
                if _aw and _aw[0]:
                    st.caption(f"環境音タイプ: {_aw[1]}")
                    st.audio(_aw[0], format="audio/wav")
                _im = st.session_state.get(f"out_img_{_job['id']}")
                if _im and _im[0]:
                    st.image(_im[0], caption=f"AI画像（{_im[1]}）", use_container_width=True)
                    if _im[1] == "placeholder":
                        st.caption("※ Gemini画像キー未設定 or モデル未対応のため簡易サムネを表示中。Settings→🔑用途別APIキーで asset_image にキーを設定してください。")

        b1, b2 = st.columns(2)
        if b1.button("✅ 承認（配信キューへ）", key=f"ap_{_job['id']}", use_container_width=True):
            st.success(approve_job(_job["id"]))
            st.rerun()
        if b2.button("🗑️ 差し戻して再生成", key=f"rj_{_job['id']}", use_container_width=True):
            with st.spinner("再生成中..."):
                _, _m = reject_and_regenerate(_job["id"])
            st.info(_m)
            st.rerun()

# ------------------------------------------------------------------
# ⚠️ 生成失敗ジョブ（再試行可能）
# ------------------------------------------------------------------
if _failed:
    st.markdown("#### ⚠️ 生成失敗（再試行可能）")
    for _job in _failed:
        with st.container(border=True):
            st.markdown(f"**{_job.get('theme', '')}**")
            st.caption(str(_job.get("log", ""))[:200])
            f1, f2 = st.columns(2)
            if f1.button("🔄 再生成", key=f"re_{_job['id']}", use_container_width=True):
                with st.spinner("再生成中..."):
                    _, _m = reject_and_regenerate(_job["id"])
                st.info(_m)
                st.rerun()
            if f2.button("🗑️ 削除（却下）", key=f"de_{_job['id']}", use_container_width=True):
                reject_job(_job["id"])
                st.rerun()
