**Instagram → Discord Notifier (Node)**
This script checks Instagram accounts for new posts and sends them to a Discord channel via a Discord Webhook.
It supports multiple Instagram accounts and an optional per-account webhook override.

- Important: Instagram’s web API is undocumented and can change. Use gentle polling and only monitor accounts you can legally view (public, or private accounts you follow).

1) Requirements
- Node.js 18 or newer (for built-in fetch)
- A Discord Webhook URL (Server Settings → Integrations → Webhooks → New Webhook → Copy URL)
- Your Instagram session cookie (sessionid) from a browser where you’re logged in

2) Get your Instagram cookie/sessionid
- You need a valid Instagram session cookie so the script can fetch your feed like a real browser.

**Easiest method (Firefox example)**
- Install “Cookie-Editor” for Firefox:
- https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/
- Go to instagram in the browser, click the addon and export the cookie as cookie.json in the project dir.

**3) Configure accounts (config.json)**
- Create a config.json next to index.js:
```json
{
  "sessionid": "SESSIONID",
  "webhook": "https://discord.com/api/webhooks/DEFAULT_WEBHOOK_ID/TOKEN",
  "pollSeconds": 3600,
  "perRequestDelayMs": 4000,
  "sendOnFirstRun": true,
  "targets": [
    { "username": "username1" },
    { "username": "username2", "webhook": "https://discord.com/api/webhooks/ALT_WEBHOOK_ID/TOKEN" },
    { "username": "username3" }
  ]
}
```
Explanation:
- Webhook: Default Discord webhook for all accounts.
- Targets: List of Instagram usernames to monitor.
  Each entry can optionally set its own webhook to override the default.
- pollSeconds: How often to check for new posts (recommend 1800–3600).
- perRequestDelayMs: Delay between requests to different accounts to reduce rate limits.

**4) Run**
```bash
node index.js
```
On first run, the script records the latest post per account in state.json and will only send to Discord when a new post appears (shortcode changes).
To force a send for testing, delete the state file and run again:
```bash
rm -f ./state.json
node index.js
```

**Testing your Discord webhook**
If no messages appear in Discord, verify the webhook independently:
```bash
curl -H "Content-Type: application/json" \
  -d '{"content":"Webhook test"}' \
  "https://discord.com/api/webhooks/ID/TOKEN"
```
If this works, the webhook is valid. If not, recreate it in Discord and update your config.

**Troubleshooting**
- 401 / 403 / 429 from Instagram
You are either rate-limited or the sessionid is invalid/expired.
Actions:
        - Increase pollSeconds (start with 3600).
        - Ensure perRequestDelayMs is at least 3000–5000.
        - Obtain a fresh sessionid from your browser and try again.
        - Avoid rapidly restarting the script; it can extend temporary blocks.
- Nothing posts to Discord
        - Confirm the webhook with the curl test above.
        - Check logs printed by node index.js.
        - Delete state.json to force an initial send.
- Monitoring private accounts
        - You must be able to view the account in the same browser where you copied sessionid. If you cannot see the posts in that browser, the script cannot fetch them.

**Optional: run as a systemd user service (Linux)**
Create an environment file:
```bash
mkdir -p ~/.config/ig-discord-notifier
cat > ~/.config/ig-discord-notifier/env <<'EOF'
IG_SESSIONID=PASTE_YOUR_SESSIONID
CAPTION_LIMIT=2000
STATE_FILE=/home/USERNAME/ig-discord-notifier/state.json
CONFIG_PATH=/home/USERNAME/ig-discord-notifier/config.json
EOF
chmod 600 ~/.config/ig-discord-notifier/env
```
Create a unit file:
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ig-discord-notifier.service <<'EOF'
[Unit]
Description=IG -> Discord Notifier (Node)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/ig-discord-notifier/env
WorkingDirectory=%h/ig-discord-notifier
ExecStart=/usr/bin/node %h/ig-discord-notifier/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
```
Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable --now ig-discord-notifier.service
journalctl --user -u ig-discord-notifier.service -f
```
