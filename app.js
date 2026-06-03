const binanceBase = "https://fapi.binance.com";
const refreshMs = 10 * 1000;
const tweetRefreshMs = 60 * 1000;

const narrativeBuckets = {
  anchor: {
    label: "BTC 锚定",
    symbols: ["BTC"]
  },
  buyback: {
    label: "回购/协议收入",
    symbols: ["HYPE", "BNB", "JUP", "RAY", "GMX", "DYDX", "UNI", "AAVE"]
  },
  stableYield: {
    label: "稳定币/收益业务",
    symbols: ["ENA", "PENDLE", "ONDO", "MKR", "AAVE", "CRV", "LDO"]
  },
  ai: {
    label: "强 AI / DePIN",
    symbols: ["TAO", "FET", "RENDER", "WLD", "NEAR", "ICP", "ARKM", "GRASS", "VIRTUAL", "FIL", "AR"]
  },
  privacyQuantum: {
    label: "隐私/抗量子预期",
    symbols: ["ZEC", "DASH", "ZEN", "ROSE", "MINA"]
  }
};

const focusConcepts = Object.fromEntries(
  Object.values(narrativeBuckets).flatMap((bucket) => bucket.symbols.map((symbol) => [symbol, [bucket.label]]))
);

const fallbackFocus = {
  HYPE: { symbol: "HYPE", pair: "HYPEUSDT", price: 32.8, change24h: 7.4, volume: 146000000, openInterest: 76000000, funding: 0.024, concept: "回购/协议收入", source: "fallback" },
  GRASS: { symbol: "GRASS", pair: "GRASSUSDT", price: null, change24h: 0, volume: null, openInterest: null, funding: null, concept: "强 AI / DePIN", source: "fallback" },
  VIRTUAL: { symbol: "VIRTUAL", pair: "VIRTUALUSDT", price: null, change24h: 0, volume: null, openInterest: null, funding: null, concept: "强 AI / DePIN", source: "fallback" }
};

let nextRefreshAt = Date.now() + refreshMs;
let nextTweetRefreshAt = Date.now() + tweetRefreshMs;
let refreshLock = false;
let tweetLock = false;
let latestCoins = [];

const els = {
  sourceState: document.querySelector("#sourceState"),
  lastUpdated: document.querySelector("#lastUpdated"),
  nextRefresh: document.querySelector("#nextRefresh"),
  focusInput: document.querySelector("#focusInput"),
  refreshBtn: document.querySelector("#refreshBtn"),
  tweetUpdated: document.querySelector("#tweetUpdated"),
  tweetRefresh: document.querySelector("#tweetRefresh"),
  handlesInput: document.querySelector("#handlesInput"),
  tweetRefreshBtn: document.querySelector("#tweetRefreshBtn"),
  tweetStatus: document.querySelector("#tweetStatus"),
  summaryCards: document.querySelector("#summaryCards"),
  tweetCards: document.querySelector("#tweetCards"),
  coinCount: document.querySelector("#coinCount"),
  strongCount: document.querySelector("#strongCount"),
  hotFundingCount: document.querySelector("#hotFundingCount"),
  totalVolume: document.querySelector("#totalVolume"),
  volumeBars: document.querySelector("#volumeBars"),
  oiBars: document.querySelector("#oiBars"),
  heatGrid: document.querySelector("#heatGrid"),
  searchInput: document.querySelector("#searchInput"),
  coinRows: document.querySelector("#coinRows"),
  focusCards: document.querySelector("#focusCards")
};

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  if (Math.abs(num) >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(num < 10 ? 4 : 2)}`;
}

function pct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toFixed(digits)}%`;
}

function classFor(value) {
  return Number(value) >= 0 ? "up" : "down";
}

function focusSymbols() {
  const curated = Object.values(narrativeBuckets).flatMap((bucket) => bucket.symbols);
  const custom = els.focusInput.value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set([...curated, ...custom])];
}

function trackedHandles() {
  return els.handlesInput.value
    .split(",")
    .map((item) => item.trim().replace(/^@/, ""))
    .filter(Boolean);
}

async function fetchJson(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `接口返回 ${response.status}`);
    }
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function conceptFor(symbol) {
  return focusConcepts[symbol]?.join(" / ") || "自定义观察";
}

function normalizeTicker(ticker) {
  const symbol = ticker.symbol.replace(/USDT$/, "");
  return {
    symbol,
    pair: ticker.symbol,
    price: Number(ticker.lastPrice),
    change24h: Number(ticker.priceChangePercent),
    volume: Number(ticker.quoteVolume),
    openInterest: null,
    funding: null,
    concept: conceptFor(symbol),
    source: "live"
  };
}

async function enrichDerivatives(coin) {
  const [oi, funding] = await Promise.allSettled([
    fetchJson(`${binanceBase}/fapi/v1/openInterest?symbol=${coin.pair}`, 3500),
    fetchJson(`${binanceBase}/fapi/v1/premiumIndex?symbol=${coin.pair}`, 3500)
  ]);

  return {
    ...coin,
    openInterest: oi.status === "fulfilled" ? Number(oi.value.openInterest) * coin.price : null,
    funding: funding.status === "fulfilled" ? Number(funding.value.lastFundingRate) * 100 : null
  };
}

async function buildUniverse() {
  const tickers = await fetchJson(`${binanceBase}/fapi/v1/ticker/24hr`, 6000);
  const usdt = tickers
    .filter((item) => item.symbol.endsWith("USDT"))
    .filter((item) => !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(item.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));

  const bySymbol = new Map();

  for (const symbol of focusSymbols()) {
    if (bySymbol.has(symbol)) continue;
    const ticker = usdt.find((item) => item.symbol === `${symbol}USDT`);
    if (ticker) bySymbol.set(symbol, normalizeTicker(ticker));
    else if (fallbackFocus[symbol]) bySymbol.set(symbol, fallbackFocus[symbol]);
  }

  const rows = [...bySymbol.values()];
  const enriched = await Promise.all(rows.map((coin) => (coin.source === "fallback" ? coin : enrichDerivatives(coin))));
  return enriched.sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0));
}

function score(coin) {
  let value = 50;
  if (coin.change24h > 3) value += 10;
  if (coin.change24h > 8) value += 8;
  if (coin.volume > 500_000_000) value += 8;
  if (coin.openInterest > 200_000_000) value += 8;
  if (coin.funding > 0.02) value -= 12;
  if (coin.funding < -0.01) value += 4;
  if (coin.change24h < -5) value -= 8;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function observation(coin) {
  if (coin.funding > 0.03) return ["费率过热", "hot"];
  if (coin.volume / Math.max(coin.openInterest || 1, 1) > 5) return ["量能突出", "good"];
  if (coin.openInterest > 300_000_000 && coin.change24h < 0) return ["持仓承压", "hot"];
  if (focusConcepts[coin.symbol]) return ["概念关注", ""];
  return ["常规观察", ""];
}

function tweetSymbols() {
  return [...new Set([...focusSymbols(), ...latestCoins.map((coin) => coin.symbol)])].slice(0, 80);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function directionForTweet(tweet) {
  const text = `${tweet.text || ""} ${(tweet.keywords || []).join(" ")}`.toLowerCase();
  const bullish = ["breakout", "long", "bid", "accumulate", "inflow", "强势", "突破", "买入", "吸筹", "资金流入", "利好"];
  const bearish = ["short", "dump", "sell", "unlock", "risk", "outflow", "砸盘", "做空", "解锁", "利空", "风险", "清算"];
  const bull = bullish.filter((word) => text.includes(word.toLowerCase())).length;
  const bear = bearish.filter((word) => text.includes(word.toLowerCase())).length;
  if (bull > bear) return ["偏多", "good"];
  if (bear > bull) return ["风险", "hot"];
  return ["中性", ""];
}

function summarizeTweets(tweets) {
  const bySymbol = new Map();
  const byAuthor = new Map();

  for (const tweet of tweets) {
    for (const symbol of tweet.symbols || []) {
      const item = bySymbol.get(symbol) || { symbol, count: 0, authors: new Set(), keywords: new Map(), directions: { good: 0, hot: 0, neutral: 0 } };
      item.count += 1;
      item.authors.add(tweet.username || tweet.authorName || "unknown");
      for (const word of tweet.keywords || []) item.keywords.set(word, (item.keywords.get(word) || 0) + 1);
      const [, type] = directionForTweet(tweet);
      item.directions[type || "neutral"] += 1;
      bySymbol.set(symbol, item);
    }

    const author = tweet.username || tweet.authorName || "unknown";
    const authorItem = byAuthor.get(author) || { author, count: 0, symbols: new Set() };
    authorItem.count += 1;
    for (const symbol of tweet.symbols || []) authorItem.symbols.add(symbol);
    byAuthor.set(author, authorItem);
  }

  return {
    symbols: [...bySymbol.values()].sort((a, b) => b.count - a.count),
    authors: [...byAuthor.values()].sort((a, b) => b.count - a.count)
  };
}

function renderTweetSummary(tweets) {
  const summary = summarizeTweets(tweets);
  const cards = summary.symbols.slice(0, 6).map((item) => {
    const keywords = [...item.keywords.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
    const direction = item.directions.good > item.directions.hot ? "偏多" : item.directions.hot > item.directions.good ? "风险" : "分歧";
    const type = direction === "偏多" ? "good" : direction === "风险" ? "hot" : "";
    return `
      <article class="summaryCard">
        <b>${item.symbol} <span class="pill ${type}">${direction}</span></b>
        <span>${item.count} 条提及，${item.authors.size} 位博主；关键词：${keywords.join("、") || "暂无"}</span>
      </article>
    `;
  });

  els.summaryCards.innerHTML = cards.length
    ? cards.join("")
    : `<article class="summaryCard"><b>暂无命中</b><span>最近 24 小时未抓到与观察币种相关的推文。</span></article>`;
}

function renderTweets(tweets) {
  els.tweetCards.innerHTML = tweets
    .slice(0, 18)
    .map((tweet) => {
      const [direction, type] = directionForTweet(tweet);
      const tags = [
        `<span class="pill ${type}">${direction}</span>`,
        ...(tweet.symbols || []).slice(0, 6).map((symbol) => `<span class="pill good">${symbol}</span>`),
        ...(tweet.keywords || []).slice(0, 5).map((word) => `<span class="pill">${escapeHtml(word)}</span>`)
      ].join("");
      const url = tweet.url ? `<a class="pill" href="${tweet.url}" target="_blank" rel="noreferrer">原文</a>` : "";
      return `
        <article class="tweetCard">
          <header>
            <h3>${escapeHtml(tweet.authorName || tweet.username || "Unknown")}</h3>
            <span class="tweetMeta">${tweet.createdAt ? new Date(tweet.createdAt).toLocaleString("zh-CN", { hour12: false }) : ""}</span>
          </header>
          <p>${escapeHtml(tweet.text)}</p>
          <div class="tweetTags">${tags}${url}</div>
        </article>
      `;
    })
    .join("");
}

async function refreshTweets() {
  if (tweetLock) return;
  tweetLock = true;
  els.tweetStatus.className = "tweetStatus";
  els.tweetStatus.textContent = "正在抓取重点博主最新观点...";

  try {
    const params = new URLSearchParams({
      handles: trackedHandles().join(","),
      symbols: tweetSymbols().join(",")
    });
    const payload = await fetchJson(`/api/x-tweets?${params.toString()}`, 12000);
    const tweets = payload.tweets || [];
    renderTweetSummary(tweets);
    renderTweets(tweets);
    els.tweetUpdated.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    els.tweetStatus.textContent = `已读取 ${tweets.length} 条相关推文，来源 ${payload.source}${payload.cached ? "，缓存" : ""}。`;
  } catch (error) {
    els.tweetStatus.className = "tweetStatus error";
    els.tweetStatus.textContent = `${error.message}。配置 X_BEARER_TOKEN / Apify / 自建采集器后会自动抓取。`;
    if (!els.summaryCards.innerHTML) {
      els.summaryCards.innerHTML = `<article class="summaryCard"><b>观点源未连接</b><span>市场数据照常刷新；配置后这里会显示博主核心观点。</span></article>`;
    }
  } finally {
    nextTweetRefreshAt = Date.now() + tweetRefreshMs;
    tweetLock = false;
  }
}

function renderSummary(coins) {
  els.coinCount.textContent = coins.length;
  els.strongCount.textContent = coins.filter((coin) => coin.change24h >= 5).length;
  els.hotFundingCount.textContent = coins.filter((coin) => coin.funding >= 0.02).length;
  els.totalVolume.textContent = money(coins.reduce((sum, coin) => sum + Number(coin.volume || 0), 0));
  els.lastUpdated.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function renderBars(target, coins, key) {
  const rows = [...coins].filter((coin) => Number(coin[key]) > 0).sort((a, b) => Number(b[key]) - Number(a[key])).slice(0, 15);
  const max = Math.max(...rows.map((coin) => Number(coin[key])), 1);
  target.innerHTML = rows
    .map(
      (coin) => `
        <div class="barRow">
          <b>${coin.symbol}</b>
          <div class="barTrack"><i class="barFill" style="width:${Math.max(4, (Number(coin[key]) / max) * 100)}%"></i></div>
          <span>${money(coin[key])}</span>
        </div>
      `
    )
    .join("");
}

function renderHeat(coins) {
  const rows = [...coins].sort((a, b) => score(b) - score(a)).slice(0, 30);
  els.heatGrid.innerHTML = rows
    .map((coin) => {
      const [obs, type] = observation(coin);
      const tileType = type || (score(coin) >= 70 ? "good" : score(coin) <= 42 ? "watch" : "");
      return `
        <article class="heatTile ${tileType}">
          <b>${coin.symbol}<em class="${classFor(coin.change24h)}">${pct(coin.change24h)}</em></b>
          <span>${obs}</span>
          <span>费率 ${pct(coin.funding, 4)}</span>
        </article>
      `;
    })
    .join("");
}

function renderTable() {
  const term = els.searchInput.value.trim().toUpperCase();
  const rows = latestCoins.filter((coin) => `${coin.symbol} ${coin.concept}`.toUpperCase().includes(term));
  els.coinRows.innerHTML = rows
    .map((coin) => {
      const [obs, type] = observation(coin);
      const ratio = coin.openInterest ? coin.volume / coin.openInterest : null;
      return `
        <tr>
          <td><b>${coin.symbol}</b></td>
          <td>${coin.concept}</td>
          <td>${money(coin.price)}</td>
          <td class="${classFor(coin.change24h)}"><b>${pct(coin.change24h)}</b></td>
          <td>${money(coin.volume)}</td>
          <td>${money(coin.openInterest)}</td>
          <td>${ratio ? ratio.toFixed(2) : "-"}</td>
          <td class="${coin.funding > 0.02 ? "warn" : classFor(-coin.funding)}">${pct(coin.funding, 4)}</td>
          <td><span class="pill ${type}">${obs}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderFocusCards(coins) {
  const set = new Set(focusSymbols());
  const rows = coins.filter((coin) => set.has(coin.symbol));
  els.focusCards.innerHTML = rows
    .map(
      (coin) => `
        <article class="focusCard">
          <header>
            <h3>${coin.symbol}</h3>
            <span class="pill ${observation(coin)[1]}">${score(coin)}</span>
          </header>
          <div class="metricLine"><span>概念</span><b>${coin.concept}</b></div>
          <div class="metricLine"><span>24h</span><b class="${classFor(coin.change24h)}">${pct(coin.change24h)}</b></div>
          <div class="metricLine"><span>成交额</span><b>${money(coin.volume)}</b></div>
          <div class="metricLine"><span>持仓</span><b>${money(coin.openInterest)}</b></div>
          <div class="metricLine"><span>费率</span><b>${pct(coin.funding, 4)}</b></div>
        </article>
      `
    )
    .join("");
}

function renderAll(coins) {
  renderSummary(coins);
  renderBars(els.volumeBars, coins, "volume");
  renderBars(els.oiBars, coins, "openInterest");
  renderHeat(coins);
  renderTable();
  renderFocusCards(coins);
}

async function refreshData() {
  if (refreshLock) return;
  refreshLock = true;
  els.sourceState.textContent = "刷新中";

  try {
    latestCoins = await buildUniverse();
    renderAll(latestCoins);
    els.sourceState.textContent = "实时";
  } catch (error) {
    els.sourceState.textContent = "接口异常";
    if (!latestCoins.length) {
      latestCoins = Object.values(fallbackFocus);
      renderAll(latestCoins);
    }
  } finally {
    nextRefreshAt = Date.now() + refreshMs;
    refreshLock = false;
  }
}

function tick() {
  const left = Math.max(0, nextRefreshAt - Date.now());
  els.nextRefresh.textContent = `00:${String(Math.ceil(left / 1000)).padStart(2, "0")}`;
  if (left <= 0) refreshData();

  const tweetLeft = Math.max(0, nextTweetRefreshAt - Date.now());
  const tweetMinutes = Math.floor(tweetLeft / 60000);
  const tweetSeconds = Math.ceil((tweetLeft % 60000) / 1000);
  els.tweetRefresh.textContent = `${String(tweetMinutes).padStart(2, "0")}:${String(tweetSeconds).padStart(2, "0")}`;
  if (tweetLeft <= 0) refreshTweets();
}

els.refreshBtn.addEventListener("click", refreshData);
els.tweetRefreshBtn.addEventListener("click", refreshTweets);
els.focusInput.addEventListener("change", refreshData);
els.searchInput.addEventListener("input", renderTable);

refreshData();
refreshTweets();
window.setInterval(tick, 250);
