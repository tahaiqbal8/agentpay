# Colosseum Submission Checklist — Crypto World's Fair

**Deadline — verified from two sources, 11 Oct 2026:**

| | |
|---|---|
| Colosseum site | *"Submissions due October 12, 2026"* (no time given on the page) |
| Superteam Earn | *"Deadline for submissions is 13 Oct (6:59 AM UTC)"* |
| **In PKT** | **Tue 13 Oct, 11:59 AM** |
| In PDT | Mon 12 Oct, 11:59 PM |

**Track:** Solana ecosystem — $100,000 pool, 10 projects × $10,000.
Also eligible for the general pool: $30,000 grand prize, $300,000 across the
next 20 ($15,000 each), $5,000 Public Good, $5,000 University.

**Superteam Pakistan local track: SKIPPED** by your decision. It could not be
verified — the Superteam Earn Pakistan region page lists only the general
Crypto World's Fair sidetracks, with no Pakistan-specific $5,000 pool.

> ⚠️ **Two things I could not verify and you must check yourself in the portal:**
> 1. The exact required submission fields (the arena page requires sign-in).
> 2. Whether a submission can be edited after submitting. Treat it as
>    **irreversible** until the portal says otherwise.
> 3. The official rules PDF linked from colosseum.com/worldsfair — read it for
>    eligibility and ecosystem-track rules before you submit.

---

## Order of work — roughly 28 hours left

### Now — mandatory, blocking

| # | Task | Status | Owner |
|---|---|---|---|
| 1 | Read the official rules PDF on colosseum.com/worldsfair | ☐ | you |
| 2 | Sign in to the arena, screenshot the real field list | ☐ | you |
| 3 | **Give me the team names + roles** (Slide 7 is blocked) | ☐ | you |
| 4 | Set the GitHub repo description + website | ☐ | you — I lack admin on `tahaiqbal8/agentpay` |

**For task 4**, on GitHub → repo → About (gear icon):
```
Description:
Policy-bounded payments for automated services. Escrow on Solana, enforcement
before spend, hash-chained evidence of every decision including refusals, and
independent browser verification.

Website: https://13-200-171-103.sslip.io
```

### Next — build the assets

| # | Task | Status | Source |
|---|---|---|---|
| 5 | Run `npm run demo:v2` fresh, capture output | ☐ | last run 11 Oct: 25 PASS / 0 FAIL |
| 6 | Capture 5 product screenshots | ☐ | guide below |
| 7 | Build the 11-slide deck | ☐ | `AGENTPAY_PITCH_DECK_CONTENT.md` |
| 8 | Record the technical demo (3:00) | ☐ | `docs/VIDEO_DEMO_SCRIPT.md` |
| 9 | Record the pitch video (3:30–4:00) | ☐ | `AGENTPAY_PITCH_VIDEO_SCRIPT.md` |
| 10 | Export deck to PDF, upload, set link sharing | ☐ | |
| 11 | Fill the Colosseum profile | ☐ | `AGENTPAY_PROJECT_PROFILE.md` |
| 12 | **Review everything, then submit** | ☐ | treat as irreversible |

### Optional — only if 1–12 are done

| # | Task | Status |
|---|---|---|
| 13 | X account + launch thread | ☐ — `AGENTPAY_X_THREAD.md` |
| 14 | Read competitors' primary docs to firm up Slide 4 | ☐ |

---

## Screenshot capture guide (task 6)

Browser at **1440 × 900, dark mode**, on `https://13-200-171-103.sslip.io`.
Crop out your bookmarks bar.

| # | URL | Scroll to | Caption for the deck |
|---|---|---|---|
| 1 | `/` | top — lifecycle rail + money band | `Escrow = Spent + Remaining. Nine stages, lit from live devnet data.` |
| 2 | `/agents` | the policy / envelope | `A human sets the envelope. The client cannot widen it.` |
| 3 | `/` | the activity feed — get an emerald row **and** an amber row in frame | `Refusals are recorded with the same weight as approvals.` |
| 4 | `/verifier?session=F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc` → press **Verify proof** | the three-root panel | `Browser root = Gateway root = On-chain root.` |
| 5 | `/session/F9uv8RFszLAuKUdRea121aSwoSUGT5ftPfXXi8Ux8Nfc` | top | `One settlement transaction closes a session of many claims.` |

Screenshot 4 is the most important image in the deck. Make sure all three
`MATCH` labels are legible.

---

## Field-by-field answers

All copy is in `AGENTPAY_PROJECT_PROFILE.md`. Quick index:

| Portal field | Section |
|---|---|
| Project name | §1 |
| Tagline | §2 |
| Short description | §3 |
| Extended description | §4 |
| Problem / Solution | §5 / §6 |
| Technologies | §13 |
| How it uses the blockchain | §8 |
| Country | Pakistan |
| Website | §11 |
| GitHub | §12 |
| Current status | §9 |
| Future milestones | §10 |

---

## Pre-submission verification

**Links — open each in a private window:**
- [ ] `https://13-200-171-103.sslip.io` loads over HTTPS
- [ ] `https://13-200-171-103.sslip.io/?judge=1` shows the read-only view
- [ ] Verifier deep link reaches **Verified** with three matching roots
- [ ] `https://github.com/tahaiqbal8/agentpay` opens for a logged-out visitor
- [ ] Pitch deck link opens for someone who is not you
- [ ] Both video links play for someone who is not you

**Content:**
- [ ] Nothing claims an audit — there has been none
- [ ] Nothing claims mainnet — it is devnet only
- [ ] No users, customers, revenue or partnerships are implied
- [ ] Team roles are accurate, no padding
- [ ] Funding allocation sums to 100% ($15,000)
- [ ] Market numbers are labelled as assumptions
- [ ] Screenshots match the live product

**Already verified by me on 11 Oct 2026:**
- [x] Repository is **public**
- [x] No `.env`, keypair, PEM or admin token is tracked; `.gitignore` covers `.env*` and `secrets/*`
- [x] Live deployment healthy, all four containers up
- [x] Canonical demo: 25 PASS / 0 FAIL
- [x] Verifier shows three matching roots on the live site
- [x] README now links the live demo and the reproducible run

---

## What is NOT ready

| Gap | Why it matters | Fix |
|---|---|---|
| **Team slide empty** | Mandatory field; I will not invent contributors | Send me names + roles |
| Repo description blank | First thing a judge reads on GitHub | You set it — I lack admin |
| No logo file | Submission asks for one | Export the console's "A" mark, or make one |
| Deck not built | Highest-weighted artifact | Content is ready in `AGENTPAY_PITCH_DECK_CONTENT.md` |
| Both videos unrecorded | Mandatory | Scripts are ready |
| Portal fields unverified | Could change what's needed | Sign in and check |
