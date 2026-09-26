"use client";

import * as React from "react";

/**
 * Judge view: a presentation mode over the SAME real data.
 *
 * It changes what is shown and what is reachable. It never changes what is
 * true. Every number rendered under it comes from the same gateway endpoints
 * the operator console uses, and when an endpoint returns nothing the page
 * shows an empty state rather than a placeholder. There is no seeded data, no
 * sample session and no demo fixture anywhere behind this flag — the whole
 * point of the product is that its numbers can be checked, and a judge surface
 * that invented them would be self-defeating.
 *
 * # This is not a security boundary, and must never be described as one
 *
 * The security boundary is the gateway's admin token, which lives server-side
 * in the API proxy and never reaches the browser. Judge view is a curtain, not
 * a lock: anybody can drop the query parameter, and the header says so with a
 * visible "Show full console" link. Its purpose is to stop a first-time
 * visitor from wandering into a surface that spends devnet SOL while they are
 * trying to work out what the product does.
 *
 * # Why a query parameter rather than a role
 *
 * Because the alternative is an authentication system, and AgentPay
 * deliberately has none in the browser. The control plane is already
 * authenticated at the gateway; adding a second, weaker login in front of it
 * would be a liability rather than a control.
 */

const KEY = "agentpay:judge";
const PARAM = "judge";

/** Read once, synchronously, from the URL or from a previous read this tab. */
function detect(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const param = new URLSearchParams(window.location.search).get(PARAM);
    if (param === "1") {
      window.sessionStorage.setItem(KEY, "1");
      return true;
    }
    if (param === "0") {
      window.sessionStorage.removeItem(KEY);
      return false;
    }
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    // Private windows and blocked site data both throw on sessionStorage.
    // Falling back to the URL alone is correct: the mode still works, it just
    // does not survive navigation.
    try {
      return new URLSearchParams(window.location.search).get(PARAM) === "1";
    } catch {
      return false;
    }
  }
}

/**
 * Starts `false` on both server and first client render, then settles in an
 * effect. Reading storage during render would produce a hydration mismatch,
 * and guessing the mode before it is known would flash the wrong navigation.
 */
export function useJudgeMode(): boolean {
  const [judge, setJudge] = React.useState(false);
  React.useEffect(() => {
    setJudge(detect());
  }, []);
  return judge;
}

/** Leave judge view and return to the operator console. */
export function exitJudgeMode(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM);
  window.location.href = url.toString();
}
