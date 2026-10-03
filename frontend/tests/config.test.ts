/* =============================================================================
   Proxy and WebSocket configuration
   -----------------------------------------------------------------------------
   The browser only ever calls this app's own origin; `next.config.ts` is what
   re-roots those paths onto the backend. If the two disagree, or if the target is
   wrong, every request lands on something that is not AgentWebEinh while the UI
   still claims to be connected.

   `config.ts` reads `process.env` at module load, so each environment is loaded in
   a fresh process rather than by mutating this one.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const FRONTEND_DIR = path.resolve(import.meta.dirname, "..");

interface Probe {
  mode: string;
  apiUrl: string;
  apiWsUrl: string;
  wsProxyPrefix: string;
}

/** Load `config.ts` in a child process with an exact environment. */
function loadConfig(env: Record<string, string>): Probe {
  const script = [
    'const m = await import("./src/lib/config.ts");',
    "process.stdout.write(JSON.stringify({",
    "  mode: m.API_CONFIG.mode,",
    '  apiUrl: m.apiUrl("/api/stats"),',
    '  apiWsUrl: m.apiWsUrl("/api/tasks/01ABC/ws"),',
    "  wsProxyPrefix: m.WS_PROXY_PREFIX,",
    "}));",
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--import", "./tests/register.mjs", "--input-type=module", "--eval", script],
    {
      cwd: FRONTEND_DIR,
      // A clean env: no inherited NEXT_PUBLIC_* from the developer shell.
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(`config probe failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Probe;
}

test("default config proxies REST and WebSocket through this app", () => {
  const probe = loadConfig({});

  // Same-origin REST: the Next.js rewrite owns the backend origin.
  assert.equal(probe.apiUrl, "/api/backend/api/stats");
  // The WS path must be re-rooted onto /ws/backend, or it matches no rewrite and
  // 404s at the Next.js server while REST keeps working.
  assert.equal(probe.wsProxyPrefix, "/ws/backend");
  assert.equal(
    probe.apiWsUrl,
    "ws://127.0.0.1:3000/ws/backend/api/tasks/01ABC/ws",
  );
});

test("an explicit WebSocket URL is appended unchanged", () => {
  // NEXT_PUBLIC_WS_URL points straight at the backend, which owns its own layout.
  const probe = loadConfig({ NEXT_PUBLIC_WS_URL: "wss://api.example.com" });
  assert.equal(probe.apiWsUrl, "wss://api.example.com/api/tasks/01ABC/ws");
});

test("an explicit REST base URL bypasses the proxy", () => {
  const probe = loadConfig({ NEXT_PUBLIC_API_BASE_URL: "https://api.example.com/" });
  // Trailing slashes are stripped so callers never emit a double slash.
  assert.equal(probe.apiUrl, "https://api.example.com/api/stats");
});

test("mode is read from the environment and defaults to auto", () => {
  assert.equal(loadConfig({}).mode, "auto");
  assert.equal(loadConfig({ NEXT_PUBLIC_API_MODE: "live" }).mode, "live");
  assert.equal(loadConfig({ NEXT_PUBLIC_API_MODE: "demo" }).mode, "demo");
  // Anything unrecognised must not silently become live.
  assert.equal(loadConfig({ NEXT_PUBLIC_API_MODE: "production" }).mode, "auto");
});

test("the proxy target is 8001 everywhere, never 8000", () => {
  const config = readFileSync(path.join(FRONTEND_DIR, "next.config.ts"), "utf8");
  const env = readFileSync(path.join(FRONTEND_DIR, ".env.local"), "utf8");

  // The fallback exists for running without .env.local; if it says 8000 the app
  // silently talks to whatever unrelated service holds that port.
  assert.match(
    config,
    /DEFAULT_PROXY_TARGET = "http:\/\/127\.0\.0\.1:8001"/,
    "next.config.ts fallback target must be 8001",
  );
  assert.doesNotMatch(
    config,
    /127\.0\.0\.1:8000/,
    "next.config.ts must not reference port 8000",
  );

  const target = /NEXT_PUBLIC_API_PROXY_TARGET=(.+)/.exec(env)?.[1]?.trim();
  assert.equal(target, "http://127.0.0.1:8001", ".env.local proxy target must be 8001");
});

test("both rewrite rules share one target", () => {
  const config = readFileSync(path.join(FRONTEND_DIR, "next.config.ts"), "utf8");
  // A REST/WS split here is a silent failure: the UI connects, the stream does not.
  assert.match(config, /source: "\/api\/backend\/:path\*"[\s\S]*destination: `\$\{proxyTarget\(\)\}/);
  assert.match(config, /source: "\/ws\/backend\/:path\*"[\s\S]*destination: `\$\{proxyTarget\(\)\}/);
});