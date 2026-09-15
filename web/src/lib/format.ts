/**
 * Formatting for on-chain values.
 *
 * Amounts are micro-USDC (6 decimals) and arrive from the gateway as decimal
 * STRINGS, because a JSON number is an IEEE-754 double in every JS runtime and
 * silently loses precision above 2^53. Rule 0.3 says money never touches a
 * float, and that includes rendering it — so everything here works on BigInt and
 * string slicing. There is no `/ 1e6` anywhere in this file, deliberately.
 */

const DECIMALS = 6;

/** `"1234567"` -> `"1.234567"`. Never lossy, never a float. */
export function formatUsdc(micro: string | bigint): string {
  let v: bigint;
  try {
    v = typeof micro === "bigint" ? micro : BigInt(micro);
  } catch {
    return "—";
  }
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const s = abs.toString().padStart(DECIMALS + 1, "0");
  const whole = s.slice(0, -DECIMALS);
  const frac = s.slice(-DECIMALS);
  // Thousands separators on the integer part only.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

/** Compact form for dense table cells: drops trailing fractional zeros. */
export function formatUsdcCompact(micro: string | bigint): string {
  const full = formatUsdc(micro);
  if (full === "—") return full;
  return full.includes(".") ? full.replace(/\.?0+$/, "") : full;
}

/**
 * Percentage of allowance consumed, as a number for bar width only.
 *
 * This is the one place a float appears, and it is presentation-only: the
 * underlying comparison is done in BigInt so a large deposit cannot round into
 * a misleading bar.
 */
export function consumedPercent(used: string, total: string): number {
  try {
    const u = BigInt(used);
    const t = BigInt(total);
    if (t <= 0n) return 0;
    if (u >= t) return 100;
    // Scale to basis points in integer space first.
    return Number((u * 10000n) / t) / 100;
  } catch {
    return 0;
  }
}

/** `Hfd5X46Gmu…eByVWoui` — enough to recognise, short enough to scan. */
export function truncateKey(key: string, head = 6, tail = 6): string {
  if (!key || key.length <= head + tail + 1) return key;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

export function truncateHash(hash: string, head = 8, tail = 8): string {
  return truncateKey(hash, head, tail);
}

/** Relative time, for a feed where "3s ago" beats a timestamp. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 0) return "now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Countdown to a unix-seconds expiry.
 *
 * Returns `expired` separately rather than a negative string so callers can
 * style it without parsing text back.
 */
export function expiryCountdown(expiresAt: number): {
  label: string;
  expired: boolean;
  urgent: boolean;
} {
  const secs = expiresAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return { label: "expired", expired: true, urgent: false };

  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;

  let label: string;
  if (d > 0) label = `${d}d ${h}h`;
  else if (h > 0) label = `${h}h ${m}m`;
  else if (m > 0) label = `${m}m ${s}s`;
  else label = `${s}s`;

  return { label, expired: false, urgent: secs < 300 };
}

export function explorerTx(sig: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
}

export function explorerAddress(addr: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/address/${addr}?cluster=${cluster}`;
}
