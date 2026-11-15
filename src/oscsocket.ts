/**
 * Is the console's OSC input socket really bound? (bench 2026-11-15)
 *
 * At the migration bench, gma3_osc read EnableInput on and a line with Receive Command on port 8000, yet nothing was
 * bound on UDP 8000 (`lsof` showed nothing) and gma3_test_osc_input failed. Switching input off and on bound the port
 * again. The settings alone cannot show that state, so this looks at the machine's sockets.
 *
 * Method: one `lsof +c 0 -nP -w -F pcPn -iUDP -iTCP:<bridgePort> -sTCP:LISTEN` call, async, with a timeout.
 *   - The anchor is the process listening on the bridge's TCP port: that is the console (the bridge plugin runs inside
 *     it), and seeing it proves that lsof can see the console's sockets. Its command must look like grandMA3; a
 *     forwarder (an ssh tunnel to a remote console) is not taken for it.
 *   - "not listening" is said only when the anchor is seen and that same process holds no UDP socket on the port.
 *     Anything else (bridge host not on this machine, lsof missing, not permitted, timed out, anchor not visible)
 *     is "not_checked" with the reason: never "not listening".
 *   - lsof exits 1 when one selection matched nothing even though it printed others: the output decides, not the code.
 */
import { execFile } from "node:child_process";
import os from "node:os";

export interface SocketRow {
  pid: number;
  command: string;
  proto: string;
  /** Local side of the name (before any "->"), e.g. "*:8000" or "127.0.0.1:9800". */
  local: string;
  port: number | null;
}

export interface PortCheck {
  port: number;
  lines: number[];
  status: "listening" | "not_listening" | "held_by_other";
  /** Other processes bound on this UDP port. */
  others?: Array<{ pid: number; command: string; local: string }>;
}

export interface OscSocketCheck {
  /** Worst over the ports: not_listening, then held_by_other, then listening. not_checked: no verdict. */
  status: "listening" | "not_listening" | "held_by_other" | "not_checked";
  method: string;
  reason?: string;
  console?: { pid: number; command: string; bridgeListener: string; udpPorts: number[] };
  ports: PortCheck[];
  /** The lsof rows the verdict rests on (console's UDP sockets, other holders of the ports, the bridge listener). */
  evidence?: string[];
}

/** ports: UDP port -> the OSC lines on it. */
export type OscSocketChecker = (ports: Map<number, number[]>) => Promise<OscSocketCheck>;

export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const CONSOLE_COMMAND = /gma3|grandma/i;
const LSOF_CANDIDATES = ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"];
export const LSOF_TIMEOUT_MS = 2000;

/** Parses `lsof -F pcPn` output (one field per line: p pid, c command, f fd, P protocol, n name). */
export function parseLsof(out: string): SocketRow[] {
  const rows: SocketRow[] = [];
  let pid = 0;
  let command = "";
  let proto = "";
  for (const line of out.split(/\r?\n/)) {
    const k = line[0];
    const v = line.slice(1);
    if (k === "p") {
      pid = Number(v);
      command = "";
    } else if (k === "c") command = v;
    else if (k === "f") proto = "";
    else if (k === "P") proto = v;
    else if (k === "n") {
      const local = v.split("->")[0];
      const m = local.match(/:(\d+)$/);
      rows.push({ pid, command, proto, local, port: m ? Number(m[1]) : null });
    }
  }
  return rows;
}

const fmt = (r: SocketRow) => `${r.command} ${r.pid} ${r.proto} ${r.local}`;

/** The verdict from lsof's rows. */
export function judgeSockets(rows: SocketRow[], bridgePort: number, ports: Map<number, number[]>, method: string): OscSocketCheck {
  const anchors = rows.filter((r) => r.proto === "TCP" && r.port === bridgePort);
  const portList = [...ports.keys()];
  const skip = (reason: string): OscSocketCheck => ({ status: "not_checked", method, reason, ports: [], ...(anchors.length ? { evidence: anchors.map(fmt) } : {}) });
  if (!anchors.length) return skip(`lsof shows no process listening on the bridge port TCP ${bridgePort}, so the console's sockets are not visible from here (another user, missing permission, or the console runs elsewhere)`);
  const anchor = anchors.find((r) => CONSOLE_COMMAND.test(r.command));
  if (!anchor) return skip(`the bridge port TCP ${bridgePort} is held by ${anchors.map((r) => `${r.command} (pid ${r.pid})`).join(", ")}, not by grandMA3: a forwarder or tunnel, so the console is not on this machine`);
  const udp = rows.filter((r) => r.proto === "UDP");
  const mine = udp.filter((r) => r.pid === anchor.pid);
  const checks: PortCheck[] = portList.map((port) => {
    const held = mine.some((r) => r.port === port);
    const others = udp.filter((r) => r.pid !== anchor.pid && r.port === port).map((r) => ({ pid: r.pid, command: r.command, local: r.local }));
    return { port, lines: ports.get(port) ?? [], status: held ? "listening" : others.length ? "held_by_other" : "not_listening", ...(others.length ? { others } : {}) };
  });
  const status = checks.some((c) => c.status === "not_listening") ? "not_listening" : checks.some((c) => c.status === "held_by_other") ? "held_by_other" : "listening";
  return {
    status,
    method,
    console: { pid: anchor.pid, command: anchor.command, bridgeListener: anchor.local, udpPorts: [...new Set(mine.map((r) => r.port).filter((p): p is number => p !== null))].sort((a, b) => a - b) },
    ports: checks,
    evidence: [fmt(anchor), ...udp.filter((r) => r.port !== null && portList.includes(r.port)).map(fmt)],
  };
}

const isLoopbackHost = (h: string) => /^127\./.test(h) || h === "localhost" || h === "::1" || h === "[::1]";

function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address);
  return out;
}

const defaultRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when a selection matched nothing, even with other output: keep the output.
      if (err && (err as { code?: unknown }).code === 1 && !(err as { killed?: boolean }).killed) return resolve(stdout ?? "");
      if (err) return reject(err);
      resolve(stdout);
    });
  });

export interface CheckerOptions {
  bridgeHost: string;
  bridgePort: number;
  run?: Runner;
  platform?: NodeJS.Platform;
  local?: () => Set<string>;
  timeoutMs?: number;
}

export function createOscSocketChecker(o: CheckerOptions): OscSocketChecker {
  const run = o.run ?? defaultRunner;
  const platform = o.platform ?? process.platform;
  const timeoutMs = o.timeoutMs ?? LSOF_TIMEOUT_MS;
  const args = ["+c", "0", "-nP", "-w", "-F", "pcPn", "-iUDP", `-iTCP:${o.bridgePort}`, "-sTCP:LISTEN"];
  const method = `lsof ${args.join(" ")} (timeout ${timeoutMs} ms)`;
  return async (ports) => {
    const skip = (reason: string): OscSocketCheck => ({ status: "not_checked", method, reason, ports: [] });
    const host = o.bridgeHost.trim();
    if (!isLoopbackHost(host) && !(o.local ?? localAddresses)().has(host)) return skip(`the bridge host ${host} is not an address of this machine: the console runs on another host, so its sockets cannot be checked from here`);
    if (platform === "win32") return skip("the socket check uses lsof (macOS, Linux); it is not done on Windows");
    if (!ports.size) return skip("no line receives, so no port is expected to be bound");
    let out: string | undefined;
    let lastErr: unknown;
    for (const file of LSOF_CANDIDATES) {
      try {
        out = await run(file, args, timeoutMs);
        break;
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") break;
      }
    }
    if (out === undefined) {
      const e = lastErr as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (e?.code === "ENOENT") return skip("lsof was not found (looked in PATH, /usr/sbin, /usr/bin)");
      if (e?.code === "EACCES" || e?.code === "EPERM") return skip(`lsof is not permitted here (${e.code})`);
      if (e?.killed || e?.signal) return skip(`lsof did not answer within ${timeoutMs} ms`);
      return skip(`lsof failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return judgeSockets(parseLsof(out), o.bridgePort, ports, method);
  };
}

/** The ports to check: every line with Receive or Receive Command, when input is on. */
export function receivingPorts(s: { enableInput?: boolean | null; lines: Array<{ index: number; port?: number | null; receive?: boolean | null; receiveCommand?: boolean | null }> }, only?: number[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  if (s.enableInput !== true) return m;
  for (const l of s.lines) {
    if (typeof l.port !== "number" || !(l.receive === true || l.receiveCommand === true)) continue;
    if (only && !only.includes(l.index)) continue;
    m.set(l.port, [...(m.get(l.port) ?? []), l.index]);
  }
  return m;
}
