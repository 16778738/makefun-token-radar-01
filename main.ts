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
//     clearest example — it ranks near the top here strictly on the
//     snapshot, and its launch plans are widely reported outside
//     DefiLlama. The score is a snapshot score, not a guarantee.
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
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || process.env.OUTPUT_DIR || join(ROOT, "out");
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
  scoreRankPercentile: number;
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

// ---------------------------------------------------------------------------
// PRESENTATION HELPERS — pure functions of the ranked data, no side effects.
// ---------------------------------------------------------------------------

function trendHtml(change7d: number | null): string {
  if (change7d == null || change7d === 0) return `<span class="trend flat">—</span>`;
  if (change7d > 0) return `<span class="trend up">▲ ${change7d.toFixed(1)}%</span>`;
  return `<span class="trend down">▼ ${Math.abs(change7d).toFixed(1)}%</span>`;
}

function chainChips(chains: string[]): string {
  const shown = chains.slice(0, 4).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  const more = chains.length > 4 ? `<span class="chip more">+${chains.length - 4} more</span>` : "";
  return `<span class="chips">${shown}${more}</span>`;
}

function auditBadge(audits: number): string {
  if (audits <= 0) return "";
  return `<span class="badge" title="Audit count reported by DefiLlama">✓ ${audits} audit${audits === 1 ? "" : "s"}</span>`;
}

function scoreBar(score: number): string {
  return `<span class="scorebar" aria-hidden="true"><span class="scorefill" style="width:${score.toFixed(1)}%"></span></span>`;
}

const PART_META = [
  { key: "tvl", label: "TVL", max: 50, color: "#2563eb" },
  { key: "breadth", label: "Breadth", max: 15, color: "#0891b2" },
  { key: "category", label: "Category", max: 20, color: "#7c3aed" },
  { key: "momentum", label: "Momentum", max: 10, color: "#d97706" },
  { key: "trust", label: "Trust", max: 5, color: "#16a34a" },
] as const;

function partsBar(r: Ranked): string {
  // Segment widths are the point values themselves: the five maxima sum to
  // 100, so a segment of N points is N% of the full score bar.
  const segs = PART_META.map((m) => {
    const v = r.parts[m.key];
    return `<span class="seg" style="width:${v}%;background:${m.color}" title="${m.label}: ${v} / ${m.max} pts"></span>`;
  }).join("");
  const legend = PART_META.map((m) =>
    `<span class="leg"><span class="dot" style="background:${m.color}"></span>${m.label} ${r.parts[m.key]}/${m.max}</span>`).join("");
  return `<div class="stackbar">${segs}</div><div class="legend">${legend}</div>`;
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
      scoreRankPercentile: 0,
      parts: s.parts,
      farmSteps: farmSteps(category),
      why: `${fmtUsd(tvl)} TVL, ${chains.length} chain(s), ${category}, 7d ${primary.change_7d == null ? "n/a" : `${primary.change_7d.toFixed(1)}%`}, ${audits} audit(s).`,
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.tvl - a.tvl);
  // Percentile of each score among ALL candidates (not just the Top 50):
  // the share of candidates scoring strictly below this one, 0–100.
  const candCount = ranked.length;
  for (const r of ranked) {
    const below = ranked.reduce((acc, o) => acc + (o.score < r.score ? 1 : 0), 0);
    r.scoreRankPercentile = candCount > 1 ? Math.round((below / (candCount - 1)) * 1000) / 10 : 100;
  }
  const top = ranked.slice(0, TOP_N);
  top.forEach((r, i) => { r.rank = i + 1; });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "ranked.json"), JSON.stringify({
    competition: "token-radar-01",
    generated_at_utc: snap.fetched_at_utc,
    snapshot_at_utc: snap.fetched_at_utc,
    source: snap.source,
    scanned_protocols: snap.count,
    scanned_groups: groups.size,
    candidates: ranked.length,
    exclusions: excludedCounts,
    ranked: top,
  }, null, 2));

  const rows = top.map((r) => `
    <tr class="row" data-slug="${esc(r.slug)}" data-category="${esc(r.category)}" data-score="${r.score}" data-tvl="${r.tvl}" data-change="${r.change7d == null ? -9999 : r.change7d}">
      <td class="rank">${r.rank}</td>
      <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> ${auditBadge(r.audits)}<div class="sub">${esc(r.category)}</div></td>
      <td class="num">${r.tvlUsd}</td>
      <td class="num">${trendHtml(r.change7d)}</td>
      <td>${chainChips(r.chains)}</td>
      <td class="num"><span class="score">${r.score.toFixed(1)}</span>${scoreBar(r.score)}</td>
    </tr>
    <tr class="detail" id="d-${esc(r.slug)}" hidden>
      <td colspan="6">
        <p>${esc(r.description)}</p>
        <p><b>Why it ranks here:</b> ${esc(r.why)}</p>
        <p><b>Score breakdown — ${r.score.toFixed(1)} / 100</b> (${r.scoreRankPercentile}th percentile of ${candCount} candidates)</p>
        ${partsBar(r)}
        <p><b>How to farm it (normal usage, no airdrop confirmed):</b></p>
        <ol>${r.farmSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <p><a href="${esc(r.url)}" target="_blank" rel="noopener">Official site ↗</a>${r.twitter ? ` · <a href="https://x.com/${esc(r.twitter)}" target="_blank" rel="noopener">@${esc(r.twitter)} on X ↗</a>` : ""}${r.listedAt ? ` · Listed on DefiLlama: ${esc(r.listedAt)}` : ""}</p>
      </td>
    </tr>`).join("");

  const podium = top.slice(0, 3).map((r) => `
  <div class="podium-card p${r.rank}">
    <div class="podium-rank">#${r.rank}</div>
    <div class="podium-name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> ${auditBadge(r.audits)}</div>
    <div class="podium-cat">${esc(r.category)}</div>
    <div class="podium-score">${r.score.toFixed(1)}</div>
    ${scoreBar(r.score)}
    <div class="podium-meta">${r.tvlUsd} TVL · ${trendHtml(r.change7d)} 7d · ${r.chains.length} chain${r.chains.length === 1 ? "" : "s"}</div>
  </div>`).join("");

  const categories = [...new Set(top.map((r) => r.category))].sort();
  const categoryOptions = categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const excludedTotal = excludedCounts.token + excludedCounts.smallTvl + excludedCounts.category + excludedCounts.quality + excludedCounts.manual;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Launch Radar — token-radar-01</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin:0 auto;padding:0 16px 24px;color:#111;line-height:1.5}
a{color:#1d4ed8}
.muted{color:#555}
header.band{background:linear-gradient(135deg,#0f2447,#1d4ed8);color:#fff;border-radius:0 0 14px 14px;padding:26px 22px 20px;margin:0 -16px 8px}
header.band h1{font-size:30px;margin:0 0 4px;letter-spacing:.2px}
header.band .pitch{margin:0 0 14px;color:#dbeafe;font-size:16px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.stat{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:10px;padding:6px 12px;font-size:13px}
.stat b{display:block;font-size:17px;line-height:1.25}
.podium{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 4px}
.podium-card{flex:1 1 220px;border:1px solid #ddd;border-radius:12px;padding:14px 16px;background:#fff}
.podium-card.p1{border-color:#d4a017;background:#fffbeb}
.podium-card.p2{border-color:#9ca3af;background:#f9fafb}
.podium-card.p3{border-color:#c2803a;background:#fff7ed}
.podium-rank{font-size:13px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.08em}
.podium-name{font-size:19px;font-weight:700;margin:2px 0 0}
.podium-cat{color:#555;font-size:13px}
.podium-score{font-size:30px;font-weight:800;line-height:1.15}
.podium-meta{color:#444;font-size:13px;margin-top:6px}
.scorebar{display:block;width:110px;max-width:100%;height:7px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-top:4px}
.scorefill{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#16a34a);border-radius:99px}
.podium-card .scorebar{width:100%}
.stackbar{display:flex;width:100%;height:14px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin:4px 0 6px}
.stackbar .seg{display:block;height:100%}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:#333}
.legend .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.controls input[type=search]{flex:1 1 200px;padding:9px 10px;border:1px solid #bbb;border-radius:8px;font-size:14px}
.controls select{padding:9px;border:1px solid #bbb;border-radius:8px;font-size:14px;background:#fff}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;margin-top:10px;min-width:560px}
th,td{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top}
th{background:#f5f5f5;white-space:nowrap} .num{text-align:right} .rank{font-weight:700} .score{font-weight:800;font-size:16px}
tr.row{cursor:pointer} tr.row:hover{background:#f7f7ff} .sub{color:#555;font-size:12px}
.detail td{background:#fafafa}
.chips2{display:inline} .chip{display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:999px;padding:0 7px;margin:1px 2px 1px 0;font-size:11.5px;white-space:nowrap}
.chip.more{background:#f3f4f6;border-color:#d1d5db;color:#555}
.badge{display:inline-block;background:#dcfce7;border:1px solid #86efac;color:#166534;border-radius:999px;padding:0 7px;font-size:11.5px;font-weight:600;white-space:nowrap}
.trend{font-weight:600;white-space:nowrap} .trend.up{color:#16a34a} .trend.down{color:#dc2626} .trend.flat{color:#888}
section{margin-top:28px} code{background:#f0f0f0;padding:1px 5px;border-radius:4px}
</style></head><body>
<header class="band">
<h1>Token Launch Radar</h1>
<p class="pitch">Which DeFi protocols still have no token — and what would a launch be worth? Every candidate scored 0–100 on TVL, reach, category, momentum and trust.</p>
<div class="chips">
<span class="stat">Snapshot date<b>${esc(snap.fetched_at_utc.slice(0, 10))}</b></span>
<span class="stat">Protocols scanned<b>${snap.count.toLocaleString("en-US")}</b></span>
<span class="stat">Tokenless candidates<b>${ranked.length}</b></span>
<span class="stat">Groups excluded<b>${excludedTotal.toLocaleString("en-US")}</b></span>
</div>
</header>
<p class="muted">Snapshot date: ${esc(snap.fetched_at_utc)} · Dashboard generated from that snapshot — if the snapshot is old, the board is a picture of that day, not of today.</p>
<h2>Top 3 — the podium</h2>
<div class="podium">${podium}
</div>
<p>Data: <a href="https://api.llama.fi/protocols">api.llama.fi/protocols</a> (public). A protocol counts as tokenless only if <b>no</b> entry in its group has a CoinGecko id, a CoinMarketCap id, a market cap above zero, or a real symbol plus a token address. TVL is summed per protocol group so a protocol is ranked once. Excluded: TVL under $10M, CEXs, bridges, wrapped / staked products, and protocols with no public URL or description. Two manual exclusions are documented in the code: USDD (the stablecoin is itself the token) and Bittensor dTAO (TAO already trades).</p>
<h2>How the score works — Launch Value Score, 0–100</h2>
<p><b>TVL 50</b> — 50 × clamp((log<sub>10</sub>(TVL) − 7) / 2, 0, 1): $10M → 0, $100M → 25, $1B → 50. <b>Breadth 15</b> — 15 × min(chains, 5) / 5. <b>Category 20 / 18 / 15 / 10</b> — 20 for Prediction Market, Lending, Dexs, Derivatives, Restaking, Collateral Markets, Perps; 18 for Uncollateralized Lending; 15 for Yield, Yield Aggregator, RWA, Basis Trading; 10 otherwise. <b>Momentum 10</b> — 5 + 5 × clamp(7-day TVL change / 20, −1, 1). <b>Trust 5</b> — 5 if audits &gt; 0. Click any row for the detail view, the stacked score breakdown and farming steps.</p>
<div class="controls">
<input id="q" type="search" placeholder="Filter by name or category…" aria-label="Filter protocols">
<select id="cat" aria-label="Filter by category"><option value="">All categories</option>${categoryOptions}</select>
<select id="sort" aria-label="Sort the table">
<option value="score">Sort: Score (rank order)</option>
<option value="tvl">Sort: TVL, high to low</option>
<option value="change">Sort: 7d change, high to low</option>
</select>
</div>
<p id="shown" class="muted"></p>
<div class="tablewrap">
<table><thead><tr><th>#</th><th>Protocol</th><th style="text-align:right">TVL</th><th style="text-align:right">7d</th><th>Chains</th><th style="text-align:right">Score</th></tr></thead>
<tbody id="tbody">${rows}</tbody></table>
</div>
<section><h2>Detail — how to read a row</h2>
<p>Click a row to expand it: description, why it ranks, the stacked score breakdown (each coloured segment is one part of the score, sized by points), and steps to farm it. Farming steps are the normal ways to use the protocol — deposit, lend, swap, trade — and are <b>not</b> a confirmed airdrop. No protocol here is promised to launch a token.</p></section>
<section><h2>Data gaps — read before trusting the board</h2>
<ul>
<li>DefiLlama can lag a launch. A protocol that launched a token very recently may still show no token fields. The board is a snapshot score, not a guarantee.</li>
<li>Symbol + address is a proxy, not proof. Every row links to the protocol's own site — check there.</li>
<li>TVL is as reported by DefiLlama; it can include double-counted or misreported value. The 7-day change and audit count are shown so you can see momentum and trust at a glance.</li>
<li>Excluded at this run: token ${excludedCounts.token} groups, TVL &lt; $10M ${excludedCounts.smallTvl} groups, category/wrapped ${excludedCounts.category} groups, quality (no URL/description/dead) ${excludedCounts.quality} groups, manual ${excludedCounts.manual} groups.</li>
</ul></section>
<footer class="muted"><p>Built with Node, zero dependencies, from the cached snapshot in data/protocols.json — reproducible offline. Run: <code>node main.ts</code> · Output: out/index.html + out/ranked.json · Competition: token-radar-01, entries close 2026-12-14 18:00 Beijing time. This build is NOT a submission.</p></footer>
<script>
const tbody=document.getElementById('tbody');
const pairs=[];
tbody.querySelectorAll('tr.row').forEach(r=>{
  pairs.push({row:r,detail:document.getElementById('d-'+r.dataset.slug)});
});
const q=document.getElementById('q'),catSel=document.getElementById('cat'),sortSel=document.getElementById('sort'),shownEl=document.getElementById('shown');
function apply(){
  const v=q.value.toLowerCase(),c=catSel.value,key=sortSel.value;
  const list=pairs.slice();
  list.sort((a,b)=>parseFloat(b.row.dataset[key])-parseFloat(a.row.dataset[key]));
  let n=0;
  list.forEach(p=>{
    const show=(!v||p.row.textContent.toLowerCase().includes(v))&&(!c||p.row.dataset.category===c);
    p.row.style.display=show?'':'none';
    if(p.detail){ if(show){p.detail.style.display='';} else {p.detail.style.display='none'; p.detail.hidden=true;} }
    if(show)n++;
    tbody.appendChild(p.row); if(p.detail) tbody.appendChild(p.detail);
  });
  shownEl.textContent='Showing '+n+' of '+pairs.length+' protocols';
}
q.addEventListener('input',apply);
catSel.addEventListener('change',apply);
sortSel.addEventListener('change',apply);
pairs.forEach(p=>{
  p.row.addEventListener('click',()=>{
    if(p.detail) p.detail.hidden=!p.detail.hidden;
  });
});
apply();
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
