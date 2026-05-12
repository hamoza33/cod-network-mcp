#!/usr/bin/env node
/**
 * COD Network MCP server — stdio entrypoint.
 *
 * Speaks the Model Context Protocol over stdio so any MCP-compatible client
 * (ChatGPT Desktop, Claude Desktop, Cursor, Continue, ...) can query a COD
 * Network seller account. For ChatGPT (web/mobile) custom connectors, use the
 * HTTP entrypoint (`dist/http.js`) instead.
 *
 * Configuration via environment variables (provide either a token, or
 * email + password — the latter auto-refreshes on 401):
 *   COD_NETWORK_API_TOKEN  bearer token from the seller dashboard
 *   COD_NETWORK_EMAIL      seller account email (paired with COD_NETWORK_PASSWORD)
 *   COD_NETWORK_PASSWORD   seller account password
 *   COD_NETWORK_BASE_URL   optional, defaults to https://api.cod.network/v2
 *   COD_NETWORK_TIMEOUT_MS optional positive integer, defaults to 30000
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, readCodConfig } from "./build-server.js";

async function main() {
  const cfg = readCodConfig();
  const { server, toolCount } = buildMcpServer(cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[cod-network-mcp] ready (${toolCount} tools, base=${
      cfg.baseUrl ?? "https://api.cod.network/v2"
    })\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[cod-network-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
