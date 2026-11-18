import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "index.html"), "utf8");
const match = html.match(/<script>\n([\s\S]*)\n  <\/script>\n<\/body>/);
if (!match) throw new Error("inline script not found");
const script = match[1];

const dir = mkdtempSync(join(tmpdir(), "thesis-"));
const jsPath = join(dir, "app.js");
writeFileSync(jsPath, script);
const check = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(check.stderr || check.stdout);
  process.exit(1);
}

const context = {};
vm.createContext(context);
vm.runInContext(script, context, { filename: "index.html" });
const app = context.ThesisApp;
if (!app) throw new Error("ThesisApp was not exported");

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", message);
  }
}

function symbols(categoryId) {
  return app.CATEGORIES.find((cat) => cat.id === categoryId).members.map((member) => member.symbol);
}

function coin(id, price, fdv, marketCap) {
  return {
    id,
    symbol: id,
    name: id,
    current_price: price,
    fully_diluted_valuation: fdv,
    market_cap: marketCap == null ? fdv : marketCap,
    circulating_supply: 40,
    total_supply: 100,
    market_cap_rank: 1,
    price_change_percentage_24h: 1.5,
    price_change_percentage_7d_in_currency: -2.5
  };
}

assert(!/代表|关注|东京时间|Asia\/Tokyo/.test(html), "page still contains a role label or Tokyo time");
assert(!/role\s*:/.test(script), "model still stores a role field");

const expected = {
  Money: ["BTC", "ZEC", "PEARL"],
  Issuing: ["ETH", "SOL", "SUI", "NEAR"],
  Trading: ["BNB", "HYPE", "LIT", "VAR"]
};
for (const [categoryId, wanted] of Object.entries(expected)) {
  assert(symbols(categoryId).join(",") === wanted.join(","), categoryId + " members " + symbols(categoryId).join(","));
}

const ids = app.THESIS_IDS.split(",");
assert(ids.includes("bitcoin") && ids.includes("zcash") && ids.includes("pearl-2"), "money ids");
assert(ids.includes("ethereum") && ids.includes("solana") && ids.includes("sui") && ids.includes("near"), "issuing ids");
assert(ids.includes("binancecoin") && ids.includes("hyperliquid") && ids.includes("lighter"), "trading ids keep BNB, HYPE, LIT");
assert(!ids.some((id) => /var/i.test(id)), "VAR has no invented CoinGecko id: " + ids.join(","));
assert(ids.length === 10, "listed thesis ids " + ids.length);
assert(app.INTROS["pearl-2"] && app.INTROS.lighter && app.INTROS.sui && app.INTROS.binancecoin, "intros preserved");

for (const entry of Object.values(app.THESIS)) {
  assert(entry.cat && !("role" in entry), "thesis tag is category only");
}
assert(app.THESIS.binancecoin.cat === "Trading", "BNB stays in Trading");
assert(app.THESIS.bitcoin.cat === "Money" && app.THESIS.sui.cat === "Issuing", "category map");

const counts = app.pairCounts();
assert(counts.Money.total === 6 && counts.Money.live === 6 && counts.Money.unavailable === 0, "Money pair counts");
assert(counts.Issuing.total === 12 && counts.Issuing.live === 12 && counts.Issuing.unavailable === 0, "Issuing pair counts");
assert(counts.Trading.total === 12 && counts.Trading.live === 6 && counts.Trading.unavailable === 6, "Trading pair counts");
assert(app.ALL_PAIRS.length === 30, "all directed pairs " + app.ALL_PAIRS.length);
assert(app.REFRESH_MS === 60000, "refresh interval");

for (const categoryId of Object.keys(expected)) {
  const members = symbols(categoryId);
  const pairs = app.pairsFor(categoryId);
  for (const asset of members) {
    for (const base of members) {
      const found = pairs.filter((pair) => pair.asset.symbol === asset && pair.base.symbol === base);
      if (asset === base) {
        assert(found.length === 0, "self pair " + categoryId + " " + asset);
      } else {
        assert(found.length === 1, "directed pair " + asset + "/" + base);
        const involvesVar = asset === "VAR" || base === "VAR";
        assert(found[0].unavailable === involvesVar, asset + "/" + base + " availability");
        assert(found[0].categoryId === categoryId, "pair stays inside " + categoryId);
      }
    }
  }
}

const liveTrading = app.pairsFor("Trading").filter((pair) => !pair.unavailable).map((pair) => pair.label).sort();
assert(liveTrading.join("|") === [
  "BNB / HYPE", "BNB / LIT", "HYPE / BNB", "HYPE / LIT", "LIT / BNB", "LIT / HYPE"
].sort().join("|"), "live trading directions " + liveTrading.join(", "));

const fdvs = {
  bitcoin: 1000,
  zcash: 100,
  "pearl-2": 10,
  ethereum: 800,
  solana: 400,
  sui: 200,
  near: 50,
  binancecoin: 300,
  hyperliquid: 30,
  lighter: 3
};
const prices = {
  bitcoin: 100000,
  zcash: 40,
  "pearl-2": 1.25,
  ethereum: 3000,
  solana: 150,
  sui: 2,
  near: 5,
  binancecoin: 600,
  hyperliquid: 20,
  lighter: 4
};
const byId = {};
for (const id of Object.keys(fdvs)) {
  byId[id] = coin(id, prices[id], fdvs[id]);
}

for (const pair of app.ALL_PAIRS) {
  if (pair.unavailable) continue;
  const reverse = app.findPair(pair.categoryId, pair.base.symbol, pair.asset.symbol);
  const forward = app.pairMetrics(pair, byId);
  const back = app.pairMetrics(reverse, byId);
  const product = forward.fdvShare * back.fdvShare;
  assert(Math.abs(product - 1) < 1e-12, pair.label + " reciprocal " + product);
  const currentPct = forward.fdvShare * 100;
  const implied = app.impliedPrice(forward, 10);
  const expectedPrice = prices[pair.asset.id] * (10 / currentPct);
  assert(Math.abs(implied - expectedPrice) < 1e-9, pair.label + " target price");
  assert(Math.abs(app.impliedFdv(forward, 10) - fdvs[pair.base.id] * 0.1) < 1e-6, pair.label + " implied fdv");
  if (Math.abs(10 - currentPct) < 1e-9) {
    assert(Math.abs(implied - prices[pair.asset.id]) < 1e-9, "target equal to current keeps price");
  }
}

const zecBtc = app.findPair("Money", "ZEC", "BTC");
const zecMetrics = app.pairMetrics(zecBtc, byId);
assert(Math.abs(zecMetrics.fdvShare - 0.1) < 1e-12, "ZEC/BTC share");
assert(Math.abs(app.impliedPrice(zecMetrics, 5) - 20) < 1e-9, "ZEC 5% implied price");
assert(app.ratioText(zecBtc, zecMetrics) === "10.0%", "ZEC/BTC display");

const fallbackCoin = coin("pearl-2", 1.5, null, 5e8);
fallbackCoin.fully_diluted_valuation = null;
assert(app.fdvOf(fallbackCoin) === 5e8, "FDV falls back to market cap");
assert(app.fdvUsedFallback(fallbackCoin) === true, "fallback flag");
const zeroCoin = coin("bitcoin", 1, 0, 0);
assert(!Number.isFinite(app.fdvOf(zeroCoin)), "non-positive FDV and market cap are missing");
const badBase = app.pairMetrics(zecBtc, { zcash: byId.zcash, bitcoin: zeroCoin });
assert(app.ratioText(zecBtc, badBase) === "—", "missing base does not render Infinity");
assert(!/nan|infinity/i.test(app.ratioText(zecBtc, badBase)), "ratio text is finite");

for (const pair of app.pairsFor("Trading")) {
  if (!pair.unavailable) continue;
  const metrics = app.pairMetrics(pair, byId);
  const texts = [
    app.ratioText(pair, metrics),
    app.priceText(pair, metrics),
    app.impliedPriceText(pair, metrics, 10),
    app.impliedFdvText(pair, metrics, 10)
  ];
  for (const text of texts) {
    assert(text === "未上市", pair.label + " text " + text);
    assert(!/nan|infinity|\$0(?:\.0+)?/i.test(text), pair.label + " leaked a bad number");
  }
  assert(!Number.isFinite(app.impliedPrice(metrics, 10)), "unavailable implied price is not a number");
}
const varMember = app.CATEGORIES.find((cat) => cat.id === "Trading").members.find((member) => member.symbol === "VAR");
const varFacts = app.memberFacts(varMember, byId);
assert(varFacts.price === "未上市" && varFacts.fdv === "未上市" && varFacts.circ === "未上市", "VAR card");
assert(varMember.id == null && varMember.unlisted === true, "VAR has no market id");

assert(app.formatPrice(NaN) === "—" && app.formatPrice(Infinity) === "—", "formatPrice guards");
assert(app.formatUsd(NaN) === "—" && app.formatPct(Infinity) === "—", "format guards");
const shanghai = vm.runInContext(
  'ThesisApp.formatShanghai(new Date("2026-01-02T00:30:00Z"))',
  context
);
assert(/北京时间/.test(shanghai) && /08:30:00|8:30:00/.test(shanghai), "Shanghai label " + shanghai);
assert(app.tagOf({ id: "lighter" }) === "Trading", "top-100 tag has no role");
assert(app.tagOf({ id: "binancecoin" }) === "Trading", "BNB tag");

const merged = app.mergeMarketLists(
  [{ id: "bitcoin", current_price: 1, fully_diluted_valuation: 10, market_cap: 10 }],
  [{ id: "bitcoin", current_price: 2, fully_diluted_valuation: 20, market_cap: 20 }, { id: "sui", current_price: 3, fully_diluted_valuation: 30, market_cap: 30 }]
);
assert(merged.byId.bitcoin.current_price === 2 && merged.byId.sui.current_price === 3, "thesis payload refreshes overlapping ids");

if (failed) {
  console.error(failed + " assertion(s) failed");
  process.exit(1);
}
console.log("pairwise tests passed");
console.log(JSON.stringify(app.pairCounts()));
