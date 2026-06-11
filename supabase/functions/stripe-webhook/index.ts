// Supabase Edge Function — Stripe Webhook（サブスク状態を profiles に反映）
// =====================================================================
// これは「任意」だが推奨。これがあると解約/支払い失敗が即座に income_status へ反映される。
// （アプリ側 billing.sync_status() はアクセス時のフォールバック同期も行う）
//
// デプロイ：
//   supabase functions deploy stripe-webhook --no-verify-jwt
// シークレット設定：
//   supabase secrets set STRIPE_SECRET_KEY=sk_live_... \
//       STRIPE_WEBHOOK_SECRET=whsec_... \
//       SUPABASE_URL=https://<ref>.supabase.co \
//       SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
// Stripe ダッシュボード → Developers → Webhooks にこの関数URLを登録し、
//   checkout.session.completed / customer.subscription.* を購読する。
// =====================================================================
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, cryptoProvider,
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${(err as Error).message}`, { status: 400 });
  }

  const byCustomer = async (customerId: string, status: string, subId: string | null) => {
    await supabase.from("profiles")
      .update({ income_status: status, stripe_subscription_id: subId })
      .eq("stripe_customer_id", customerId);
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.client_reference_id) {
          await supabase.from("profiles").update({
            stripe_customer_id: (s.customer as string) ?? null,
            stripe_subscription_id: (s.subscription as string) ?? null,
            income_status: "active",
          }).eq("id", s.client_reference_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const active = ["active", "trialing"].includes(sub.status);
        await byCustomer(sub.customer as string, active ? "active" : "inactive", sub.id);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await byCustomer(sub.customer as string, "inactive", sub.id);
        break;
      }
    }
  } catch (_e) {
    // 失敗してもStripeへは200を返し、再送に任せる
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
