# billing.py — Stripe サブスクリプション課金レイヤ（Auto Income 解放用）
# =====================================================================
# 設計方針：
#  * STRIPE_SECRET_KEY / STRIPE_PRICE_ID / APP_BASE_URL が揃ったときのみ有効。
#  * Webサーバ常駐が不要な構成：
#      1) Checkout（サブスク）へ誘導 → 決済後 APP_BASE_URL?checkout=success に復帰
#      2) 復帰時に Session を検証して profiles.income_status='active' に更新
#      3) アクセス毎に Stripe の購読状態を確認（解約の反映＝サーバ不要のフォールバック）
#  * 厳密な解約即時反映が必要なら supabase/functions/stripe-webhook を併用。
#  * すべて try/except。stripe 未導入/未設定でも例外で落とさない。
# =====================================================================

import streamlit as st


def _stripe(get_secret):
    key = get_secret("STRIPE_SECRET_KEY", "")
    if not key:
        return None
    try:
        import stripe
        stripe.api_key = key
        return stripe
    except Exception:
        return None


def enabled(get_secret):
    return _stripe(get_secret) is not None and bool(get_secret("STRIPE_PRICE_ID", ""))


def _base_url(get_secret):
    return str(get_secret("APP_BASE_URL", "") or "").rstrip("/")


def create_checkout_url(get_secret, user):
    """サブスク用 Checkout セッションを作成し、その URL を返す。(url, error)。"""
    stripe = _stripe(get_secret)
    if not stripe:
        return None, "Stripe が未設定です（STRIPE_SECRET_KEY）。"
    price = get_secret("STRIPE_PRICE_ID", "")
    if not price:
        return None, "STRIPE_PRICE_ID が未設定です。"
    base = _base_url(get_secret)
    if not base:
        return None, "APP_BASE_URL が未設定です（決済後の戻り先）。"
    try:
        params = {
            "mode": "subscription",
            "line_items": [{"price": price, "quantity": 1}],
            "success_url": f"{base}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{base}/?checkout=cancel",
            "client_reference_id": user.get("id", ""),
            "allow_promotion_codes": True,
        }
        cust = user.get("stripe_customer_id")
        if cust:
            params["customer"] = cust
        elif user.get("email"):
            params["customer_email"] = user["email"]
        sess = stripe.checkout.Session.create(**params)
        return sess.url, None
    except Exception as e:
        return None, f"Checkout 作成に失敗：{e}"


def handle_return(supabase, get_secret, user):
    """決済からの復帰（?checkout=success&session_id=...）を検証して購読を有効化。
    戻り値：ユーザー向けメッセージ or None。"""
    try:
        qp = st.query_params
        status = qp.get("checkout")
    except Exception:
        return None
    if not status:
        return None

    msg = None
    stripe = _stripe(get_secret)
    if status == "success" and stripe and user and user.get("id"):
        try:
            sid = st.query_params.get("session_id")
            if sid:
                sess = stripe.checkout.Session.retrieve(sid, expand=["subscription", "customer"])
                paid = (getattr(sess, "payment_status", "") == "paid") or \
                       (getattr(sess, "status", "") == "complete")
                if paid:
                    cust_id = getattr(sess, "customer", None)
                    if hasattr(cust_id, "id"):
                        cust_id = cust_id.id
                    sub = getattr(sess, "subscription", None)
                    sub_id = sub.id if hasattr(sub, "id") else sub
                    try:
                        import auth as _auth
                        _auth.set_stripe(supabase, user["id"], customer_id=cust_id,
                                         subscription_id=sub_id, income_status="active")
                        _auth.refresh_profile(supabase)
                    except Exception:
                        pass
                    msg = "✅ サブスクリプションが有効になりました。Auto Income をご利用いただけます。"
        except Exception as e:
            msg = f"決済の確認に失敗しました：{e}"
    elif status == "cancel":
        msg = "決済はキャンセルされました。"

    # クエリをクリア（リロード時の二重処理防止）
    try:
        for k in ("checkout", "session_id"):
            if k in st.query_params:
                del st.query_params[k]
    except Exception:
        try:
            st.query_params.clear()
        except Exception:
            pass
    return msg


def sync_status(supabase, get_secret, user):
    """Stripe 側の購読状態をアプリに反映（解約の反映＝Webhook無しのフォールバック）。
    戻り値：'active' / 'inactive' / None（判定不可）。"""
    stripe = _stripe(get_secret)
    if not (stripe and user):
        return None
    cust = user.get("stripe_customer_id")
    if not cust:
        return None
    try:
        subs = stripe.Subscription.list(customer=cust, status="active", limit=1)
        active = bool(getattr(subs, "data", []) or [])
        new_status = "active" if active else "inactive"
        if new_status != user.get("income_status"):
            try:
                import auth as _auth
                _auth.set_income_status(supabase, user["id"], new_status)
                _auth.refresh_profile(supabase)
            except Exception:
                pass
        return new_status
    except Exception:
        return None
