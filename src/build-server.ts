/**
 * Shared MCP server factory used by both the stdio entrypoint
 * (`server.ts`) and the HTTP entrypoint (`http.ts`).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CodApiError, CodClient } from "./client.js";
import { tools } from "./tools.js";

export interface CodConfig {
  token?: string;
  email?: string;
  password?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function readCodConfig(): CodConfig {
  const token = process.env.COD_NETWORK_API_TOKEN;
  const email = process.env.COD_NETWORK_EMAIL;
  const password = process.env.COD_NETWORK_PASSWORD;

  if (!token && !(email && password)) {
    process.stderr.write(
      "[cod-network-mcp] ERROR: no credentials configured.\n" +
        "Set one of:\n" +
        "  - COD_NETWORK_API_TOKEN (from seller dashboard: My profile -> API developer -> API Token)\n" +
        "  - COD_NETWORK_EMAIL + COD_NETWORK_PASSWORD (auto-login + refresh)\n",
    );
    process.exit(1);
  }

  const baseUrl = process.env.COD_NETWORK_BASE_URL;

  let timeoutMs: number | undefined;
  if (process.env.COD_NETWORK_TIMEOUT_MS) {
    const parsed = Number.parseInt(process.env.COD_NETWORK_TIMEOUT_MS, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(
        `[cod-network-mcp] WARN: ignoring invalid COD_NETWORK_TIMEOUT_MS=${JSON.stringify(
          process.env.COD_NETWORK_TIMEOUT_MS,
        )}; expected a positive integer.\n`,
      );
    } else {
      timeoutMs = parsed;
    }
  }

  return { token, email, password, baseUrl, timeoutMs };
}

export function buildMcpServer(cfg: CodConfig): {
  server: Server;
  toolCount: number;
} {
  const client = new CodClient({
    token: cfg.token,
    email: cfg.email,
    password: cfg.password,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
  });

  const server = new Server(
    { name: "cod-network-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: "openApi3" }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
          },
        ],
      };
    }

    try {
      const data = await tool.handler(parsed.data as unknown, client);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof CodApiError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `COD API error (HTTP ${err.status}${
                  err.code ? `, code ${err.code}` : ""
                }): ${err.message}` +
                (err.responseBody
                  ? `\n\nResponse:\n${JSON.stringify(err.responseBody, null, 2)}`
                  : ""),
            },
          ],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Tool ${tool.name} failed: ${msg}` }],
      };
    }
  });

  return { server, toolCount: tools.length };
}
