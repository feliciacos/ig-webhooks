// index.js (CommonJS) - Multi-account with config.json
const fs = require("node:fs/promises");
const path = require("node:path");

// ---------- Load config ----------
const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(__dirname, "config.json");
async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);

  if (!cfg || !Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    throw new Error("config.json must have a non-empty 'targets' array");
  }
  if (!cfg.webhook && !cfg.targets.every(t => !!t.webhook)) {
    throw new Error("Provide a default 'webhook' in config.json or a 'webhook' for every target");
  }
  cfg.pollSeconds = Number(cfg.pollSeconds || 3600);
  cfg.perRequestDelayMs = Number(cfg.perRequestDelayMs || 4000);
  return cfg;
}

// ---------- Env ----------
const IG_SESSIONID = process.env.IG_SESSIONID || "";
const CAPTION_LIMIT = Number(process.env.CAPTION_LIMIT || 2000);
const STATE_FILE = process.env.STATE_FILE || path.resolve(__dirname, "state.json");

if (!IG_SESSIONID) {
  console.error("Missing IG_SESSIONID env var (paste your browser 'sessionid' cookie).");
  process.exit(1);
}

// ---------- State (per username) ----------
async function loadState() {
  try {
    const s = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // { [username]: { lastShortcode: "ABC123" } }
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchLatestPost(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
    username
  )}`;

  const res = await fetch(url, {
    headers: {
      // Pretend to be a normal browser & include your session cookie:
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "X-IG-App-ID": "936619743392459", // IG web app id; can change periodically
      Cookie: `sessionid=${IG_SESSIONID};`,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://www.instagram.com/${username}/`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if ([401, 403, 429].includes(res.status)) {
      throw new Error(`IG blocked (${res.status}). Possibly rate-limited. ${text.slice(0, 180)}`);
    }
    throw new Error(`IG request failed: ${res.status} ${res.statusText} — ${text.slice(0, 180)}`);
  }

  const json = await res.json();
  const user = json?.data?.user;
  if (!user) throw new Error("No user in response (endpoint/shape may have changed).");

  const edges = user.edge_owner_to_timeline_media?.edges;
  if (!edges?.length) return null;

  const node = edges[0].node;
  const shortcode = node.shortcode;
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  const timestamp = node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000) : null;
  const isVideo = !!node.is_video;
  const owner = user.full_name || user.username;

  // Pick image: single image / video thumb / first of carousel
  let imageUrl = node.display_url || "";
  const sidecar = node.edge_sidecar_to_children?.edges;
  if (Array.isArray(sidecar) && sidecar.length > 0) {
    const first = sidecar[0]?.node;
    if (first?.display_url) imageUrl = first.display_url;
  }

  return { username, shortcode, postUrl, caption, timestamp, isVideo, owner, imageUrl };
}

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
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} — ${text.slice(0, 180)}`);
  }
}

// Process one username (used by the loop)
async function processTarget(target, state, defaultWebhook) {
  const username = target.username;
  const webhook = target.webhook || defaultWebhook;

  if (!username) {
    console.warn("Skipping target with no 'username'.");
    return;
  }
  if (!webhook) {
    console.warn(`Skipping @${username}: no webhook (neither default nor override).`);
    return;
  }

  try {
    const latest = await fetchLatestPost(username);
    if (!latest) {
      console.log(`[${new Date().toISOString()}] No posts found yet for @${username}`);
      return;
    }

    const lastSeen = state[username]?.lastShortcode || null;
    if (lastSeen !== latest.shortcode) {
      console.log(
        `[${new Date().toISOString()}] New post for @${username}: ${latest.shortcode}`
      );
      await postToDiscord(webhook, latest);
      state[username] = { lastShortcode: latest.shortcode };
      await saveState(state);
    } else {
      console.log(
        `[${new Date().toISOString()}] No new post for @${username} (last ${lastSeen})`
      );
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] @${username} error: ${err.message}`);
  }
}

// ---------- Main loop ----------
async function main() {
  const cfg = await loadConfig();
  let state = await loadState();

  console.log(
    `Watching ${cfg.targets.map(t => "@" + t.username).join(", ")} every ${cfg.pollSeconds}s`
  );

  async function cycle() {
    for (const target of cfg.targets) {
      await processTarget(target, state, cfg.webhook);
      // be gentle with IG:
      await sleep(cfg.perRequestDelayMs);
    }
  }

  // run immediately once, then repeat
  await cycle();
  setInterval(cycle, cfg.pollSeconds * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
