"use client";
import * as React from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { truncateKey } from "@/lib/format";

/**
 * A pubkey or hash: truncated for scanning, copyable in full.
 *
 * The full value is always in the DOM via `title`, so copy never yields the
 * truncated form -- a truncated key silently copied would be worse than no copy
 * button at all.
 */
export function MonoKey({
  value,
  href,
  head = 6,
  tail = 6,
  className,
  label,
}: {
  value: string;
  href?: string;
  head?: number;
  tail?: number;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (insecure origin); the title attribute still has it */
    }
  };

  return (
    <span className={cn("group inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      {label && <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-dim)]">{label}</span>}
      <span className="font-mono text-xs text-[var(--color-fg-muted)]" title={value}>
        {truncateKey(value, head, tail)}
      </span>
      <button
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${value}`}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      >
        {copied ? (
          <Check className="size-3 text-[var(--color-accent)]" />
        ) : (
          <Copy className="size-3 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]" />
        )}
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in Solana Explorer"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          <ExternalLink className="size-3 text-[var(--color-fg-dim)] hover:text-[var(--color-cyan)]" />
        </a>
      )}
    </span>
  );
}
