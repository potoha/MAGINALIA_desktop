/**
 * Product Host self-check runner (design 3.5/4.3, WP-5b). Spawns the placed Host exactly as
 * Chrome would (the allowed origin as the first command-line argument), sends one `health`
 * frame, and parses the length-prefixed answer. 10 s timeout, then the child is killed.
 *
 * It takes the executable path and origin from the apply module and reads no environment itself.
 * The child runs with a CLEAN environment (`buildCleanHostEnvironment`, an allowlist; the
 * composition root passes the process environment to it) and with its working directory set to the folder
 * of the executable, never the app's cwd or an inherited `PATH`. The spawn function is injectable
 * so the framing and the spawn options are tested without a real child.
 */
import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { COLLECTOR_PROTOCOL } from "./collector-payload.js";
import type { HostSelfCheckRequest, HostSelfCheckResult } from "./collector-integration-apply-types.js";

export const HOST_SELF_CHECK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The slice of a child process the runner uses (a fake in tests). */
export interface HostChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  on(event: "error" | "close", listener: () => void): unknown;
  kill(): unknown;
}

export interface HostSpawnOptions {
  /** The folder of the executable. */
  readonly cwd: string;
  /** The complete child environment (nothing is inherited). */
  readonly env: Readonly<Record<string, string>>;
}

export type HostSpawn = (executable: string, args: readonly string[], options: HostSpawnOptions) => HostChild;

const defaultSpawn: HostSpawn = (executable, args, options) => nodeSpawn(executable, [...args], {
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
  shell: false,
  cwd: options.cwd,
  env: { ...options.env },
}) as unknown as HostChild;

/** Variables the Host needs from the user session (it resolves the integration folder and temp files). */
const HOST_ENVIRONMENT_ALLOWLIST: readonly string[] = Object.freeze(["SystemRoot", "SystemDrive", "windir", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN", "TEMP", "TMP"]);

/**
 * Allowlist copy of an environment: names are matched case-insensitively (Windows), `PATH` is
 * replaced by the system directory only, and everything else (proxies, `NODE_OPTIONS`, tokens,
 * loader overrides) is dropped. Pure: the caller supplies the source environment.
 */
export function buildCleanHostEnvironment(source: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const folded = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) if (typeof value === "string") folded.set(name.toLowerCase(), value);
  const clean: Record<string, string> = {};
  for (const name of HOST_ENVIRONMENT_ALLOWLIST) {
    const value = folded.get(name.toLowerCase());
    if (value !== undefined && value.length > 0 && !value.includes("\u0000")) clean[name] = value;
  }
  const systemRoot = clean.SystemRoot;
  if (systemRoot !== undefined) clean.PATH = path.win32.join(systemRoot, "System32");
  return Object.freeze(clean);
}

export function encodeHealthFrame(): Buffer {
  const body = Buffer.from(JSON.stringify({ protocol: COLLECTOR_PROTOCOL, operation: "health" }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Parses one complete frame from the front of `data`; `undefined` while incomplete, `null` when invalid. */
export function parseHealthFrame(data: Buffer): HostSelfCheckResult | undefined | null {
  if (data.length < 4) return undefined;
  const size = data.readUInt32LE(0);
  if (size === 0 || size > MAX_RESPONSE_BYTES) return null;
  if (data.length < 4 + size) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(4, 4 + size)));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.protocol !== "string") return null;
  const host = record.host;
  const hostVersion = host !== null && typeof host === "object" && typeof (host as { version?: unknown }).version === "string"
    ? (host as { version: string }).version
    : undefined;
  return Object.freeze(hostVersion === undefined
    ? { status: "ok" as const, protocol: record.protocol }
    : { status: "ok" as const, protocol: record.protocol, hostVersion });
}

export function createNodeHostSelfCheckRunner(options: {
  readonly spawn?: HostSpawn;
  readonly timeoutMs?: number;
  /** Child environment: `buildCleanHostEnvironment(...)` of the process environment, built by the composition root. Required: an empty environment makes the Host fail every check. */
  readonly environment: Readonly<Record<string, string>>;
}): (request: HostSelfCheckRequest) => Promise<HostSelfCheckResult> {
  const spawnHost = options.spawn ?? defaultSpawn;
  const environment = options.environment;
  const timeoutMs = options.timeoutMs ?? HOST_SELF_CHECK_TIMEOUT_MS;
  return (request) => new Promise<HostSelfCheckResult>((resolve) => {
    let settled = false;
    let child: HostChild | undefined;
    const timer = setTimeout(() => finish({ status: "failed" }), timeoutMs);
    const finish = (value: HostSelfCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.stdin.end();
        child?.kill();
      } catch {
        // the child may already be gone
      }
      resolve(value);
    };
    try {
      child = spawnHost(request.executablePath, [request.allowedOrigin], { cwd: path.win32.dirname(request.executablePath), env: environment });
    } catch {
      finish({ status: "failed" });
      return;
    }
    let received = Buffer.alloc(0);
    child.on("error", () => finish({ status: "failed" }));
    // `close` follows every `data` event: a close before a complete answer is a failure.
    child.on("close", () => finish({ status: "failed" }));
    child.stdin.on("error", () => finish({ status: "failed" }));
    child.stdout.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES + 4) {
        finish({ status: "failed" });
        return;
      }
      const parsed = parseHealthFrame(received);
      if (parsed === undefined) return;
      finish(parsed ?? { status: "failed" });
    });
    try {
      child.stdin.write(encodeHealthFrame());
    } catch {
      finish({ status: "failed" });
    }
  });
}
