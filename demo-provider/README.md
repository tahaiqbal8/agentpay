# demo-provider

An ordinary API. **It contains no payment code.**

No 402, no signature verification, no wallet, no awareness that AgentPay
exists. It serves data to whoever asks.

That is the point: a provider monetises by putting the gateway in front of
their API, not by rewriting it. The only concession is `/_catalogue`, a price
list the gateway reads so it knows what to charge.

| Route | Price | Returns |
|---|---|---|
| `/weather?city=lahore` | 0.001 | Current weather |
| `/quote` | 0.0005 | A short quote |
| `/analyse?subject=x` | 0.025 | Expensive call, for testing budget caps |
| `/_catalogue` | free | The price list |
| `/health` | free | Liveness + served count |

Every paid response carries `x-served-by: demo-provider`, so a sceptic can
confirm the data came from here rather than from the gateway inventing it.

```bash
node server.js          # :4021
```
