// Token Launch Radar — make.fun competition token-radar-01
// Node 22+ program, zero dependencies. Run: `node main.ts`
// Reads the cached DefiLlama snapshot in data/protocols.json, filters it to
// protocols with no tradable token, ranks them by Launch Value Score, and
// writes a fast static dashboard to out/index.html plus out/ranked.json.
//
// This file is the entry's program. It does NOT submit anything, does NOT
// call make.fun, does NOT need an API key, and does NOT fetch the network
// at run time: the snapshot is in the repo so the result is reproducible
// offline. To refresh the data, re-fetch https://api.llama.fi/protocols
// and replace data/protocols.json (same trimmed schema), then re-run.
//
// ---------------------------------------------------------------------------
// SCORING FORMULA — Launch Value Score, 0–100, documented on the dashboard
// ---------------------------------------------------------------------------
//   TVL (50 pts)      50 * clamp((log10(TVL) - 7) / 2, 0, 1)
//                     $10M -> 0, $100M -> 25, $1B -> 50. Log scale, so a
//                     10x bigger protocol is worth 25 points more, not 10x.
//   Breadth (15 pts)  15 * min(chains, 5) / 5
//                     More chains = more users a launch could reach.
//   Category (20/18/15/10 pts)
//                     20: Prediction Market, Lending, Dexs, Derivatives,
//                         Restaking, Collateral Markets, Perps
//                     18: Uncollateralized Lending
//                     15: Yield, Yield Aggregator, RWA, Basis Trading
//                     10: everything else that survives the filters
//   Momentum (10 pts) 5 + 5 * clamp(change_7d / 20, -1, 1)
//                     +20% in 7 days -> 10, flat -> 5, -20% -> 0.
//   Trust (5 pts)     5 if audits > 0, else 0.
// ---------------------------------------------------------------------------
// TOKENLESS TEST — a protocol group "has a token" if ANY entry in the group
// has gecko_id, cmcId, mcap > 0, or (symbol != "-" AND a token address).
// DefiLlama's /protocols has no explicit token flag, and child entries
// often carry gecko_id = null even when the parent token exists (e.g.
// Morpho Blue, Hyperliquid Bridge), so the symbol+address signal is
// essential. Groups are by parentProtocol, else by the entry's own slug,
// and TVL is summed across the group so one protocol is ranked once.
// ---------------------------------------------------------------------------
// EXCLUSIONS — applied after the token test, all documented on the page:
//   * TVL < $10M, TVL missing, deprecated / rugged / dead URL
//   * No public URL or no description (cannot verify the protocol)
//   * Categories that are not a token-launch candidate: anything with
//     "bridge", "cex", "chain", "payment", "curator", "allocator",
//     "cdp manager", "stablecoin wrapper", "restaked", "staking", "wrapped"
//     in its name/category — i.e. CEXs, canonical bridges, wrapped/staked
//     products of a token that already trades.
//   * Manual exclusions, with reasons in MANUAL_EXCLUDE below:
//     USDD (the stablecoin IS the token) and Bittensor dTAO (a sub-product
//     of Bittensor, whose TAO token already trades).
// ---------------------------------------------------------------------------
// KNOWN DATA GAPS (also shown on the dashboard)
//   * DefiLlama can lag a launch: a protocol that launched a token very
//     recently may still show no gecko/cmc/mcap entry. Polymarket is the
//     clearest example — it ranks #1 here strictly on the snapshot, and
//     its launch plans are widely reported outside DefiLlama. The score
//     is a snapshot score, not a guarantee.
//   * symbol+address is a proxy, not proof. A protocol could have a
//     token contract that DefiLlama does not list, or a symbol that is
//     a chain's native asset. Every ranked row links to the protocol's
//     own site so a reader can check.
//   * No points are given for "airdrop confirmed" — there is no such
//     field in the data, and none is invented. Farming steps on the page
//     are the normal ways to use each protocol, labelled as such.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUTPUT_DIR || join(ROOT, "out");
const SNAPSHOT = join(ROOT, "data", "protocols.json");
const TOP_N = 50;

interface Protocol {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  description: string | null;
  category: string | null;
  chains: string[];
  tvl: number | null;
  change_1d: number | null;
  change_7d: number | null;
  audits: string | number | null;
  gecko_id: string | null;
  cmcId: string | number | null;
  mcap: number | null;
  symbol: string | null;
  address: string | null;
  parentProtocol: string | null;
  twitter: string | null;
  listedAt: number | null;
  deprecated?: boolean;
  rugged?: boolean;
  deadUrl?: boolean;
}

interface Snapshot {
  fetched_at_utc: string;
  source: string;
  count: number;
  protocols: Protocol[];
}

interface Ranked {
  rank: number;
  name: string;
  slug: string;
  url: string;
  description: string;
  category: string;
  chains: string[];
  tvl: number;
  tvlUsd: string;
  change7d: number | null;
  audits: number;
  twitter: string | null;
  listedAt: string | null;
  score: number;
  parts: { tvl: number; breadth: number; category: number; momentum: number; trust: number };
  farmSteps: string[];
  why: string;
}

const MANUAL_EXCLUDE: Record<string, string> = {
  USDD: "USDD is itself a stablecoin token, not a tokenless protocol awaiting a launch.",
  "Bittensor dTAO": "Sub-product of Bittensor; the TAO token already trades.",
};

const EXCLUDE_WORDS = [
  "bridge", "cex", "chain", "payment", "curator", "allocator",
  "cdp manager", "stablecoin wrapper", "restaked", "staking", "wrapped",
];

const CATEGORY_SCORE: Record<string, number> = {
  "Prediction Market": 20, Lending: 20, Dexs: 20, Derivatives: 20,
  Restaking: 20, "Collateral Markets": 20, Perps: 20,
  "Uncollateralized Lending": 18,
  Yield: 15, "Yield Aggregator": 15, RWA: 15, "Basis Trading": 15,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function cleanUrl(u: string): string {
  // DefiLlama sometimes ships a URL with a tracking param (e.g. utm_source).
  // Strip tracking params so the dashboard links to the clean official site.
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (k.toLowerCase().startsWith("utm_")) url.searchParams.delete(k);
    }
    return url.toString();
  } catch { return u; }
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function hasToken(group: Protocol[]): boolean {
  for (const p of group) {
    if (p.gecko_id || p.cmcId || (p.mcap ?? 0) > 0) return true;
    if (p.symbol && p.symbol !== "-" && p.address) return true;
  }
  return false;
}

function scoreProtocol(tvl: number, chains: string[], category: string, change7d: number | null, audits: number) {
  const tvlScore = 50 * clamp((Math.log10(tvl) - 7) / 2, 0, 1);
  const breadth = 15 * Math.min(chains.length, 5) / 5;
  const categoryScore = CATEGORY_SCORE[category] ?? 10;
  const momentum = 5 + 5 * clamp((change7d ?? 0) / 20, -1, 1);
  const trust = audits > 0 ? 5 : 0;
  const total = tvlScore + breadth + categoryScore + momentum + trust;
  return {
    total: Math.round(total * 10) / 10,
    parts: {
      tvl: Math.round(tvlScore * 10) / 10,
      breadth: Math.round(breadth * 10) / 10,
      category: categoryScore,
      momentum: Math.round(momentum * 10) / 10,
      trust,
    },
  };
}

function farmSteps(category: string): string[] {
  const common = [
    "Use the protocol on its official site — only the official site, never a link from a random post.",
    "Keep a record of what you did (dates, amounts, wallet used); past airdrops have typically rewarded real usage, not one-off clicks.",
  ];
  const byCategory: Record<string, string[]> = {
    Lending: ["Deposit collateral and/or supply assets to a lending pool.", "Borrow against it and repay on time; keep your health factor well above liquidation."],
    "Uncollateralized Lending": ["Lend to a pool and track your position; understand the borrower risk before depositing."],
    Dexs: ["Swap through the DEX and, if you accept impermanent loss, provide liquidity to a pool."],
    Derivatives: ["Open and close a small perps / derivatives position to learn the flow; mind leverage and liquidation."],
    "Prediction Market": ["Trade a market you understand, and hold positions through resolution."],
    Restaking: ["Restake through the protocol and track the operators / AVSs securing your stake."],
    "Collateral Markets": ["Deposit collateral into a vault and follow its obligations and unlock schedule."],
    Yield: ["Deposit into a yield vault and compare the quoted APY with the realised return."],
    "Yield Aggregator": ["Deposit into a vault, note the strategy and fees, and check returns over weeks, not days."],
    RWA: ["Use the protocol's real-world asset product and read the issuer / redemption terms first."],
    "Basis Trading": ["Use the basis product and understand the funding / basis risk before depositing."],
  };
  return [...(byCategory[category] ?? ["Use the protocol's main product and follow its official guide."]), ...common,
    "No airdrop is confirmed for this protocol in the data. These steps are normal usage, not a guarantee of a token or reward."];
}

function main(): void {
  const snap: Snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const groups = new Map<string, Protocol[]>();
  for (const p of snap.protocols) {
    const key = p.parentProtocol || `solo#${p.slug}`;
    const g = groups.get(key) ?? [];
    g.push(p);
    groups.set(key, g);
  }

  const ranked: Ranked[] = [];
  const excludedCounts = { token: 0, smallTvl: 0, category: 0, quality: 0, manual: 0 };

  for (const group of groups.values()) {
    const tvl = group.reduce((s, p) => s + (p.tvl ?? 0), 0);
    if (tvl < 10_000_000) { excludedCounts.smallTvl++; continue; }
    if (hasToken(group)) { excludedCounts.token++; continue; }
    const primary = group.reduce((a, b) => (b.tvl ?? 0) > (a.tvl ?? 0) ? b : a);
    if (MANUAL_EXCLUDE[primary.name]) { excludedCounts.manual++; continue; }
    const hay = `${primary.name} ${primary.category ?? ""}`.toLowerCase();
    if (EXCLUDE_WORDS.some((w) => hay.includes(w))) { excludedCounts.category++; continue; }
    if (primary.deprecated || primary.rugged || primary.deadUrl || !primary.url || !primary.description) {
      excludedCounts.quality++; continue;
    }
    const audits = Number(primary.audits ?? 0) || 0;
    const chains = primary.chains ?? [];
    const category = primary.category ?? "Other";
    const s = scoreProtocol(tvl, chains, category, primary.change_7d, audits);
    ranked.push({
      rank: 0,
      name: primary.name,
      slug: primary.slug,
      url: cleanUrl(primary.url),
      description: primary.description,
      category,
      chains,
      tvl,
      tvlUsd: fmtUsd(tvl),
      change7d: primary.change_7d,
      audits,
      twitter: primary.twitter,
      listedAt: primary.listedAt ? new Date(primary.listedAt * 1000).toISOString().slice(0, 10) : null,
      score: s.total,
      parts: s.parts,
      farmSteps: farmSteps(category),
      why: `${fmtUsd(tvl)} TVL, ${chains.length} chain(s), ${category}, 7d ${primary.change_7d == null ? "n/a" : `${primary.change_7d.toFixed(1)}%`}, ${audits} audit(s).`,
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.tvl - a.tvl);
  const top = ranked.slice(0, TOP_N);
  top.forEach((r, i) => { r.rank = i + 1; });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "ranked.json"), JSON.stringify({
    competition: "token-radar-01",
    generated_at_utc: new Date().toISOString(),
    snapshot_at_utc: snap.fetched_at_utc,
    source: snap.source,
    scanned_protocols: snap.count,
    scanned_groups: groups.size,
    candidates: ranked.length,
    exclusions: excludedCounts,
    ranked: top,
  }, null, 2));

  const rows = top.map((r) => `
    <tr class="row" data-slug="${esc(r.slug)}">
      <td class="rank">${r.rank}</td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a><div class="sub">${esc(r.category)}</div></td>
      <td class="num">${r.tvlUsd}</td>
      <td class="num">${r.change7d == null ? "—" : `${r.change7d.toFixed(1)}%`}</td>
      <td>${esc(r.chains.slice(0, 3).join(", "))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ""}</td>
      <td class="num score">${r.score.toFixed(1)}</td>
    </tr>
    <tr class="detail" id="d-${esc(r.slug)}" hidden>
      <td colspan="6">
        <p>${esc(r.description)}</p>
        <p><b>Why it ranks here:</b> ${esc(r.why)}</p>
        <p><b>Score:</b> TVL ${r.parts.tvl} · Breadth ${r.parts.breadth} · Category ${r.parts.category} · Momentum ${r.parts.momentum} · Trust ${r.parts.trust} = <b>${r.score.toFixed(1)} / 100</b></p>
        <p><b>How to farm it (normal usage, no airdrop confirmed):</b></p>
        <ol>${r.farmSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <p><a href="${esc(r.url)}" target="_blank" rel="noopener">Official site ↗</a>${r.twitter ? ` · <a href="https://x.com/${esc(r.twitter)}" target="_blank" rel="noopener">@${esc(r.twitter)} on X ↗</a>` : ""}${r.listedAt ? ` · Listed on DefiLlama: ${esc(r.listedAt)}` : ""}</p>
      </td>
    </tr>`).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Launch Radar — token-radar-01</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin:0 auto;padding:24px 16px;color:#111;line-height:1.5}
h1{font-size:28px;margin:0 0 4px} .muted{color:#555} table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top}
th{background:#f5f5f5} .num{text-align:right} .rank{font-weight:700} .score{font-weight:700}
tr.row{cursor:pointer} tr.row:hover{background:#f7f7ff} .sub{color:#555;font-size:12px}
.detail td{background:#fafafa} .pill{display:inline-block;background:#eef;border:1px solid #ccd;padding:2px 8px;border-radius:999px;margin:2px 4px 2px 0;font-size:13px}
section{margin-top:28px} code{background:#f0f0f0;padding:1px 5px;border-radius:4px}
input{padding:8px;width:100%;max-width:420px;margin-top:12px}
</style></head><body>
<h1>Token Launch Radar</h1>
<p class="muted">Which DeFi protocols still have no token — and what would a launch be worth?</p>
<p><span class="pill">Snapshot: ${esc(snap.fetched_at_utc)}</span><span class="pill">Scanned: ${snap.count.toLocaleString()} DefiLlama entries (${groups.size.toLocaleString()} protocol groups)</span><span class="pill">Candidates: ${ranked.length}</span><span class="pill">Source: DefiLlama, no key</span></p>
<p>Data: <a href="https://api.llama.fi/protocols">api.llama.fi/protocols</a> (public). A protocol counts as tokenless only if <b>no</b> entry in its group has a CoinGecko id, a CoinMarketCap id, a market cap above zero, or a real symbol plus a token address. TVL is summed per protocol group so a protocol is ranked once. Excluded: TVL under $10M, CEXs, bridges, wrapped / staked products, and protocols with no public URL or description. Two manual exclusions are documented in the code: USDD (the stablecoin is itself the token) and Bittensor dTAO (TAO already trades).</p>
<h2>How the score works — Launch Value Score, 0–100</h2>
<p><b>TVL 50</b> — 50 × clamp((log<sub>10</sub>(TVL) − 7) / 2, 0, 1): $10M → 0, $100M → 25, $1B → 50. <b>Breadth 15</b> — 15 × min(chains, 5) / 5. <b>Category 20 / 18 / 15 / 10</b> — 20 for Prediction Market, Lending, Dexs, Derivatives, Restaking, Collateral Markets, Perps; 18 for Uncollateralized Lending; 15 for Yield, Yield Aggregator, RWA, Basis Trading; 10 otherwise. <b>Momentum 10</b> — 5 + 5 × clamp(7-day TVL change / 20, −1, 1). <b>Trust 5</b> — 5 if audits &gt; 0. Click any row for the detail view and farming steps.</p>
<input id="q" type="search" placeholder="Filter by name or category…" aria-label="Filter protocols">
<table><thead><tr><th>#</th><th>Protocol</th><th style="text-align:right">TVL</th><th style="text-align:right">7d</th><th>Chains</th><th style="text-align:right">Score</th></tr></thead>
<tbody id="tbody">${rows}</tbody></table>
<section><h2>Detail — how to read a row</h2>
<p>Click a row to expand it: description, why it ranks, the score breakdown, and steps to farm it. Farming steps are the normal ways to use the protocol — deposit, lend, swap, trade — and are <b>not</b> a confirmed airdrop. No protocol here is promised to launch a token.</p></section>
<section><h2>Data gaps — read before trusting the board</h2>
<ul>
<li>DefiLlama can lag a launch. A protocol that launched a token very recently may still show no token fields. The board is a snapshot score, not a guarantee.</li>
<li>Symbol + address is a proxy, not proof. Every row links to the protocol's own site — check there.</li>
<li>TVL is as reported by DefiLlama; it can include double-counted or misreported value. The 7-day change and audit count are shown so you can see momentum and trust at a glance.</li>
<li>Excluded at this run: token ${excludedCounts.token} groups, TVL &lt; $10M ${excludedCounts.smallTvl} groups, category/wrapped ${excludedCounts.category} groups, quality (no URL/description/dead) ${excludedCounts.quality} groups, manual ${excludedCounts.manual} groups.</li>
</ul></section>
<footer class="muted"><p>Built with Node, zero dependencies, from the cached snapshot in data/protocols.json — reproducible offline. Run: <code>node main.ts</code> · Output: out/index.html + out/ranked.json · Competition: token-radar-01, entries close 2026-12-14 18:00 Beijing time. This build is NOT a submission.</p></footer>
<script>
const q=document.getElementById('q');
q.addEventListener('input',()=>{
  const v=q.value.toLowerCase();
  document.querySelectorAll('tr.row').forEach(r=>{
    const show=r.textContent.toLowerCase().includes(v);
    r.style.display=show?'':'none';
    const d=document.getElementById('d-'+r.dataset.slug); if(d) d.hidden=!show?true:d.hidden;
  });
});
document.querySelectorAll('tr.row').forEach(r=>{
  r.addEventListener('click',()=>{
    const d=document.getElementById('d-'+r.dataset.slug);
    if(d) d.hidden=!d.hidden;
  });
});
</script>
</body></html>`;

  writeFileSync(join(OUT_DIR, "index.html"), html);
  console.log(`Scanned ${snap.count} entries (${groups.size} groups) -> ${ranked.length} candidates`);
  console.log(`Top 10:`);
  for (const r of top.slice(0, 10)) {
    console.log(`  #${r.rank} ${r.score.toFixed(1)} ${r.name} ${r.tvlUsd} [${r.category}]`);
  }
  console.log(`Wrote ${join(OUT_DIR, "index.html")} and ${join(OUT_DIR, "ranked.json")}`);
}

main();
