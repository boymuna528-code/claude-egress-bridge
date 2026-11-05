# Cloudflare Native Deployment Guide: Claude Web Egress Bridge

This guide provides step-by-step instructions for deploying the **Claude Web Egress Bridge & Scraper Proxy** to Cloudflare infrastructure.

> **Mobile Friendly:** Every step below can be executed directly from your **Android mobile browser** via the [Cloudflare Dashboard](https://dash.cloudflare.com), or using the `wrangler` CLI on your computer or terminal.

---

## 1. Cloudflare Resources Architecture

The application uses the following Cloudflare services:

| Service | Name in Config | Purpose |
| :--- | :--- | :--- |
| **Cloudflare Workers** | `claude-web-egress-bridge` | Main API gateway, MCP 2.0 host, and outbound egress proxy |
| **Cloudflare R2** | `STORAGE_BUCKET` (`claude-egress-assets`) | Multi-gigabyte object storage with zero egress fees |
| **Cloudflare D1** | `DB` (`claude_egress_db`) | Serverless SQL database for projects, files, and audit logs |
| **Cloudflare Queues** | `DOWNLOAD_QUEUE` (`claude-egress-downloads`) | Non-blocking background download and streaming transfers |
| **Browser Rendering** | `MYBROWSER` | Headless Chromium Puppeteer automation for dynamic JS pages |

---

## 2. Option A: Deployment via Android Phone / Mobile Browser (Zero Terminal Required)

### Step 1: Create the Cloudflare R2 Bucket
1. Open [dash.cloudflare.com](https://dash.cloudflare.com) on Chrome/Firefox on your Android phone.
2. Tap the menu &rarr; **R2 Object Storage** &rarr; **Overview**.
3. Tap **Create bucket**.
4. Enter the bucket name: `claude-egress-assets` and tap **Create Bucket**.

### Step 2: Create the Cloudflare D1 SQL Database
1. In the Cloudflare Dashboard, tap **Workers & Pages** &rarr; **D1 SQL Database**.
2. Tap **Create database**.
3. Set the name to: `claude_egress_db` and tap **Create**.
4. Copy the **Database ID** (you will paste this into your Worker binding or `wrangler.jsonc`).
5. Tap the **Console** tab inside your new D1 database, paste the SQL from `migrations/0001_initial_schema.sql`, and tap **Execute**. This creates the `projects`, `files`, `download_jobs`, `audit_logs`, and `mcp_sessions` tables.

### Step 3: Create Cloudflare Queue (Optional for Async Transfers)
1. Tap **Queues** &rarr; **Create Queue**.
2. Name it: `claude-egress-downloads` and tap **Create**.

### Step 4: Deploy the Worker
1. Tap **Workers & Pages** &rarr; **Overview** &rarr; **Create application** &rarr; **Create Worker**.
2. Set the Worker name: `claude-web-egress-bridge` and tap **Deploy**.
3. After deployment, tap the Worker &rarr; **Settings** &rarr; **Bindings**:
   - **Add binding &rarr; R2 Bucket**: Variable name `STORAGE_BUCKET`, Bucket `claude-egress-assets`.
   - **Add binding &rarr; D1 Database**: Variable name `DB`, Database `claude_egress_db`.
   - **Add binding &rarr; Queue Producer**: Variable name `DOWNLOAD_QUEUE`, Queue `claude-egress-downloads`.
   - *(Optional on Workers Paid)* **Add binding &rarr; Browser Rendering**: Variable name `MYBROWSER`.
4. Under **Settings &rarr; Variables and Secrets**:
   - Add secret `GEMINI_API_KEY`: *(Optional, for Google Search Grounding)*
   - Add variable `ENVIRONMENT`: `production`

---

## 3. Option B: Deployment via Wrangler CLI

If you have a terminal on your computer or an Android terminal emulator (Termux):

```bash
# 1. Log in to Cloudflare
npx wrangler login

# 2. Build the frontend dashboard
npm run build

# 3. Create the R2 bucket
npx wrangler r2 bucket create claude-egress-assets

# 4. Create the D1 database
npx wrangler d1 create claude_egress_db
# (Copy the database_id returned and update it in wrangler.jsonc)

# 5. Execute initial database migration
npx wrangler d1 execute claude_egress_db --file=migrations/0001_initial_schema.sql

# 6. Create the Cloudflare Queue
npx wrangler queues create claude-egress-downloads

# 7. Deploy the Worker to Cloudflare's Edge
npx wrangler deploy
```

---

## 4. Connecting Claude Free to Your Deployed MCP Gateway

Once your Worker is deployed, your public MCP URL will be:
```
https://claude-web-egress-bridge.<your-subdomain>.workers.dev/api/mcp
```

### Method 1: Claude Code CLI
In your local terminal:
```bash
claude mcp add web-bridge --url https://claude-web-egress-bridge.<your-subdomain>.workers.dev/api/mcp
```

### Method 2: Claude Desktop App
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "web-bridge": {
      "url": "https://claude-web-egress-bridge.<your-subdomain>.workers.dev/api/mcp",
      "transport": "http"
    }
  }
}
```

### Method 3: Free Claude Web Chat (claude.ai)
In your free Claude chat window, set your Project instructions or prompt:
```
You have access to a remote network gateway at:
https://claude-web-egress-bridge.<your-subdomain>.workers.dev

When you need outbound internet data:
- HTTP Request: POST /api/http-request {"url": "<target>"}
- Search: POST /api/search {"query": "<terms>"}
- Scrape: POST /api/fetch {"url": "<target>"}
- Download to R2: GET /api/download?url=<target>
```

---

## 5. Environment Variables & Secrets Reference

| Variable Name | Type | Required? | Description |
| :--- | :--- | :--- | :--- |
| `STORAGE_BUCKET` | R2 Binding | Yes | Cloudflare R2 bucket for persistent file storage |
| `DB` | D1 Binding | Yes | Cloudflare D1 SQL database for project metadata and jobs |
| `DOWNLOAD_QUEUE` | Queue Binding | Optional | Background queue for non-blocking large file transfers |
| `MYBROWSER` | Browser Binding | Optional | Cloudflare Browser Rendering (requires Workers Paid plan) |
| `GEMINI_API_KEY` | Secret | Optional | Enables live Google Search Grounding with citations |
| `AUTH_TOKEN` | Secret | Optional | Bearer token to restrict unauthorized MCP calls |
| `ENVIRONMENT` | Text | Optional | Set to `production` or `development` |

---

## 6. Known Capabilities & Paid Service Requirements

- **Universal Network Gateway (`http_request`)**: 100% free tier compatible.
- **R2 Storage (`download_file`, `storage_list`)**: Free tier includes 10 GB/month storage with 0 egress fees.
- **D1 Database (`projects`, `jobs`, `logs`)**: Free tier includes 5 million read rows/day.
- **Queues**: Free tier includes 1 million operations/month.
- **Browser Rendering (`browser_render`)**: Requires a Cloudflare Workers Paid plan ($5/mo) with Browser Rendering enabled in the dashboard. Static HTML and API scraping (`fetch_webpage`, `http_request`) work 100% on the free tier.
