#!/usr/bin/env node
/**
 * COD Network MCP server — HTTP / Streamable HTTP entrypoint.
 *
 * Exposes the same MCP tools over the Streamable HTTP transport at `/mcp` so
 * URL-based MCP clients (ChatGPT custom connectors, n8n, etc.) can connect.
 *
 * The endpoint is gated by OAuth 2.1 with PKCE + Dynamic Client Registration
 * (this is what ChatGPT requires). The "user" of the OAuth flow is whoever
 * holds the `MCP_AUTH_TOKEN` env var — they paste it into a small login page
 * during the authorize step. As a backdoor for `curl` and Claude Desktop,
 * the static `MCP_AUTH_TOKEN` itself is also accepted as a Bearer token on
 * `/mcp`.
 *
 * Stateless mode: every POST /mcp spins up a fresh server+transport and tears
 * them down when the request closes. This works well for serverless and small
 * VMs and avoids long-lived connection state.
 */

import express from "express";
import type { Request, RequestHandler, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { buildMcpServer, readCodConfig } from "./build-server.js";
import { CodMcpOAuthProvider } from "./oauth.js";

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

async function main(): Promise<void> {
  const cfg = readCodConfig();
  const adminToken = process.env.MCP_AUTH_TOKEN;
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!adminToken) {
    log(
      "ERROR: MCP_AUTH_TOKEN is required. It acts both as the admin Bearer token",
      "and as the password for the OAuth login page. Generate one with:",
      "`openssl rand -base64 32` and set it as a server env var.",
    );
    process.exit(1);
  }

  const issuerUrl = process.env.MCP_PUBLIC_URL
    ? new URL(process.env.MCP_PUBLIC_URL)
    : new URL(`http://${host}:${port}`);
  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  const oauth = new CodMcpOAuthProvider(adminToken);

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "cod-network-mcp",
      transport: "streamable-http",
      mcpEndpoint: mcpResourceUrl.toString(),
      oauthDiscovery: new URL(
        "/.well-known/oauth-authorization-server",
        issuerUrl,
      ).toString(),
      protectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
      docs: "https://github.com/hamoza33/cod-network-mcp",
    });
  });

  // OAuth: discovery, dynamic client registration, /authorize, /token, /revoke.
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl,
      resourceServerUrl: mcpResourceUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "COD Network MCP",
    }),
  );

  // Login form POST.
  app.post("/oauth/approve", oauth.approveHandler);

  // Bearer auth gate for /mcp:
  //   1. If the token equals MCP_AUTH_TOKEN, accept directly (admin / curl mode).
  //   2. Otherwise verify it as an OAuth-issued access token.
  const oauthBearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  });

  const adminOrOauthBearer: RequestHandler = (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && m[1] && oauth.isAdminToken(m[1].trim())) {
      const token = m[1].trim();
      const adminAuth: AuthInfo = {
        token,
        clientId: "admin",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      (req as Request & { auth?: AuthInfo }).auth = adminAuth;
      next();
      return;
    }
    oauthBearer(req, res, next);
  };

  app.post("/mcp", adminOrOauthBearer, async (req, res) => {
    const { server } = buildMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({
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
      log(
        "error handling /mcp:",
        err instanceof Error ? err.stack ?? err.message : String(err),
      );
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
    log(`listening on http://${host}:${port}`);
    log(`OAuth discovery: ${new URL("/.well-known/oauth-authorization-server", issuerUrl).toString()}`);
    log(`MCP endpoint:    ${mcpResourceUrl.toString()}`);
  });
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
