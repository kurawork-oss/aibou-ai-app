/* eslint-disable no-undef */
/**
 * sw.js — 通知を受け取るための常駐。
 *
 * ここに居る理由
 * --------------
 * ブラウザは、アプリを閉じている間の通知を**サービスワーカーにしか**
 * 渡さない。画面の JavaScript は動いていないので、受け取る場所がここ
 * しかない。だから、このファイルが無いと通知は1通も届かない。
 *
 * 置いている仕事は2つだけ。
 *   push              … 届いた内容を通知として出す
 *   notificationclick … 押された物に応じて、アプリを開く／その場で答える
 *
 * 何を「しない」か
 * ----------------
 * 画面やAPIの**キャッシュはしない**。サービスワーカーでキャッシュを
 * 始めると、更新したのに古い画面が出続ける、という事故が起きる
 * （しかも本人の端末でしか再現しないので、いちばん直しにくい形になる）。
 * 通知だけを持たせて、配信は今まで通りブラウザに任せる。
 */

self.addEventListener("install", () => {
  // 前のものを待たずに入れ替える（通知の仕様が変わったのに、古い方が
  // 居座って出続ける、を避ける）
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** 届いた中身を読む。壊れていても通知そのものは出す（黙って消さない）。 */
function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    let text = "";
    try {
      text = event.data ? event.data.text() : "";
    } catch {
      text = "";
    }
    return { title: "AIbou", body: text };
  }
}

self.addEventListener("push", (event) => {
  const d = readPayload(event);
  const title = d.title || "AIbou";

  /** 承認待ちのときは、通知の上に「実行／やめる」を出す。 */
  const actions = d.kind === "approval"
    ? [{ action: "approve", title: "実行する" }, { action: "reject", title: "やめる" }]
    : [];

  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    // 同じ用事の通知が積み上がらないようにする（承認は1件ずつ見たいので、
    // tag を分けて上書きさせない）
    tag: d.tag || (d.kind === "approval" ? `approval-${d.id || ""}` : "aibou"),
    renotify: Boolean(d.renotify),
    requireInteraction: d.kind === "approval",
    data: d,
    actions,
  }));
});

self.addEventListener("notificationclick", (event) => {
  const d = event.notification.data || {};
  const act = event.action;
  event.notification.close();

  // 「実行する／やめる」は、アプリを開かずにその場で答える。
  // 開いてから探させると、夜中に通知を見た人は結局あとで、になる。
  if (d.kind === "approval" && (act === "approve" || act === "reject") && d.answer_url) {
    event.waitUntil((async () => {
      try {
        await fetch(d.answer_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: d.id, decision: act, token: d.token || "" }),
        });
        await self.registration.showNotification("AIbou", {
          body: act === "approve" ? "実行しました。" : "取りやめました。",
          icon: "/icon-192.png",
          tag: `approval-done-${d.id || ""}`,
        });
      } catch {
        // 通信できなかったときは、開いて自分で押してもらうしかない
        await self.registration.showNotification("AIbou", {
          body: "返事を送れませんでした。アプリを開いて確かめてください。",
          icon: "/icon-192.png",
          tag: `approval-fail-${d.id || ""}`,
        });
      }
    })());
    return;
  }

  // それ以外は、開いているタブがあればそれを前に出す（増やさない）
  const url = d.url || "/";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if ("focus" in c) {
        try {
          if (url !== "/" && "navigate" in c) await c.navigate(url);
        } catch {
          /* 別オリジンなどで動かせないときは、そのまま前に出すだけ */
        }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
