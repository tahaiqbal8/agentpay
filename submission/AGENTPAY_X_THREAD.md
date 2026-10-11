# AgentPay — X Launch Thread (copy-ready)

**Optional.** Do this only after the deck, both videos and the Colosseum
profile are done. You chose to skip the Superteam Pakistan local track, so
there is no form requiring a tweet URL — this is now purely promotional.

**I have not posted anything.** No X tool is connected and you have not
authorised posting. These are drafts for you to publish.

Every claim below is true as of 11 Oct 2026. Nothing implies an audit,
customers, partnerships or mainnet.

---

### 1/6 — The problem

```
If you give software your card, you trust it twice:

that it spends on the right things,
and that it tells you the truth about what it spent.

AgentPay removes the second half of that trust.

🧵
```

### 2/6 — What it is

```
A human funds an escrow on Solana and sets the spending rules.

An automated client spends inside it.

Every request is allowed or refused BEFORE any money moves — and every
decision is hashed into a chain whose root is anchored on-chain.
```

### 3/6 — How the limit actually holds

```
The ceiling isn't a row in our database. It's a program.

The escrow vault is a PDA — Solana will not release more than was deposited,
whatever our gateway asks for.

Claims are cumulative, not incremental: 1,000 off-chain calls settle in ONE
transaction, and replaying an old claim is inert because it doesn't increase.
```

### 4/6 — The part nobody else records

```
Every system proves what an agent PAID.

AgentPay proves what an agent was STOPPED from paying.

Refusals are hash-chained with the same weight as approvals — the decision
string is inside the hash, so a refusal can't be edited into an approval
without breaking the chain.
```

### 5/6 — Check it yourself

```
No account. No token. Open it and press Verify:

🔗 https://13-200-171-103.sslip.io/verifier?session=F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc

Your browser recomputes the evidence chain and compares it to the root Solana
actually stored.

Browser root = Gateway root = On-chain root.

Code: https://github.com/tahaiqbal8/agentpay
```

### 6/6 — Where it stands

```
Built for Crypto World's Fair 🇵🇰

Honest status: deployed and verified on Solana devnet. 25 end-to-end checks,
0 failures. NOT audited. NOT on mainnet.

Next: independent security review, then design-partner pilots.

Spending you can bound. Decisions you can prove.
```

---

## Before posting

- [ ] Open the verifier link yourself and confirm it reaches **Verified**
- [ ] If you re-ran the demo, the session address in post 5/6 has changed —
      update it
- [ ] Attach the verifier screenshot (three matching roots) to post 5/6
- [ ] Attach a 20–30s clip of the refusal to post 4/6 if you have one
- [ ] Do not tag sponsors or judges as if they endorsed the project

## Do not

- Claim an audit, users, revenue, partnerships, or mainnet
- Say "first ever", "fully trustless", "production-ready" or "unhackable"
- Imply the devnet USDC figures represent real value
