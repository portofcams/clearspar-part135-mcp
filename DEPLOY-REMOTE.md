# Deploying the Clearspar Part 135 remote MCP server

`build/index.js` = unchanged **stdio** server. `build/http.js` = new **remote
Streamable HTTP** server (rate-limited; tools proxy a key-gated backend).

## 1. Build
```bash
npm ci && npm run build
```

## 2. Run — CLEARSPAR_API_KEY is REQUIRED (server-side)
```bash
CLEARSPAR_API_KEY=<DIGEST_API_KEY value> PORT=8091 node build/http.js
```
The 5 analytics tools call `clearspar.binnacleai.com/api/prospects` with this key
(X-API-Key). Callers never see it. Without the key the tools return a 401 error.
Tools are **aggregate** (market summary, HHI, rankings) — not the raw operator
export — and `/mcp` is rate-limited to 120 req/min/IP.

## 3. systemd unit (Vultr 144.202.116.229)
Deploy to `/root/clearspar-part135-mcp`, then `/etc/systemd/system/clearspar-part135-mcp.service`:
```ini
[Unit]
Description=Clearspar Part 135 remote MCP server
After=network.target

[Service]
WorkingDirectory=/root/clearspar-part135-mcp
Environment=PORT=8091
Environment=CLEARSPAR_API_KEY=__SET_ME__
ExecStart=/usr/bin/node build/http.js
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
systemctl enable --now clearspar-part135-mcp
```

## 4. DNS + Nginx Proxy Manager
- Cloudflare: `A  clearspar-part135-mcp.portofcams.com -> 144.202.116.229`
- NPM: proxy host `clearspar-part135-mcp.portofcams.com -> 127.0.0.1:8091`, SSL on, **Websockets support enabled**.

## 5. Verify
```bash
curl https://clearspar-part135-mcp.portofcams.com/healthz   # keyConfigured:true
curl https://clearspar-part135-mcp.portofcams.com/privacy
```

## 6. MCP Registry remote entry
Confirm `server-remote.json` url, then `mcp-publisher login github` + `mcp-publisher publish server-remote.json`.

## 7. Anthropic Connectors Directory
Eligible once deployed (remote HTTPS, readOnlyHint on every tool, public /privacy). Still needs a Team/Enterprise Claude org for the submission portal.
