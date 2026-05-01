#!/usr/bin/env node
/**
 * COD Network MCP server — HTTP / Streamable HTTP entrypoint.
 *
 * Exposes the same MCP tools over the Streamable HTTP transport at `/mcp` so
 * URL-based MCP clients (ChatGPT custom connectors, n8n, etc.) can connect.
 *
 * Stateless mode: every POST /mcp spins up a fresh server+transport and tears
 * them down when the request closes. This works well for serverless and small
 * VMs and avoids long-lived connection state.
 *
 * Configuration via environment variables (see `server.ts` for the COD ones):
 *   PORT             optional, defaults to 8080
 *   HOST             optional, defaults to 0.0.0.0
 *   MCP_AUTH_TOKEN   optional bearer token. If set, every request to /mcp
 *                    must include `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 *                    Strongly recommended for any deployment exposed to
 *                    the public internet.
 */

import express from "express";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, readCodConfig } from "./build-server.js";

const log = (...args: unknown[]): void => {
  process.stderr.write(`[cod-network-mcp:http] ${args.join(" ")}\n`);
};

function methodNotAllowed(res: Response): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
}

function unauthorized(res: Response, reason: string): void {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="cod-network-mcp"',
  }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: `Unauthorized: ${reason}` },
      id: null,
    }),
  );
}

function timingSafeEq(a: string, b: string): boolean {
  // Simple constant-time comparison without exposing the lengths.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function checkAuth(req: Request, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !m[1]) return false;
  return timingSafeEq(m[1].trim(), expected);
}

async function main(): Promise<void> {
  const cfg = readCodConfig();
  const authToken = process.env.MCP_AUTH_TOKEN;
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!authToken) {
    log(
      "WARN: MCP_AUTH_TOKEN is not set. The /mcp endpoint is unauthenticated;",
      "anyone who can reach it will be able to query your COD Network seller account.",
    );
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "cod-network-mcp",
      transport: "streamable-http",
      mcpEndpoint: "/mcp",
      docs: "https://github.com/hamoza33/cod-network-mcp",
    });
  });

  app.post("/mcp", async (req, res) => {
    if (!checkAuth(req, authToken)) {
      unauthorized(res, "missing or invalid Bearer token");
      return;
    }

    const { server } = buildMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id, every request stands alone.
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error handling /mcp:", err instanceof Error ? err.stack ?? err.message : String(err));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET / DELETE on /mcp are not used in stateless mode.
  app.get("/mcp", (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", (_req, res) => methodNotAllowed(res));

  app.listen(port, host, () => {
    log(`listening on http://${host}:${port}/mcp (auth=${authToken ? "on" : "off"})`);
  });
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
