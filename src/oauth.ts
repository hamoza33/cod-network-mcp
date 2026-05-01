/**
 * Minimal OAuth 2.1 authorization server for the COD Network MCP HTTP
 * endpoint. ChatGPT's custom-connector dialog requires this — it won't
 * accept a static Bearer token.
 *
 * This is a single-tenant deployment, so the "user" is whoever holds
 * `MCP_AUTH_TOKEN`. The login page on `/authorize` asks for that token,
 * and on success we issue a normal OAuth access + refresh token pair
 * back to the client (ChatGPT).
 *
 * Storage is in-memory: if the Fly machine restarts, ChatGPT will
 * re-prompt the user. That's acceptable for this use case.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TTL_SEC = 3600; // 1 hour
const REFRESH_TTL_SEC = 30 * 24 * 3600; // 30 days
const CODE_TTL_SEC = 5 * 60; // 5 minutes
const PENDING_TTL_SEC = 10 * 60; // 10 minutes

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AccessRecord {
  type: "access";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshRecord {
  type: "refresh";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

type TokenRecord = AccessRecord | RefreshRecord;

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(id);
  }

  async registerClient(
    meta: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    this.clients.set(meta.client_id, meta);
    return meta;
  }
}

/**
 * Constant-time string equality that does not leak input length.
 *
 * Hashing both sides to a fixed-size digest first means the buffers passed to
 * `timingSafeEqual` are always the same length, so a length mismatch on the
 * raw inputs is no longer observable from the outside. SHA-256 is collision-
 * resistant for our threat model (an attacker would need a preimage to fake
 * a match, not just a collision against a known token).
 */
function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export class CodMcpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore = new InMemoryClientsStore();

  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, TokenRecord>();

  constructor(private readonly adminToken: string) {}

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    this.gcExpired();

    const pendingId = randomUUID();
    this.pending.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL_SEC * 1000,
    });

    res.set("content-type", "text/html; charset=utf-8");
    res.status(200).send(this.loginPage(pendingId, client));
  }

  approveHandler: RequestHandler = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pendingId = typeof body.pending_id === "string" ? body.pending_id : "";
    const adminToken = typeof body.admin_token === "string" ? body.admin_token : "";

    if (!pendingId || !adminToken) {
      res.status(400).send("Missing pending_id or admin_token");
      return;
    }

    const pending = this.pending.get(pendingId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(pendingId);
      res.status(400).send("Authorization request expired. Please retry from the start.");
      return;
    }

    if (!timingSafeEq(adminToken, this.adminToken)) {
      res.set("content-type", "text/html; charset=utf-8");
      res.status(401).send(
        this.loginPage(pendingId, pending.client, "Incorrect token. Try again."),
      );
      return;
    }

    this.pending.delete(pendingId);

    const code = randomUUID();
    this.codes.set(code, {
      client: pending.client,
      params: pending.params,
      expiresAt: Date.now() + CODE_TTL_SEC * 1000,
    });

    const targetUrl = new URL(pending.params.redirectUri);
    targetUrl.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      targetUrl.searchParams.set("state", pending.params.state);
    }
    res.redirect(targetUrl.toString());
  };

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) throw new InvalidGrantError("Invalid authorization code");
    return rec.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(authorizationCode);
    if (!rec) throw new InvalidGrantError("Invalid authorization code");
    if (rec.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Authorization code expired");
    }
    if (rec.client.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was not issued to this client",
      );
    }
    this.codes.delete(authorizationCode);

    return this.issueTokens(
      client.client_id,
      rec.params.scopes ?? [],
      rec.params.resource,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.tokens.get(refreshToken);
    if (!rec || rec.type !== "refresh" || rec.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (rec.expiresAt < Date.now()) {
      this.tokens.delete(refreshToken);
      throw new InvalidGrantError("Refresh token expired");
    }
    return this.issueTokens(
      client.client_id,
      scopes ?? rec.scopes,
      resource ?? rec.resource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.tokens.get(token);
    if (!rec || rec.type !== "access" || rec.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired token");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: rec.resource,
    };
  }

  /** Allows the static `MCP_AUTH_TOKEN` to act as a service-account bearer. */
  isAdminToken(token: string): boolean {
    return timingSafeEq(token, this.adminToken);
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
  ): OAuthTokens {
    const access = randomUUID();
    const refresh = randomUUID();
    const now = Date.now();
    this.tokens.set(access, {
      type: "access",
      clientId,
      scopes,
      expiresAt: now + ACCESS_TTL_SEC * 1000,
      resource,
    });
    this.tokens.set(refresh, {
      type: "refresh",
      clientId,
      scopes,
      expiresAt: now + REFRESH_TTL_SEC * 1000,
      resource,
    });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SEC,
      scope: scopes.join(" "),
      refresh_token: refresh,
    };
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [id, rec] of this.pending) {
      if (rec.expiresAt < now) this.pending.delete(id);
    }
    for (const [id, rec] of this.codes) {
      if (rec.expiresAt < now) this.codes.delete(id);
    }
    for (const [id, rec] of this.tokens) {
      if (rec.expiresAt < now) this.tokens.delete(id);
    }
  }

  private loginPage(
    pendingId: string,
    client: OAuthClientInformationFull,
    error?: string,
  ): string {
    const clientName = escapeHtml(client.client_name ?? client.client_id);
    const safePendingId = escapeHtml(pendingId);
    const errorBlock = error
      ? `<p class="error">${escapeHtml(error)}</p>`
      : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize cod-network-mcp</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
  @media (prefers-color-scheme: dark) { body { background: #18181b; color: #f4f4f5; } }
  .card { width: min(420px, calc(100vw - 2rem)); padding: 1.75rem 1.75rem 2rem; border-radius: 12px; background: white; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark) { .card { background: #27272a; box-shadow: 0 4px 16px rgba(0,0,0,0.4); } }
  h1 { font-size: 1.15rem; margin: 0 0 0.25rem; }
  p.muted { color: #71717a; margin: 0 0 1.25rem; font-size: 0.9rem; }
  label { display: block; font-size: 0.85rem; margin-bottom: 0.4rem; font-weight: 600; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 0.65rem 0.75rem; border: 1px solid #d4d4d8; border-radius: 8px; font-size: 1rem; background: transparent; color: inherit; }
  @media (prefers-color-scheme: dark) { input[type=password] { border-color: #3f3f46; } }
  button { margin-top: 1rem; width: 100%; padding: 0.7rem; border: 0; border-radius: 8px; background: #0ea5e9; color: white; font-weight: 600; font-size: 1rem; cursor: pointer; }
  button:hover { background: #0284c7; }
  .error { color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.9rem; margin: 0 0 1rem; }
  @media (prefers-color-scheme: dark) { .error { color: #fecaca; background: #450a0a; border-color: #7f1d1d; } }
  .footer { margin-top: 1rem; font-size: 0.8rem; color: #71717a; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <h1>Authorize <code>${clientName}</code></h1>
    <p class="muted">Paste the server's <code>MCP_AUTH_TOKEN</code> to grant access to your COD Network seller data.</p>
    ${errorBlock}
    <form method="post" action="/oauth/approve">
      <input type="hidden" name="pending_id" value="${safePendingId}" />
      <label for="admin_token">Server access token</label>
      <input id="admin_token" type="password" name="admin_token" autocomplete="current-password" autofocus required />
      <button type="submit">Authorize</button>
    </form>
    <p class="footer">cod-network-mcp · <a href="https://github.com/hamoza33/cod-network-mcp">source</a></p>
  </main>
</body>
</html>`;
  }
}
