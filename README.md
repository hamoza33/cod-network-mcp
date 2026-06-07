# cod-network-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
your **[COD Network](https://cod.network)** seller account to ChatGPT, Claude
Desktop, Cursor, Continue, and any other MCP-compatible client.

It wraps the documented **Seller API v2** (https://developer.cod.network/v2) so
an LLM can answer questions like:

- "How many orders did I get last week, broken down by country?"
- "Which drop products have less than 50 units of stock?"
- "Show me my unpaid invoices and total amount."
- "What's my current confirmation rate this month vs last month?"

## What's in the box

| Tool                              | Endpoint                              |
| --------------------------------- | ------------------------------------- |
| `cod_list_products`               | `GET /seller/products`                |
| `cod_get_product`                 | `GET /seller/products/{id}`           |
| `cod_get_product_by_sku`          | look up a product by exact SKU        |
| `cod_list_drop_products`          | `GET /seller/drop-products`           |
| `cod_get_drop_product`            | `GET /seller/drop-products/{id}`      |
| `cod_list_stocks`                 | `GET /seller/stocks`                  |
| `cod_list_orders`                 | `GET /seller/orders`                  |
| `cod_get_order`                   | `GET /seller/orders/{id}`             |
| `cod_list_leads`                  | `GET /seller/leads`                   |
| `cod_get_lead`                    | `GET /seller/leads/{id}`              |
| `cod_list_stores`                 | `GET /seller/stores`                  |
| `cod_list_invoices`               | `GET /seller/invoices`                |
| `cod_get_invoice`                 | `GET /seller/invoices/{id}`           |
| `cod_list_source_requests`        | `GET /seller/source-requests`         |
| `cod_summarize_period`            | aggregates orders + leads in one call (includes total quantity) |
| `cod_search_products`             | substring search on name/SKU across products + drop-products |
| `cod_get_product_stats`           | order stats for a specific product (by name or SKU) |
| `cod_get_order_counts`            | quick order counts by status for a date range |
| `cod_get_lead_counts`             | quick lead counts by status for a date range |
| `cod_raw_request`                 | any documented endpoint (escape hatch) |

### Aggregation tools

The COD API hard-caps responses at 10 items per page. All list tools support
`per_page` up to 100 — the tool internally paginates through multiple API pages
to fill each virtual page. For example, `per_page: 100, page: 1` fetches 100
items, then `page: 2` fetches the next 100, etc.
The aggregation tools handle date-range pagination and filtering server-side:

- **`cod_summarize_period({ since, until?, bucket?, group_by_product?, product_query?, include_examples? })`** — returns a compact JSON with totals, **total quantity, average quantity per order**, by-status, by-country, revenue per currency, confirmation/delivery rates. Set `bucket: "day" | "week" | "month"` to also get a `series` array (e.g. one row per day for a 30-day spreadsheet). Set `group_by_product: true` to add `by_product` breakdowns. Set `product_query` to limit the whole summary to rows touching a specific product.
- **`cod_search_products({ query, kind?, limit? })`** — case-insensitive substring search on name/SKU across the seller's owned catalog (`kind: "products"`), the dropshipping catalog (`kind: "drop_products"`), or both. Paginates client-side because the COD `name=` / `q=` filters either don't match or only do exact-match.
- **`cod_get_product_by_sku({ sku })`** — exact SKU lookup across the seller's catalog (and optionally drop-products).
- **`cod_get_product_stats({ product_name?, product_sku?, since?, until? })`** — per-product order stats: total orders, **total quantity delivered**, average quantity per order, revenue, delivery rate, status breakdown.
- **`cod_get_order_counts({ since?, until? })`** — quick order count by status + total quantity for a date range.
- **`cod_get_lead_counts({ since?, until? })`** — quick lead count by status for a date range.

> The docs at developer.cod.network/v2 also list pages for *Confirmed
> Dashboard*, *Delivered Dashboard*, *Statistics*, *Purchases* and
> *Marketplace Products*, but the corresponding REST paths return 404 today.
> Use `cod_raw_request` to call them directly once COD Network publishes the
> exact paths.

All tools support pagination (`page`, `per_page`) and sorting (`sort`, prefix
with `-` for descending). See each tool's input schema for the full set of
parameters.

## Authentication

The **only** way to connect to the COD Network API is via a **bearer token**
(no OAuth, no username/password). You generate it once in the seller dashboard
and pass it as the `COD_NETWORK_API_TOKEN` environment variable.

### How to get your token

1. Log in to [cod.network](https://cod.network) with your seller account.
2. Go to **My profile → API developer → API Token**.
3. Copy the token.

### How to set / update it

Set it as an environment variable before starting the server:

```bash
export COD_NETWORK_API_TOKEN="your-token-here"
```

Or pass it inline when running:

```bash
COD_NETWORK_API_TOKEN="your-token-here" node dist/server.js
```

For MCP client configs (ChatGPT Desktop, Claude Desktop, Cursor, etc.), paste
the token in the `"env"` block — see [Connect it to a client](#connect-it-to-a-client) below.

For hosted deployments (Fly.io, Render, Docker), set it as a server secret /
environment variable — see [Deploy the HTTP server](#deploy-the-http-server).

> **To rotate or update the token**, generate a new one from the same dashboard
> page and replace the old value wherever you set it (env var, MCP config, or
> hosting secret). No code changes are needed.

## Install & run locally

```bash
npm install
npm run build
COD_NETWORK_API_TOKEN=your-token node dist/server.js
```

Or via npx without cloning (once published):

```bash
COD_NETWORK_API_TOKEN=your-token npx cod-network-mcp
```

## Two transports: stdio vs HTTP

The same tools are exposed via two entrypoints:

| Entrypoint        | Transport         | Best for                                                                 |
| ----------------- | ----------------- | ------------------------------------------------------------------------ |
| `dist/server.js`  | stdio             | ChatGPT Desktop, Claude Desktop, Cursor, Continue (local, no hosting)    |
| `dist/http.js`    | Streamable HTTP   | ChatGPT (web/mobile) custom connectors, n8n, anything that wants a URL   |

For the URL-based mode, deploy `dist/http.js` somewhere reachable from the
client and point the client at `https://your-host/mcp`. See
[Deploy the HTTP server](#deploy-the-http-server) below.

## Connect it to a client

### ChatGPT (custom connector via URL)

> ChatGPT's *Settings → Connectors → Add custom connector* requires a URL
> backed by a full **OAuth 2.1** flow (PKCE + Dynamic Client Registration);
> it refuses static-Bearer endpoints. The HTTP entrypoint already implements
> this — you just need to deploy it.

1. Deploy the server (see [Deploy the HTTP server](#deploy-the-http-server)).
   Make sure `MCP_PUBLIC_URL` is set to the public HTTPS origin (e.g.
   `https://cod-network-mcp.fly.dev`) so the OAuth metadata advertises
   `https://` URLs.
2. In ChatGPT, **Settings → Connectors → Add custom connector**:
   - **Server URL**: `https://your-host/mcp`
   - Leave authentication on the default — ChatGPT will discover OAuth from
     `/.well-known/oauth-authorization-server` and walk you through the flow.
3. ChatGPT opens a browser tab with the server's login page; paste your
   `MCP_AUTH_TOKEN` value to grant access. (You can rotate it later with
   `flyctl secrets set MCP_AUTH_TOKEN=$(openssl rand -base64 32)`.)
4. Start a new chat — the `cod_*` tools appear in the tool picker.

For non-ChatGPT clients (`curl`, scripts, Claude Desktop), the static
`MCP_AUTH_TOKEN` is also accepted directly as `Authorization: Bearer …` on
`/mcp`, no OAuth dance required.

### ChatGPT Desktop (stdio)

ChatGPT's desktop app speaks MCP via stdio. Add an entry to your MCP config
(typically `~/Library/Application Support/ChatGPT/mcp.json` on macOS,
`%APPDATA%\ChatGPT\mcp.json` on Windows):

```jsonc
{
  "mcpServers": {
    "cod-network": {
      "command": "npx",
      "args": ["-y", "cod-network-mcp"],
      "env": {
        "COD_NETWORK_API_TOKEN": "paste-your-token-here"
      }
    }
  }
}
```

Restart ChatGPT, open a new conversation, and the COD Network tools will appear
in the tool picker.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "cod-network": {
      "command": "npx",
      "args": ["-y", "cod-network-mcp"],
      "env": {
        "COD_NETWORK_API_TOKEN": "paste-your-token-here"
      }
    }
  }
}
```

Restart Claude Desktop. The tools will be available under the 🔌 menu.

### Cursor

Add to `.cursor/mcp.json` in your home directory or project root:

```jsonc
{
  "mcpServers": {
    "cod-network": {
      "command": "npx",
      "args": ["-y", "cod-network-mcp"],
      "env": { "COD_NETWORK_API_TOKEN": "paste-your-token-here" }
    }
  }
}
```

### Continue / Cline / any other MCP client

Use the same config shape — `command: npx`, `args: ["-y", "cod-network-mcp"]`,
with the auth env vars.

### Running from source instead of npx

Replace the `command`/`args` pair with:

```jsonc
"command": "node",
"args": ["/absolute/path/to/cod-network-mcp/dist/server.js"]
```

## Configuration reference

| Env var                 | Required                     | Description                                                                |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `COD_NETWORK_API_TOKEN` | **yes**                      | Bearer token from the seller dashboard.                                    |
| `COD_NETWORK_BASE_URL`  | no                           | Override base URL. Defaults to `https://api.cod.network/v2`.               |
| `COD_NETWORK_TIMEOUT_MS`| no                           | HTTP timeout in milliseconds. Defaults to `30000`.                         |
| `MCP_AUTH_TOKEN`        | HTTP entrypoint only         | Doubles as: (1) admin Bearer token for `curl` / Claude Desktop, (2) the password the OAuth login page asks for. **Set this in production.** |
| `MCP_PUBLIC_URL`        | HTTP entrypoint only         | Public HTTPS origin (no path), e.g. `https://cod-network-mcp.fly.dev`. Used as the OAuth issuer URL. |
| `PORT`                  | HTTP entrypoint only         | Port to bind. Defaults to `8080`.                                          |
| `HOST`                  | HTTP entrypoint only         | Bind address. Defaults to `0.0.0.0`.                                       |

## Deploy the HTTP server

The HTTP entrypoint (`dist/http.js`) is a standalone Express app on port
`8080`. Any container host works; recipes for the popular ones are below.

### Fly.io

```bash
flyctl launch --no-deploy                # claim the app name
flyctl secrets set \
  COD_NETWORK_API_TOKEN=your-token \
  MCP_AUTH_TOKEN="$(openssl rand -base64 32)" \
  MCP_PUBLIC_URL=https://your-app-name.fly.dev
flyctl deploy
flyctl ssh console -C "printenv MCP_AUTH_TOKEN"   # reveal the value once
```

You'll get a URL like `https://your-app-name.fly.dev/mcp`. Use that as the
**Server URL** in ChatGPT.

### Render.com (no credit card)

Push this repo to GitHub, then Render Dashboard → **New → Blueprint** → point at
the repo. Render reads [`render.yaml`](render.yaml), provisions a Docker web
service on the free plan, generates `MCP_AUTH_TOKEN` automatically, and
prompts you to fill in `COD_NETWORK_API_TOKEN`.

### Any Docker host

```bash
docker build -t cod-network-mcp .
docker run --rm -p 8080:8080 \
  -e COD_NETWORK_API_TOKEN=your-token \
  -e MCP_AUTH_TOKEN="$(openssl rand -base64 32)" \
  cod-network-mcp
```

### Run locally for testing

```bash
npm install && npm run build
PORT=8765 \
  MCP_PUBLIC_URL=http://127.0.0.1:8765 \
  COD_NETWORK_API_TOKEN=your-token \
  MCP_AUTH_TOKEN=dev-token \
  node dist/http.js
# Admin / curl mode:
#   POST http://127.0.0.1:8765/mcp with `Authorization: Bearer dev-token`
# Full OAuth flow (what ChatGPT does):
#   1. POST /register {client_name,redirect_uris:[…],…}
#   2. GET  /authorize?response_type=code&client_id=…&code_challenge=…
#   3. (browser) paste MCP_AUTH_TOKEN into the login page
#   4. POST /token grant_type=authorization_code code=… code_verifier=…
#   5. POST /mcp with `Authorization: Bearer <access_token>`
```

## Development

```bash
npm install
npm run dev          # tsx-watch the server
npm run typecheck    # strict TS check
npm run lint
npm run build        # output to dist/
node scripts/smoke.mjs cod_list_products   # quick local smoke test
```

The smoke script spawns the built server, runs `initialize` + `tools/list`,
then calls one tool by name (default `cod_list_stores`) and prints the result.
It expects `COD_NETWORK_API_TOKEN` in the environment.

## Security

- The server runs locally and only ever talks to `https://api.cod.network/v2`
  (or whatever `COD_NETWORK_BASE_URL` you set).
- Credentials never leave your machine and are never logged.
- The `cod_raw_request` tool is an escape hatch that lets the LLM hit any
  documented path. If you'd rather restrict it, remove it from the registry
  in [`src/tools.ts`](src/tools.ts).

## License

MIT — see [LICENSE](LICENSE).
