# Token Launch Radar — make.fun token-radar-01

**Status: built locally, NOT submitted.** No account was created, nothing was
paid, nothing was pushed to GitHub, no make.fun kit was downloaded, no
makefun CLI was run, and no API key was used.

- Competition: `token-radar-01` — Build the best token launch radar
- Reward: $1,325 total (1st $1,000, 2nd–5th $50, 6th–10th $25)
- Entries close: **2026-12-14 18:00 Beijing time**
- Entry fee: none (free entry)

## What it does

Read a sealed snapshot of every protocol DefiLlama tracks, work out which
ones still record no token and are not a wrapped or staked product of one
that trades, rank them by what their launch would be worth, and hand in a
web dashboard with a ranked board, a detail view for each protocol, and
steps to farm it.

## Run

```sh
node main.ts
# writes out/index.html and out/ranked.json
# OUTPUT_DIR=/some/dir node main.ts   # override the output folder
```

Requires Node 22+ (tested on Node v24.22.1). Zero dependencies, zero
network calls at run time.

Open `out/index.html` in a browser. It is a single static file (inline CSS
and JS, no CDN): search/filter box, click any row to expand its detail
view and farming steps.

## Data source

- `data/protocols.json` — trimmed snapshot of `https://api.llama.fi/protocols`
  (public, no key), fetched 2026-11-25. 9,110 entries, trimmed to the fields
  the program uses (id, name, slug, url, description, category, chains,
  tvl, change_1d, change_7d, audits, gecko_id, cmcId, mcap, symbol, address,
  parentProtocol, twitter, listedAt, deprecated, rugged, deadUrl).
- The snapshot is in the repo so the dashboard is reproducible offline.
  To refresh it, re-fetch the same URL and replace `data/protocols.json`
  with the same trimmed schema, then re-run `node main.ts`.

## Scoring formula — Launch Value Score, 0–100

| Part | Points | Formula |
| --- | --- | --- |
| TVL | 50 | `50 × clamp((log10(TVL) − 7) / 2, 0, 1)` — $10M → 0, $100M → 25, $1B → 50 |
| Breadth | 15 | `15 × min(chains, 5) / 5` |
| Category | 20 / 18 / 15 / 10 | 20: Prediction Market, Lending, Dexs, Derivatives, Restaking, Collateral Markets, Perps; 18: Uncollateralized Lending; 15: Yield, Yield Aggregator, RWA, Basis Trading; 10: other |
| Momentum | 10 | `5 + 5 × clamp(change_7d / 20, −1, 1)` |
| Trust | 5 | 5 if audits > 0, else 0 |

## Tokenless test and exclusions

Groups are by `parentProtocol`, else by the entry's own slug; TVL is summed
per group so a protocol is ranked once. A group **has a token** if any entry
in it has a CoinGecko id, a CoinMarketCap id, a market cap above zero, or a
real symbol (not `-`) plus a token address. That last signal matters:
DefiLlama child entries often carry `gecko_id = null` even when the parent
token exists (e.g. Morpho Blue, Hyperliquid Bridge).

Excluded after that test: TVL < $10M, deprecated / rugged / dead URL, no
public URL or description, and any name/category containing bridge, CEX,
chain, payment, curator, allocator, CDP manager, stablecoin wrapper,
restaked, staking, or wrapped.

Manual exclusions (in `main.ts`, with reasons): **USDD** — the stablecoin
is itself the token; **Bittensor dTAO** — a sub-product of Bittensor, whose
TAO token already trades.

## Top 10 (from the 2026-11-25 snapshot)

Run `node main.ts` to reproduce. At build time the top 10 were:

1. Polymarket International — 71.5 — $321.4M — Prediction Market
2. Tydro — 71.2 — $393.4M — Lending
3. CIAN Yield Layer — 69.3 — $258.2M — Yield Aggregator
4. BitFi Basis — 65.7 — $208.8M — Basis Trading
5. OnRe — 64.2 — $289.9M — RWA
6. Symbiotic — 63.4 — $210.9M — Collateral Markets
7. Ember — 62.5 — $84.0M — RWA
8. Curvance — 61.6 — $137.9M — Lending
9. Theo Network thUSD — 58.3 — $162.2M — RWA
10. R25 — 58.2 — $195.0M — RWA

Full top 50 are in `out/ranked.json`; the dashboard shows them all.

## Data gaps — honest limits

- DefiLlama can lag a launch. A protocol that launched a token very
  recently may still show no token fields. Polymarket ranks #1 here strictly
  on the snapshot; its launch plans are widely reported outside DefiLlama.
  The score is a snapshot score, not a guarantee.
- Symbol + address is a proxy, not proof. Every ranked row links to the
  protocol's own site — check there.
- TVL is as DefiLlama reports it; it can include double-counted value.
- No points are given for "airdrop confirmed" — there is no such field in
  the data, and none is invented. Farming steps are normal usage of each
  protocol, labelled as such, not a promise of a token or reward.
- Tydro is young (listed on DefiLlama in 2026) and has 0 audits in the
  snapshot; it ranks high on TVL + momentum alone, and the dashboard shows
  that.

## What is still missing before submission

This build alone is **not** a submission. Before it can be entered:

1. **A GitHub account linked to the make.fun account @fuyi-zhu.**
   GitHub is currently Not linked. Entries need a public GitHub repository
   (with an OSI-approved LICENSE and a README) at a named commit, or a
   source-bundle entry instead.
2. **A personal Solana payout wallet linked** to the account. Currently
   none is linked; only the paired agent's wallet (2bve…8n2w) is visible,
   and it pays only rewards that agent's own entries win.
3. **A repository created after the competition opened (2026-11-14).**
   The repo must be created after that date; this local folder is not a
   repo and has not been pushed anywhere.
4. **Transcript bundle.** The entry must include the agent sessions that
   built it (bundle / transcripts), made with the make.fun kit — that step
   was deliberately NOT done here, per the build-only instruction.
5. **API key / paired agent.** The paired agent @fuyao-agent is Active,
   key expires 2025-12-19, but no key was used or stored in this build.

## Files

- `main.ts` — the program (Node 22+, zero deps)
- `package.json` — scripts: `node main.ts`
- `data/protocols.json` — cached DefiLlama snapshot (9,110 protocols)
- `out/index.html` — generated static dashboard
- `out/ranked.json` — generated top-50 ranking with score breakdowns
- `README.md` — this file
