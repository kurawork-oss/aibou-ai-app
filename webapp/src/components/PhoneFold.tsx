"use client";

/**
 * PhoneFold — スマホでは畳んでおく補足。
 *
 * 画面の冒頭の説明（「資料 とは」「オートパイロット とは」）は、最初の1文で
 * 何をする画面かが伝わる。続く「▸ ほかとの違い」「※ 注意」は、スマホでは
 * それだけで縦に 100px 以上を使い、開くたびに同じ説明を越えて下へ送ることに
 * なっていた。スマホでは「くわしく」で開くようにして、広い画面ではそのまま出す。
 */

import type { ReactNode } from "react";
import { usePhone } from "@/lib/usePhone";

export default function PhoneFold({ children, label = "くわしく" }:
  { children: ReactNode; label?: string }) {
  const phone = usePhone();
  if (!phone) return <>{children}</>;
  return (
    <details className="group">
      {/* 指で押せる高さ（44px）にして、見た目の行は詰めたままにする */}
      <summary className="-mb-2 flex min-h-[44px] cursor-pointer list-none items-center text-[10px] text-muted [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">▸ {label}</span>
        <span className="hidden group-open:inline">▾ 閉じる</span>
      </summary>
      {children}
    </details>
  );
}
