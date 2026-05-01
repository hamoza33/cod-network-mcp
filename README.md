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
| `cod_raw_request`                 | any documented endpoint (escape hatch) |

> The docs at developer.cod.network/v2 also list pages for *Confirmed
> Dashboard*, *Delivered Dashboard*, *Statistics*, *Purchases* and
> *Marketplace Products*, but the corresponding REST paths return 404 today.
> Use `cod_raw_request` to call them directly once COD Network publishes the
> exact paths.

All tools support pagination (`page`, `per_page`) and sorting (`sort`, prefix
with `-` for descending). See each tool's input schema for the full set of
parameters.

## Authentication

Provide **one** of these:

1. **Static API token** — set `COD_NETWORK_API_TOKEN`. Get it from the seller
   dashboard: **My profile → API developer → API Token**.
2. **Auto-login (recommended for long-running servers)** — set
   `COD_NETWORK_EMAIL` + `COD_NETWORK_PASSWORD`. The server calls
   `POST /seller/login` on first use and refreshes the token automatically when
   the API returns `401 expired_token`.

If both are set, the static token is tried first and email/password is used as
a fallback on expiry.

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

## Connect it to a client

### ChatGPT (Desktop)

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
        "COD_NETWORK_EMAIL": "you@example.com",
        "COD_NETWORK_PASSWORD": "your-password"
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
| `COD_NETWORK_API_TOKEN` | one of token / email+pw      | Bearer token from the seller dashboard.                                    |
| `COD_NETWORK_EMAIL`     | one of token / email+pw      | Seller account email (used with `COD_NETWORK_PASSWORD` for auto-login).    |
| `COD_NETWORK_PASSWORD`  | one of token / email+pw      | Seller account password.                                                   |
| `COD_NETWORK_BASE_URL`  | no                           | Override base URL. Defaults to `https://api.cod.network/v2`.               |
| `COD_NETWORK_TIMEOUT_MS`| no                           | HTTP timeout in milliseconds. Defaults to `30000`.                         |

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
It expects `COD_NETWORK_API_TOKEN` (or email/password) in the environment.

## Security

- The server runs locally and only ever talks to `https://api.cod.network/v2`
  (or whatever `COD_NETWORK_BASE_URL` you set).
- Credentials never leave your machine and are never logged.
- The `cod_raw_request` tool is an escape hatch that lets the LLM hit any
  documented path. If you'd rather restrict it, remove it from the registry
  in [`src/tools.ts`](src/tools.ts).

## License

MIT — see [LICENSE](LICENSE).
