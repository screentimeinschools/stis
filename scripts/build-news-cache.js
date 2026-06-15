const fs = require("node:fs/promises");
const path = require("node:path");

const STATE_ABBR = {
  Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY"
};

const STATE_BOOSTS = {
  Connecticut:["HB 5035","HB 5149","cellular phones","phone-free schools"],
  California:["Phone-Free Schools Act","LAUSD","school smartphone policy"],
  Florida:["HB 1105","school phone ban"],
  "New York":["Hochul","phone storage","bell-to-bell"],
  Texas:["HB 1481","school phone ban"],
  Utah:["HB 273","classroom screen time"]
};

const STATES = Object.keys(STATE_ABBR).sort();

function xmlDecode(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tag(item, name) {
  const match = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? xmlDecode(match[1].trim()) : "";
}

function sourceTag(item) {
  const match = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return match ? xmlDecode(match[1].trim()) : "";
}

function cleanGoogleTitle(title) {
  return title.replace(/\s+-\s+[^-]+$/,"").trim();
}

function queryForState(state) {
  return [
    `${state} school cell phone ban`,
    `${state} school cellphone ban`,
    `${state} students phones schools`,
    `${state} classroom phone ban`,
    `${state} phone-free schools`,
    `${state} school screen time`,
    `${state} school district cell phone policy`,
    `${state} school Chromebook screen time`,
    ...(STATE_BOOSTS[state] || []).map(term => `${state} ${term}`)
  ];
}

function score(item, state) {
  const text = `${item.title || item.headline || ""} ${item.source || ""} ${item.url || ""}`.toLowerCase();
  let total = 0;
  if (text.includes(state.toLowerCase())) total += 4;
  if (STATE_ABBR[state] && new RegExp(`\\b${STATE_ABBR[state].toLowerCase()}\\b`).test(text)) total += 1;
  ["school","schools","classroom","student","students","district","education","board"].forEach(k => {
    if (text.includes(k)) total += 1;
  });
  ["cell phone","cellphone","smartphone","phone ban","phone-free","screen time","chromebook","digital device","school-issued"].forEach(k => {
    if (text.includes(k)) total += 2;
  });
  (STATE_BOOSTS[state] || []).forEach(k => {
    if (text.includes(k.toLowerCase())) total += 3;
  });
  return total;
}

function hasStateSignal(item, state) {
  const text = `${item.title || item.headline || ""} ${item.source || ""}`.toLowerCase();
  if (text.includes(state.toLowerCase())) return true;
  const abbr = STATE_ABBR[state];
  return !!(abbr && new RegExp(`\\b${abbr.toLowerCase()}\\b`).test(text));
}

async function fetchGoogleNews(state, maxQueries = 4) {
  const seen = new Set();
  const items = [];
  for (const q of queryForState(state).slice(0, maxQueries)) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {headers: {"user-agent": "ScreenTimeInSchoolsPolicyTracker/1.0"}});
    if (!res.ok) continue;
    const xml = await res.text();
    const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
    itemBlocks.forEach(block => {
      const title = cleanGoogleTitle(tag(block, "title"));
      const itemUrl = tag(block, "link");
      const date = tag(block, "pubDate");
      const source = sourceTag(block) || "Google News";
      const item = {
        state,
        district: null,
        headline: title.length > 115 ? `${title.slice(0,112)}...` : title,
        date,
        source,
        url: itemUrl,
        type: "scrape",
        free: true
      };
      const key = item.url || item.headline;
      if (key && !seen.has(key) && hasStateSignal(item, state) && score(item, state) >= 5) {
        seen.add(key);
        items.push(item);
      }
    });
  }
  return items.sort((a,b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 8);
}

async function main() {
  const all = [];
  for (let i = 0; i < STATES.length; i += 8) {
    const batch = STATES.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(state => fetchGoogleNews(state, state === "Connecticut" ? 10 : 4)));
    results.forEach((result, index) => {
      const state = batch[index];
      if (result.status === "fulfilled") all.push(...result.value);
      else console.warn(`News fetch failed for ${state}: ${result.reason?.message || result.reason}`);
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    count: all.length,
    items: all.sort((a,b) => new Date(b.date || 0) - new Date(a.date || 0))
  };

  await fs.writeFile(path.join(process.cwd(), "news-cache.json"), `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(
    path.join(process.cwd(), "news-cache.js"),
    `window.NEWS_CACHE_DATA = ${JSON.stringify(payload, null, 2)};\n`
  );
  console.log(`Wrote news-cache.json and news-cache.js with ${payload.count} items across ${new Set(payload.items.map(i => i.state)).size} states.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
