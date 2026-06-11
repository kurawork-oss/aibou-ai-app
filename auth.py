# auth.py — Supabase Auth によるマルチアカウント認証レイヤ
# =====================================================================
# 設計方針：
#  * AUTH_MODE=supabase のときのみ本物の認証を使う。未設定/legacy のときは
#    core.py 側の従来「共有パスワード」にフォールバック（既存アプリを壊さない）。
#  * すべて try/except で安全に倒す（絶対に raise してアプリを落とさない）。
#  * ログイン後はユーザーの JWT を postgrest に適用し、RLS で行レベル分離する。
#
# 公開API（core.py / views から利用）：
#  mode / enabled / restore_session / render_login / sign_out
#  current_user / is_owner / income_active / refresh_profile
#  list_profiles / set_role / set_income_status / set_stripe(...)
# =====================================================================

import streamlit as st
import datetime

# 利用規約（新規登録時に同意を必須化）
TERMS_TEXT = """
#### 利用規約・プライバシーの確認（要約）
1. 本サービスはAIによる文章・画像・コード生成等の補助を提供します。生成物の最終確認と利用責任は利用者にあります。
2. 入力内容・生成物は機能提供のためクラウド（Supabase等）に暗号化または通常の形式で保存される場合があります。
3. 各種APIキー等の秘密情報はアカウント毎に暗号化して保管されます。第三者と共有しないでください。
4. 「副業自動化（Auto Income）」など一部機能は有料（サブスクリプション）です。
5. 法令・各連携サービスの規約に反する利用、他者の権利侵害、不正アクセスを禁止します。
6. 提供者は、可用性・生成結果の正確性を保証せず、利用により生じた損害について責任を負いません。
7. 本規約は予告なく改定される場合があります。
"""


def mode(get_secret):
    """'supabase' か 'legacy'。既定は legacy（明示的に切替えるまで挙動を変えない）。"""
    try:
        m = str(get_secret("AUTH_MODE", "legacy") or "legacy").strip().lower()
        return "supabase" if m in ("supabase", "supa", "auth") else "legacy"
    except Exception:
        return "legacy"


def enabled(get_secret, supabase):
    return mode(get_secret) == "supabase" and supabase is not None


# ---------------------------------------------------------------------
# セッション復元（毎回の再実行で JWT を postgrest に適用）
# ---------------------------------------------------------------------
def _apply_token(supabase):
    tok = st.session_state.get("sb_access_token")
    rtok = st.session_state.get("sb_refresh_token")
    if not tok:
        return False
    # 期限切れに備えて set_session でリフレッシュ（失敗しても postgrest.auth は当てる）
    try:
        if rtok:
            sess = supabase.auth.set_session(tok, rtok)
            new = getattr(sess, "session", None) or getattr(sess, "data", None)
            at = getattr(new, "access_token", None) if new else None
            rt = getattr(new, "refresh_token", None) if new else None
            if at:
                st.session_state.sb_access_token = at
                tok = at
            if rt:
                st.session_state.sb_refresh_token = rt
    except Exception:
        pass
    try:
        supabase.postgrest.auth(tok)
        return True
    except Exception:
        return False


def restore_session(supabase):
    """ログイン済みなら current_user(dict) を返す。未ログインなら None。"""
    if not _apply_token(supabase):
        return None
    user = st.session_state.get("current_user")
    if user:
        return user
    return None


# ---------------------------------------------------------------------
# profile 読み込み / owner 自己修復
# ---------------------------------------------------------------------
def _load_profile(supabase, uid, email, get_secret):
    prof = {}
    try:
        res = supabase.table("profiles").select("*").eq("id", uid).limit(1).execute()
        if res.data:
            prof = res.data[0]
    except Exception:
        prof = {}

    # trigger 未導入などで未作成の場合のフォールバック作成
    if not prof:
        try:
            supabase.table("profiles").insert(
                {"id": uid, "email": email, "role": "user"}
            ).execute()
            prof = {"id": uid, "email": email, "role": "user", "income_status": "inactive"}
        except Exception:
            prof = {"id": uid, "email": email, "role": "user", "income_status": "inactive"}

    # OWNER_EMAIL に一致するなら owner を保証（オーナーが常に統制を取り戻せる安全弁）
    try:
        owner_email = str(get_secret("OWNER_EMAIL", "") or "").strip().lower()
        if owner_email and email and email.strip().lower() == owner_email and prof.get("role") != "owner":
            supabase.table("profiles").update({"role": "owner"}).eq("id", uid).execute()
            prof["role"] = "owner"
    except Exception:
        pass
    return prof


def _set_current_user(supabase, session_obj, user_obj, get_secret):
    """サインイン/アップ成功時：トークン保存＋profile読込＋current_user確定。"""
    at = getattr(session_obj, "access_token", None)
    rt = getattr(session_obj, "refresh_token", None)
    if at:
        st.session_state.sb_access_token = at
    if rt:
        st.session_state.sb_refresh_token = rt
    _apply_token(supabase)

    uid = getattr(user_obj, "id", None)
    email = getattr(user_obj, "email", None) or ""
    prof = _load_profile(supabase, uid, email, get_secret) if uid else {}
    st.session_state.current_user = {
        "id": uid,
        "email": email,
        "role": prof.get("role", "user"),
        "income_status": prof.get("income_status", "inactive"),
        "stripe_customer_id": prof.get("stripe_customer_id"),
        "stripe_subscription_id": prof.get("stripe_subscription_id"),
        "accepted_terms_at": prof.get("accepted_terms_at"),
    }
    st.session_state.logged_in = True
    st.session_state.show_loading = True  # ログイン直後にロード画面(スプラッシュ)を表示


def refresh_profile(supabase):
    """DBの最新 profile を current_user に反映（課金/権限変更の即時反映用）。"""
    user = st.session_state.get("current_user") or {}
    uid = user.get("id")
    if not uid:
        return
    try:
        res = supabase.table("profiles").select("*").eq("id", uid).limit(1).execute()
        if res.data:
            p = res.data[0]
            user.update({
                "role": p.get("role", user.get("role", "user")),
                "income_status": p.get("income_status", user.get("income_status", "inactive")),
                "stripe_customer_id": p.get("stripe_customer_id"),
                "stripe_subscription_id": p.get("stripe_subscription_id"),
                "accepted_terms_at": p.get("accepted_terms_at"),
            })
            st.session_state.current_user = user
    except Exception:
        pass


# ---------------------------------------------------------------------
# 権限ヘルパ
# ---------------------------------------------------------------------
def current_user():
    return st.session_state.get("current_user")


def is_owner(user=None):
    user = user or current_user() or {}
    return user.get("role") == "owner"


def income_active(user=None):
    """Auto Income を使えるか：owner は常に可。それ以外は課金 active のみ。"""
    user = user or current_user() or {}
    return is_owner(user) or user.get("income_status") == "active"


# ---------------------------------------------------------------------
# サインアウト
# ---------------------------------------------------------------------
def sign_out(supabase):
    try:
        supabase.auth.sign_out()
    except Exception:
        pass
    for k in ("sb_access_token", "sb_refresh_token", "current_user",
              "global_api_keys", "key_slots", "vault_unlocked"):
        st.session_state.pop(k, None)
    st.session_state.logged_in = False


# ---------------------------------------------------------------------
# owner 用：ユーザー管理
# ---------------------------------------------------------------------
def list_profiles(supabase):
    try:
        res = supabase.table("profiles").select("*").order("created_at", desc=False).execute()
        return res.data or []
    except Exception:
        return []


def set_role(supabase, uid, role):
    try:
        supabase.table("profiles").update({"role": role}).eq("id", uid).execute()
        return True
    except Exception:
        return False


def set_income_status(supabase, uid, status):
    try:
        supabase.table("profiles").update({"income_status": status}).eq("id", uid).execute()
        return True
    except Exception:
        return False


def set_stripe(supabase, uid, customer_id=None, subscription_id=None, income_status=None):
    patch = {}
    if customer_id is not None:
        patch["stripe_customer_id"] = customer_id
    if subscription_id is not None:
        patch["stripe_subscription_id"] = subscription_id
    if income_status is not None:
        patch["income_status"] = income_status
    if not patch:
        return False
    try:
        supabase.table("profiles").update(patch).eq("id", uid).execute()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------
# ログイン / 新規登録 UI（成功時は rerun、未ログインのまま戻ったら呼び出し側で st.stop()）
# ---------------------------------------------------------------------
def render_login(supabase, get_secret):
    _l, _c, _r = st.columns([1, 18, 1])
    with _c:
        with st.container(border=True):
            _li, _lc, _lr = st.columns([1, 1, 1])
            with _lc:
                try:
                    st.image("assets/aibou_icon.png", width=78)
                except Exception:
                    pass
            st.markdown("<div class='login-title'>相棒AI</div>"
                        "<div class='login-sub'>起動シークエンス</div>", unsafe_allow_html=True)

            tab_login, tab_signup = st.tabs(["🔓 ログイン", "✨ 新規登録"])

            with tab_login:
                email = st.text_input("メールアドレス", key="login_email")
                pw = st.text_input("パスワード", type="password", key="login_pw")
                if st.button("ログイン", use_container_width=True, type="primary", key="btn_login"):
                    try:
                        res = supabase.auth.sign_in_with_password({"email": email.strip(), "password": pw})
                        sess = getattr(res, "session", None)
                        usr = getattr(res, "user", None)
                        if sess and usr:
                            _set_current_user(supabase, sess, usr, get_secret)
                            st.rerun()
                        else:
                            st.error("ログインに失敗しました。メール確認が未完了の可能性があります。")
                    except Exception as e:
                        st.error(f"ログインに失敗しました：{e}")

            with tab_signup:
                s_email = st.text_input("メールアドレス", key="signup_email")
                s_pw = st.text_input("パスワード（8文字以上推奨）", type="password", key="signup_pw")
                s_pw2 = st.text_input("パスワード（確認）", type="password", key="signup_pw2")
                with st.expander("📜 利用規約を読む", expanded=False):
                    st.markdown(TERMS_TEXT)
                agreed = st.checkbox("利用規約に同意します", key="signup_agree")
                if st.button("アカウントを作成", use_container_width=True, type="primary", key="btn_signup"):
                    if not s_email.strip() or not s_pw:
                        st.error("メールアドレスとパスワードを入力してください。")
                    elif s_pw != s_pw2:
                        st.error("パスワード（確認）が一致しません。")
                    elif not agreed:
                        st.error("利用規約への同意が必要です。")
                    else:
                        try:
                            res = supabase.auth.sign_up({"email": s_email.strip(), "password": s_pw})
                            usr = getattr(res, "user", None)
                            sess = getattr(res, "session", None)
                            # 規約同意時刻を記録（profile は trigger が作成。後追いで update）
                            if usr is not None:
                                try:
                                    supabase.table("profiles").update(
                                        {"accepted_terms_at": datetime.datetime.utcnow().isoformat()}
                                    ).eq("id", getattr(usr, "id", "")).execute()
                                except Exception:
                                    pass
                            if sess and usr:
                                # メール確認OFFの場合は即ログイン
                                _set_current_user(supabase, sess, usr, get_secret)
                                st.success("アカウントを作成しました。")
                                st.rerun()
                            else:
                                st.success("確認メールを送信しました。メール内のリンクで認証後、ログインしてください。")
                        except Exception as e:
                            st.error(f"登録に失敗しました：{e}")
