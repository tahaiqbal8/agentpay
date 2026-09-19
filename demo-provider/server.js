/**
 * Demo API provider.
 *
 * THE POINT OF THIS FILE IS WHAT IT DOES NOT CONTAIN.
 *
 * There is no payment code here. No 402, no signature checking, no wallet, no
 * knowledge that AgentPay exists. It is an ordinary API that serves data to
 * whoever asks.
 *
 * That is the product claim: a provider monetises by putting the gateway in
 * front of their API, not by rewriting it. The only thing this service does
 * beyond serving data is publish a price list at `/_catalogue`, which the
 * gateway reads so it knows what to charge.
 *
 * Deliberately zero npm dependencies — node:http only. It keeps the Docker
 * image tiny and the build instant.
 */
const http = require("node:http");

const PORT = Number(process.env.PORT ?? 4021);

/**
 * What this provider sells, and for how much.
 *
 * Prices are micro-USDC integers (6 decimals), never floats — the same rule
 * that holds everywhere else in this codebase. 1000 = $0.001.
 */
const CATALOGUE = {
  "/weather": { price: "1000", description: "Current weather for a city" },
  "/quote": { price: "500", description: "A short quote" },
  "/analyse": { price: "25000", description: "Expensive analysis (tests budget caps)" },
};

const WEATHER = {
  lahore: { temp_c: 24, humidity: 61, condition: "Haze" },
  karachi: { temp_c: 31, humidity: 74, condition: "Clear" },
  islamabad: { temp_c: 19, humidity: 55, condition: "Light rain" },
  london: { temp_c: 11, humidity: 81, condition: "Overcast" },
  tokyo: { temp_c: 17, humidity: 66, condition: "Cloudy" },
};

const QUOTES = [
  "An autonomous agent with a credit line is a liability, not a feature.",
  "Payment channels are solved. Proving what was refused is not.",
  "A policy that lives in a dashboard is advice. One that holds escrow is a rule.",
  "The receipt everyone wants is for the purchase that did not happen.",
];

// Served requests, so a demo can show the provider really was reached.
let served = 0;

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Proves to a sceptical judge that the response came from HERE, not from
    // the gateway inventing it.
    "x-served-by": "demo-provider",
    ...extraHeaders,
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    return json(res, 200, { status: "ok", service: "demo-provider", served });
  }

  // The price list the gateway reads. A real provider would publish the same
  // shape; nothing else about it needs to change.
  if (path === "/_catalogue") {
    return json(res, 200, {
      provider: "demo-provider",
      currency: "micro-USDC",
      resources: CATALOGUE,
    });
  }

  if (path === "/") {
    return json(res, 200, {
      service: "demo-provider",
      note: "An ordinary API. It has no payment code — the gateway handles that.",
      try: ["/weather?city=lahore", "/quote", "/analyse?subject=solana"],
      catalogue: "/_catalogue",
    });
  }

  if (path === "/weather") {
    const city = (url.searchParams.get("city") ?? "lahore").toLowerCase();
    const data = WEATHER[city];
    if (!data) {
      return json(res, 404, {
        error: "unknown city",
        available: Object.keys(WEATHER),
      });
    }
    served++;
    return json(res, 200, {
      city: city[0].toUpperCase() + city.slice(1),
      ...data,
      observed_at: new Date().toISOString(),
    });
  }

  if (path === "/quote") {
    served++;
    return json(res, 200, {
      quote: QUOTES[Math.floor(Math.random() * QUOTES.length)],
      served_at: new Date().toISOString(),
    });
  }

  if (path === "/analyse") {
    const subject = url.searchParams.get("subject") ?? "unspecified";
    served++;
    return json(res, 200, {
      subject,
      verdict: "Deferred settlement is viable below one cent; per-call settlement is not.",
      confidence: 0.82,
      analysed_at: new Date().toISOString(),
    });
  }

  json(res, 404, { error: "no such resource", catalogue: "/_catalogue" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`demo-provider listening on 0.0.0.0:${PORT}`);
  console.log(`  catalogue: ${Object.keys(CATALOGUE).join(", ")}`);
  console.log("  no payment code in this service — that is deliberate");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
