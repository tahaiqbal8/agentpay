# AgentPay — Market Sizing

**Status: preliminary bottom-up estimate with stated assumptions. NOT audited
market research.** Prepared 11 Oct 2026 under a one-day submission deadline.

> **Read this before quoting any number below.** No figure here is sourced from
> a paid research report, and no top-down "agent economy will be $X trillion"
> headline is used, because those numbers measure a different thing from the
> one AgentPay sells into. Everything is built from assumptions that are
> written down so a judge can disagree with a specific one rather than
> dismissing the whole slide.
>
> If a judge asks "where did this come from", the correct answer is: *"it's a
> bottom-up model with four assumptions, here they are, and the one I'm least
> sure of is the attach rate."* That answer scores better than a large number.

---

## 1. Define the market before counting it

AgentPay is **not** sold into "the AI market" or "the payments market". The
addressable unit is narrower and worth naming precisely:

> **An organisation running one or more automated software clients that spend
> money against paid services, where the owner needs the spending limit to be
> enforced rather than merely reported, and needs the record to be checkable by
> someone outside the organisation.**

Two qualifiers do most of the work:

- **"Enforced rather than reported"** excludes everyone content with a
  dashboard and a monthly invoice. That is the majority today.
- **"Checkable by someone outside"** excludes everyone who trusts their own
  operator — which is most internal use. It includes the cases where money
  crosses a trust boundary: agencies spending a client's budget, marketplaces
  settling to third-party providers, regulated contexts, and any arrangement
  where the party who pays is not the party who runs the software.

That second qualifier is where AgentPay's evidence layer actually earns its
keep, and it is a smaller market than "agent payments" — deliberately.

---

## 2. Bottom-up model

### Assumptions — challenge any of these

| # | Assumption | Value | Confidence |
|---|---|---|---|
| A1 | Organisations running automated clients against paid APIs, worldwide | **500,000** | Low — order-of-magnitude judgement, not measured |
| A2 | Median annual machine-initiated service spend per such organisation | **$6,000** | Low |
| A3 | Share where spend crosses a trust boundary and needs enforced limits + external verification | **8%** | Lowest — this is the assumption to attack |
| A4 | Take rate AgentPay could charge on controlled spend | **1.0%** | Medium — comparable to payment-infrastructure margins, unvalidated |

### TAM — Total Addressable Market

All machine-initiated service spend that could be placed under an enforced,
verifiable limit.

```
A1 × A2  =  500,000 × $6,000  =  $3.0B / year of controlled spend
TAM at a 1% take rate (A4)    =  $30M / year revenue opportunity
```

### SAM — Serviceable Available Market

Restricted to (a) spend that crosses a trust boundary, and (b) teams willing to
settle on crypto rails — which is what AgentPay actually implements today.

```
$3.0B × 8% (A3)               =  $240M / year of controlled spend
Crypto-rail-willing share, assumed 25%  =  $60M / year
SAM at a 1% take rate         =  $600K / year revenue opportunity
```

### SOM — Serviceable Obtainable Market, 12 months

Not a share of the SAM. For a devnet prototype with no audit and no users, the
only defensible 12-month figure is a count of design partners.

```
Target:  3 design partners
         1 pilot running continuously for 30 days
         ~$50K–$150K of controlled spend flowing through pilots
Revenue: $0 assumed in year one — pilots are unpriced
```

**Say this on the slide.** A founder who projects zero first-year revenue from
a devnet prototype and explains why is more credible than one who projects
$400,000.

---

## 3. What makes this model weak — disclose it

1. **A1 and A2 are judgement, not measurement.** No survey or report underpins
   them. They are stated so the shape of the argument is visible, not because
   they are known.
2. **A3 is the load-bearing assumption and the least certain.** If the
   trust-boundary share is 2% rather than 8%, the SAM falls by a factor of four.
   If it is 25%, it triples. This single number decides whether AgentPay is a
   niche compliance tool or infrastructure.
3. **A4 is unvalidated.** No pricing has been tested with anyone.
4. **The market may not exist yet in the form described.** Enforced,
   externally-verifiable spending limits for automated clients is an emerging
   category; the honest framing is that AgentPay is betting the trust-boundary
   case becomes common, not that it already is.

---

## 4. The non-numeric argument, which is stronger

Under a one-day deadline with no access to paid research, the most defensible
market claim is directional rather than quantified:

> Spending authority is being delegated to software faster than the controls
> for it are being built. Today the owner audits the spender's own books.
> Wherever the payer and the operator are different parties, that arrangement
> does not survive contact with a dispute — and AgentPay produces the artefact
> that settles one.

Lead with that on Slide 6, keep the model as the backup when a judge asks for
numbers, and name A3 as the assumption you would test first with a design
partner.

---

## 5. How to improve this before any investor conversation

1. Replace A1 with a defensible proxy — e.g. counts from a large API
   marketplace, or developer-population estimates with a stated derivation.
2. Test A3 directly in the first ten design-partner conversations. It is a
   question you can simply ask.
3. Price-test A4 against one real pilot.
4. Cite each source inline, with the retrieval date.

**None of that was possible in the time available, and the slide says so.**
