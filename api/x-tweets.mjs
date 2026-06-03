const keywordList = [
  "breakout",
  "funding",
  "open interest",
  "oi",
  "long",
  "short",
  "spot bid",
  "inflow",
  "outflow",
  "unlock",
  "airdrop",
  "listing",
  "delist",
  "privacy",
  "defi",
  "ai",
  "buyback",
  "revenue",
  "stablecoin",
  "yield",
  "强势",
  "突破",
  "资金流入",
  "资金流出",
  "持仓",
  "费率",
  "多头",
  "空头",
  "解锁",
  "利好",
  "利空",
  "回购",
  "收入",
  "稳定币",
  "收益",
  "隐私",
  "抗量子",
  "清算"
];

const bearerToken = process.env.X_BEARER_TOKEN || "";
const customTweetSourceUrl = process.env.CUSTOM_TWEET_SOURCE_URL || "";
const apifyToken = process.env.APIFY_TOKEN || "";
const apifyActorId = process.env.APIFY_ACTOR_ID || "";

function respond(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=120");
  res.end(JSON.stringify(payload));
}

async function xFetch(path) {
  if (!bearerToken) throw new Error("Missing X_BEARER_TOKEN");
  const response = await fetch(`https://api.twitter.com/2${path}`, {
    headers: { authorization: `Bearer ${bearerToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || body.title || `X API ${response.status}`);
  return body;
}

async function getUserByUsername(username) {
  const data = await xFetch(`/users/by/username/${encodeURIComponent(username)}?user.fields=name,username`);
  return data.data;
}

function analyzeTweet(tweet, author, symbols) {
  const text = tweet.text || "";
  const lower = text.toLowerCase();
  return {
    id: tweet.id,
    text,
    createdAt: tweet.created_at,
    username: author.username,
    authorName: author.name,
    symbols: symbols.filter((symbol) => lower.includes(`$${symbol.toLowerCase()}`) || new RegExp(`\\b${symbol}\\b`, "i").test(text)),
    keywords: keywordList.filter((word) => lower.includes(word.toLowerCase())).slice(0, 8),
    url: `https://x.com/${author.username}/status/${tweet.id}`
  };
}

async function getTweetsForHandle(handle, symbols) {
  const user = await getUserByUsername(handle);
  const data = await xFetch(`/users/${user.id}/tweets?max_results=20&tweet.fields=created_at,public_metrics,lang&exclude=retweets,replies`);
  const since = Date.now() - 28 * 60 * 60 * 1000;
  return (data.data || [])
    .filter((tweet) => !tweet.created_at || new Date(tweet.created_at).getTime() >= since)
    .map((tweet) => analyzeTweet(tweet, user, symbols))
    .filter((tweet) => tweet.symbols.length || tweet.keywords.length);
}

async function customFetchTweets(symbols, handles) {
  if (!customTweetSourceUrl) return null;
  const url = new URL(customTweetSourceUrl);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("handles", handles.join(","));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `CUSTOM_TWEET_SOURCE_URL ${response.status}`);
  return (body.tweets || body.data || []).map((tweet) => {
    const text = tweet.text || tweet.full_text || "";
    return {
      id: tweet.id || tweet.url || `${tweet.username || "source"}-${tweet.createdAt || Date.now()}`,
      text,
      createdAt: tweet.createdAt || tweet.created_at || tweet.time,
      username: tweet.username || tweet.handle || "source",
      authorName: tweet.authorName || tweet.name || tweet.username || "source",
      symbols: tweet.symbols || symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`, "i").test(text)),
      keywords: tweet.keywords || keywordList.filter((word) => text.toLowerCase().includes(word.toLowerCase())).slice(0, 8),
      url: tweet.url || ""
    };
  });
}

async function apifyFetchTweets(symbols, handles) {
  if (!apifyToken || !apifyActorId) return null;
  const response = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(apifyActorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handles,
      usernames: handles,
      searchTerms: symbols.map((symbol) => `$${symbol}`),
      maxItems: 80
    })
  });
  const items = await response.json().catch(() => []);
  if (!response.ok) throw new Error(items.error?.message || `Apify ${response.status}`);
  return (Array.isArray(items) ? items : []).map((tweet) => {
    const text = tweet.text || tweet.fullText || tweet.full_text || "";
    const username = tweet.username || tweet.user?.username || tweet.author?.userName || "apify";
    return {
      id: tweet.id || tweet.tweetId || tweet.url || `${username}-${tweet.createdAt || Date.now()}`,
      text,
      createdAt: tweet.createdAt || tweet.created_at || tweet.timestamp,
      username,
      authorName: tweet.authorName || tweet.user?.name || tweet.author?.name || username,
      symbols: symbols.filter((symbol) => text.includes(`$${symbol}`) || new RegExp(`\\b${symbol}\\b`, "i").test(text)),
      keywords: keywordList.filter((word) => text.toLowerCase().includes(word.toLowerCase())).slice(0, 8),
      url: tweet.url || (tweet.id ? `https://x.com/${username}/status/${tweet.id}` : "")
    };
  });
}

export default async function handler(req, res) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const symbols = (requestUrl.searchParams.get("symbols") || "BTC,HYPE,ENA,ZEC,NEAR,TAO,FET,RENDER")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const handles = (requestUrl.searchParams.get("handles") || "Bluntz_Capital,CryptoHayes,alpha_pls,blknoiz06,based16z,insomniacxbt")
    .split(",")
    .map((item) => item.trim().replace(/^@/, ""))
    .filter(Boolean);

  try {
    const customTweets = await customFetchTweets(symbols, handles);
    if (customTweets) {
      return respond(res, 200, { source: "custom-source", handles, tweets: customTweets.slice(0, 80) });
    }

    const apifyTweets = await apifyFetchTweets(symbols, handles);
    if (apifyTweets) {
      return respond(res, 200, { source: "apify", handles, tweets: apifyTweets.slice(0, 80) });
    }

    const settled = await Promise.allSettled(handles.slice(0, 10).map((handle) => getTweetsForHandle(handle, symbols)));
    const failures = settled.filter((item) => item.status === "rejected");
    const tweets = settled
      .flatMap((item) => (item.status === "fulfilled" ? item.value : []))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 80);

    if (failures.length === settled.length) {
      throw new Error(failures[0]?.reason?.message || "All X API requests failed");
    }

    return respond(res, 200, { source: "x-api", handles, tweets });
  } catch (error) {
    return respond(res, 502, { error: error.message || "Tweet source unavailable" });
  }
}
