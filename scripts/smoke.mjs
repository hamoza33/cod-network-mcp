#!/usr/bin/env node
/**
 * Quick smoke test: spawn the built MCP server, list tools, and call a
 * cheap one (cod_list_stores). Prints the result and exits non-zero on error.
 *
 * Run with: node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const server = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, NODE_ENV: "test" },
});

let buf = "";
const responses = new Map();

server.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const pending = responses.get(msg.id);
      if (pending) {
        responses.delete(msg.id);
        pending.resolve(msg);
      }
    } catch (e) {
      console.error("non-JSON line:", line);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    responses.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (responses.has(id)) {
        responses.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 30_000);
  });
}

try {
  // 1. Initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  console.log("initialize:", JSON.stringify(init.result?.serverInfo));

  // 2. List tools
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log(`tools/list: ${names.length} tools`);
  console.log(names.map((n) => "  - " + n).join("\n"));

  // 3. Call a tool that exists in the API
  const arg = process.argv[2] ?? "cod_list_stores";
  const call = await rpc("tools/call", { name: arg, arguments: {} });
  if (call.error) {
    console.error("tools/call error:", call.error);
    process.exit(2);
  }
  const text = call.result?.content?.[0]?.text ?? "";
  console.log(`\ntools/call ${arg} (isError=${!!call.result?.isError}):`);
  console.log(text.slice(0, 1500));
  if (text.length > 1500) console.log(`... (${text.length - 1500} more chars)`);
} finally {
  server.kill();
  await once(server, "exit").catch(() => {});
}
