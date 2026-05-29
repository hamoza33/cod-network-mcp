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
 * Stateful mode: sessions are tracked via Mcp-Session-Id headers so that
 * multi-request flows (initialize → tools/list → tools/call) work across
 * separate HTTP requests, which is required by ChatGPT and most MCP clients.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import type { Request, RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

/* ------------------------------------------------------------------ */
/*  Session management                                                */
/* ------------------------------------------------------------------ */

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

const sessions = new Map<string, McpSession>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function gcSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) {
      sessions.delete(id);
      void session.transport.close().catch(() => {});
      void session.server.close().catch(() => {});
      log(`session ${id} expired`);
    }
  }
}

const gcTimer = setInterval(gcSessions, 5 * 60 * 1000);
gcTimer.unref(); // don't keep the process alive just for GC

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

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

  /* ---------------------------------------------------------------- */
  /*  MCP endpoint — POST, GET (SSE), DELETE                          */
  /* ---------------------------------------------------------------- */

  const mcpHandler: RequestHandler = async (req, res) => {
    // Check for an existing session.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        session.lastUsed = Date.now();
        try {
          await session.transport.handleRequest(req, res, req.body);
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
        return;
      }
      // Unknown session — for POST we fall through and create a new one if
      // the body is an initialize request (the transport validates this).
      // For GET/DELETE with a stale session, return 404.
      if (req.method !== "POST") {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
    }

    // Only POST can start a new session (must contain an initialize request).
    if (req.method !== "POST") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No active session. Send an initialize request via POST first.",
        },
        id: null,
      });
      return;
    }

    // Spin up a new MCP server + stateful transport for this session.
    const { server } = buildMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId: string) => {
        sessions.set(newId, { server, transport, lastUsed: Date.now() });
        log(`session ${newId} created (active: ${sessions.size})`);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        sessions.delete(id);
        log(`session ${id} closed (active: ${sessions.size})`);
      }
      void server.close().catch(() => {});
    };

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
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    }
  };

  app.post("/mcp", adminOrOauthBearer, mcpHandler);
  app.get("/mcp", adminOrOauthBearer, mcpHandler);
  app.delete("/mcp", adminOrOauthBearer, mcpHandler);

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
