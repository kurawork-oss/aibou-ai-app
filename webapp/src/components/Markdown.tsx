"use client";

/**
 * Markdown — 全モード共通のMarkdownレンダラ（ChatGPT級の読み味）.
 *
 * GFM（表・打ち消し・自動リンク）＋改行維持＋コードハイライト。コードブロックは
 * 言語ラベルとワンクリックコピー付き。表は横スクロールコンテナに包み、リンクは
 * 新規タブ。ストリーミング中の逐次再パースにも耐える軽さを保つ。
 * 見た目は globals.css の .md 系スタイルで統一。
 */

import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-([\w-]+)/.exec(className || "")?.[1] ?? "";
  const text = String(children ?? "");
  return (
    <div className="md-codeblock">
      <div className="md-codebar">
        <span className="label-mono">{lang || "code"}</span>
        <button
          type="button"
          onClick={() => {
            try {
              void navigator.clipboard?.writeText(text.replace(/\n$/, ""));
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch { /* ignore */ }
          }}
          className="label-mono"
        >
          {copied ? "✓ copied" : "⧉ copy"}
        </button>
      </div>
      <pre className={className}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // コードフェンス → ラベル＋コピー付きブロック（インラインはそのまま）
          pre: ({ children }) => <>{children}</>,
          code: (props) => {
            const { className: cn, children } = props as { className?: string; children?: ReactNode };
            const isBlock = /language-/.test(cn || "") || String(children ?? "").includes("\n");
            return isBlock
              ? <CodeBlock className={cn}>{children}</CodeBlock>
              : <code className="md-inline-code">{children}</code>;
          },
          table: ({ children }) => (
            <div className="md-tablewrap"><table>{children}</table></div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
