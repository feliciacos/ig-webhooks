// index.js (CommonJS) - Multi-account with config.json + cookie.json + robust fallbacks
const fs = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");
const dns = require("node:dns").promises;

// ---------- Config loader ----------
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(__dirname, "config.json");
const COOKIE_PATH = path.resolve(__dirname, "cookie.json");

async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);

  if (!cfg || !Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    throw new Error("config.json must have a non-empty 'targets' array");
  }
  if (!cfg.webhook && !cfg.targets.every((t) => !!t.webhook)) {
    throw new Error("Provide a default 'webhook' in config.json or a 'webhook' for every target");
  }
  cfg.pollSeconds = Number(cfg.pollSeconds || 3600);
  cfg.perRequestDelayMs = Number(cfg.perRequestDelayMs || 4000);

  // If cookie.json exists, load it
  try {
    const rawCookies = await fs.readFile(COOKIE_PATH, "utf8");
    cfg.cookies = JSON.parse(rawCookies);
    console.log(`Loaded ${cfg.cookies.length} cookies from cookie.json`);
  } catch {
    // no cookie.json, ignore
  }

  return cfg;
}

// ---------- Cookie helpers ----------
function fullyDecode(s) {
  if (!s) return "";
  let prev, cur = String(s);
  for (let i = 0; i < 5; i++) {
    prev = cur;
    try { cur = decodeURIComponent(cur); } catch {}
    if (cur === prev) break;
  }
  return cur;
}
function normalizeCookieValue(v) {
  let val = fullyDecode(String(v ?? "").trim());
  val = val.replace(/\\054/g, ","); // \054 -> comma
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    val = val.slice(1, -1);
  }
  return val;
}
function cookieArrayToHeader(cookiesArray) {
  const wanted = new Set([
    "sessionid","csrftoken","ds_user_id","rur",
    "ig_did","mid","ig_direct_region_hint","datr","wd"
  ]);
  const parts = [];
  const map = {};
  for (const c of cookiesArray) {
    if (!c || !c.name) continue;
    if (!wanted.has(c.name)) continue;
    const val = normalizeCookieValue(c.value);
    if (!val) continue;
    parts.push(`${c.name}=${val}`);
    map[c.name] = val;
  }
  return { header: parts.join("; ") + (parts.length ? ";" : ""), map };
}

function buildCookie({ cookieFromCfg, sessionIdFromCfg, sessionIdFromEnv, cookiesArray }) {
  // 1) ENV sessionid wins
  const sidEnv = fullyDecode(sessionIdFromEnv || "");
  if (sidEnv) return { header: `sessionid=${sidEnv};`, map: { sessionid: sidEnv } };

  // 2) Full cookie string in config
  const rawCookie = fullyDecode(cookieFromCfg || "");
  if (rawCookie) {
    const header = rawCookie
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .join("; ") + (rawCookie.trim().endsWith(";") ? "" : ";");
    // Build a minimal map from that string (best-effort)
    const map = {};
    header.split(";").forEach(kv => {
      const [k, ...rest] = kv.trim().split("=");
      if (k && rest.length) map[k] = rest.join("=");
    });
    return { header, map };
  }

  // 3) cookies array in config (recommended)
  if (Array.isArray(cookiesArray) && cookiesArray.length) {
    const { header, map } = cookieArrayToHeader(cookiesArray);
    if (map.sessionid) return { header, map };
  }

  // 4) sessionid value in config
  const cfgSid = fullyDecode(sessionIdFromCfg || "");
  if (cfgSid) return { header: `sessionid=${cfgSid};`, map: { sessionid: cfgSid } };

  return { header: "", map: {} };
}

const IG_SESSIONID_ENV = fullyDecode(process.env.IG_SESSIONID || "");
const CAPTION_LIMIT = Number(process.env.CAPTION_LIMIT || 2000);
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, "state.json");

// ---------- State ----------
async function loadState() {
  try {
    const s = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(s);
  } catch {
    return {};
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Low-level IPv4 HTTPS GET ----------
async function httpsGet(hostname, pathStr, headers) {
  const { address } = await dns.lookup(hostname, { family: 4 });
  const options = {
    host: address,
    servername: hostname, // SNI
    method: "GET",
    path: pathStr,
    headers,
    timeout: 15000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, statusText: res.statusMessage, text: buf }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

// ---------- IG fetches ----------
async function fetchProfileJson(username, cookieHeader, csrfToken) {
  const desktopUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const mobileUrl  = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  // 1) Try MOBILE web first (i.instagram.com)
  try {
    const res = await fetch(mobileUrl, {
      headers: {
        // Mobile UA is key here
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        "X-IG-App-ID": "936619743392459",
        "X-ASBD-ID": "129477",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": `https://www.instagram.com/${username}/`,
        "X-CSRFToken": csrfToken || "",
        Cookie: cookieHeader,
      },
    });
    if (res.ok) {
      return await res.json();
    }
    // fall through if not ok
  } catch (e) {
    // try desktop path next
    console.warn(`[${new Date().toISOString()}] mobile profile fetch failed: ${e.message}`);
  }

  // 2) Desktop as a secondary attempt
  const res = await fetch(desktopUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "129477",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://www.instagram.com/${username}/`,
      "X-CSRFToken": csrfToken || "",
      Cookie: cookieHeader,
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`IG request failed: ${res.status} ${res.statusText} — ${t.slice(0, 200)}`);
  }
  return await res.json();
}

async function fetchProfileHtml(username, cookieHeader, csrfToken) {
  // Get the public profile HTML and try to find a recent shortcode
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username}/`,
    "X-CSRFToken": csrfToken || "",
    Cookie: cookieHeader,
    Host: "www.instagram.com",
  };
  const { status, statusText, text } = await httpsGet("www.instagram.com", `/${encodeURIComponent(username)}/`, headers);
  if (status < 200 || status >= 300) {
    throw new Error(`Profile HTML failed: ${status} ${statusText || ""} — ${String(text).slice(0,200)}`);
  }
  return text;
}

async function fetchOEmbed(shortcode) {
  const url = `https://www.instagram.com/oembed/?url=${encodeURIComponent(`https://www.instagram.com/p/${shortcode}/`)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`oEmbed failed: ${res.status} ${res.statusText}`);
  return await res.json(); // {thumbnail_url, author_name, title, ...}
}

async function fetchUserFeedById(userId, cookieHeader, csrfToken, count = 12) {
  const url = `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?count=${count}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "129477",
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "X-CSRFToken": csrfToken || "",
      "Referer": "https://www.instagram.com/",
      Cookie: cookieHeader,
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`IG user-feed failed: ${res.status} ${res.statusText} — ${t.slice(0,200)}`);
  }
  return await res.json();
}

// Try JSON → if empty, try HTML scrape for a shortcode → oEmbed for details
async function fetchLatestPost(username, cookieHeader, csrfToken) {
  // 1) Profile JSON (mobile first inside fetchProfileJson)
  let json;
  try {
    json = await fetchProfileJson(username, cookieHeader, csrfToken);
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] profile JSON failed (${e.message})`);
  }

  // extract from profile JSON if present
  const user = json?.data?.user;
  const edges = user?.edge_owner_to_timeline_media?.edges;
  if (edges && edges.length > 0) {
    const node = edges[0].node;
    const shortcode = node.shortcode;
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;
    const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
    const timestamp = node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000) : null;
    const isVideo = !!node.is_video;
    const owner = user.full_name || user.username;
    let imageUrl = node.display_url || "";
    const sidecar = node.edge_sidecar_to_children?.edges;
    if (Array.isArray(sidecar) && sidecar.length > 0) {
      const first = sidecar[0]?.node;
      if (first?.display_url) imageUrl = first.display_url;
    }
    return { username, shortcode, postUrl, caption, timestamp, isVideo, owner, imageUrl };
  }

  // 2) If we got a user id from profile JSON, try the mobile USER FEED endpoint
  const userId = user?.id;
  if (userId) {
    try {
      const feed = await fetchUserFeedById(userId, cookieHeader, csrfToken, 12);
      // Mobile feed returns items under "items"
      if (Array.isArray(feed?.items) && feed.items.length > 0) {
        const it = feed.items[0];
        // Try to normalize fields
        const shortcode = it?.code || it?.pk || it?.id; // code is usually the shortcode
        const postUrl = shortcode ? `https://www.instagram.com/p/${shortcode}/` : `https://www.instagram.com/${username}/`;
        const caption = it?.caption?.text || "";
        const timestamp = it?.taken_at ? new Date(it.taken_at * 1000) : null;
        const owner = it?.user?.full_name || it?.user?.username || username;

        let imageUrl = "";
        if (it?.image_versions2?.candidates?.length) {
          imageUrl = it.image_versions2.candidates[0].url;
        } else if (Array.isArray(it?.carousel_media) && it.carousel_media.length > 0) {
          const first = it.carousel_media[0];
          imageUrl = first?.image_versions2?.candidates?.[0]?.url || "";
        } else if (it?.thumbnail_url) {
          imageUrl = it.thumbnail_url;
        }

        return { username, shortcode: String(shortcode), postUrl, caption, timestamp, isVideo: !!it?.video_versions, owner, imageUrl };
      }
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] user feed failed (${e.message})`);
    }
  }

  // 3) HTML + oEmbed fallback (as you already have)
  const html = await fetchProfileHtml(username, cookieHeader, csrfToken);

  const candidates = new Set();
  // "shortcode":"XXXX"
  { const re = /"shortcode"\s*:\s*"([A-Za-z0-9_-]{5,})"/g; const m = re.exec(html); if (m) candidates.add(m[1]); }
  // href="/p/XXXX/"
  if (candidates.size === 0) {
    const re = /href="\/p\/([A-Za-z0-9_-]{5,})\//g;
    const m = re.exec(html);
    if (m) candidates.add(m[1]);
  }
  // /p/XXXX/? variants
  if (candidates.size === 0) {
    const re = /\/p\/([A-Za-z0-9_-]{5,})\/\?/g;
    const m = re.exec(html);
    if (m) candidates.add(m[1]);
  }

  if (candidates.size === 0) {
    try {
      const dumpPath = path.resolve(__dirname, "last_profile.html");
      await fs.writeFile(dumpPath, html.slice(0, 200_000));
      console.warn(`[${new Date().toISOString()}] HTML fallback found no shortcode. Wrote snapshot to ${dumpPath}`);
    } catch {}
    return null;
  }

  const shortcode = [...candidates][0];
  let imageUrl = "";
  let caption = "";
  let ownerName = username;
  try {
    const emb = await fetchOEmbed(shortcode);
    imageUrl = emb.thumbnail_url || "";
    caption = (emb.title || "").toString();
    ownerName = emb.author_name || ownerName;
  } catch {}
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  return { username, shortcode, postUrl, caption, timestamp: null, isVideo: false, owner: ownerName, imageUrl };
}

// ---------- Discord ----------
async function postToDiscord(webhook, { owner, username, postUrl, caption, imageUrl, timestamp }) {
  const desc = caption ? caption.slice(0, CAPTION_LIMIT) : "";
  const embed = {
    title: `New post from ${owner || username}`,
    url: postUrl,
    description: desc,
    color: 0xe1306c,
    image: imageUrl ? { url: imageUrl } : undefined,
    timestamp: (timestamp || new Date()).toISOString(),
    footer: { text: "Instagram" },
    author: { name: `@${username}`, url: `https://www.instagram.com/${username}/` },
    fields: [
      {
        name: "IG-Webhooks",
        value: "[Feliciacos](https://github.com/feliciacos)",
        inline: true,
      },
    ],
  };
  const payload = { embeds: [embed] };
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} — ${text.slice(0,180)}`);
  }
}

// ---------- Per-target ----------
async function processTarget(target, state, defaultWebhook, cookieHeader, cookieMap, sendOnFirstRun = false) {
  const username = target.username;
  const webhook = target.webhook || defaultWebhook;
  if (!username || !webhook) return;

  const csrf = cookieMap?.csrftoken || "";
  try {
    const latest = await fetchLatestPost(username, cookieHeader, csrf);
    if (!latest) {
      console.log(`[${new Date().toISOString()}] No posts found yet for @${username}`);
      return;
    }

    const lastSeen = state[username]?.lastShortcode || null;
    const isFirst = lastSeen == null;

    if (isFirst && sendOnFirstRun) {
      console.log(`[${new Date().toISOString()}] First run for @${username} → sending latest ${latest.shortcode}`);
      await postToDiscord(webhook, latest);
      state[username] = { lastShortcode: latest.shortcode };
      await saveState(state);
      return;
    }

    if (lastSeen !== latest.shortcode) {
      console.log(`[${new Date().toISOString()}] New post for @${username}: ${latest.shortcode}`);
      await postToDiscord(webhook, latest);
      state[username] = { lastShortcode: latest.shortcode };
      await saveState(state);
    } else {
      console.log(`[${new Date().toISOString()}] No new post for @${username} (last ${lastSeen})`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] @${username} error: ${err.stack || err.message}`);
  }
}

// ---------- Main ----------
async function main() {
  const cfg = await loadConfig();
  let state = await loadState();

  const { header: cookieHeader, map: cookieMap } = buildCookie({
    cookieFromCfg: cfg.cookie,
    sessionIdFromCfg: cfg.sessionid,
    sessionIdFromEnv: process.env.IG_SESSIONID,
    cookiesArray: cfg.cookies
  });

  if (!cookieHeader || !cookieMap.sessionid) {
    console.error("Missing cookie/sessionid. Provide IG_SESSIONID env, or add 'sessionid'/'cookie' in config.json, or export cookie.json.");
    process.exit(1);
  }

  console.log(
    `Using ${
      process.env.IG_SESSIONID ? "sessionid from ENV"
      : cfg.cookie ? "cookie from config.json"
      : cfg.cookies ? "cookie.json"
      : "sessionid from config.json"
    }`
  );
  console.log(
    `Watching ${cfg.targets.map((t) => "@" + t.username).join(", ")} every ${cfg.pollSeconds}s`
  );

  async function cycle() {
    for (const target of cfg.targets) {
      await processTarget(target, state, cfg.webhook, cookieHeader, cookieMap, !!cfg.sendOnFirstRun);
      await sleep(cfg.perRequestDelayMs);
    }
  }

  await cycle();
  setInterval(cycle, cfg.pollSeconds * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
