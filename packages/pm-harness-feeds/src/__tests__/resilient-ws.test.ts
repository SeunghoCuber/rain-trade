import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { ResilientWs, type GapReason } from "../resilient-ws.ts";

const servers: WebSocketServer[] = [];
const clients: ResilientWs[] = [];

afterEach(async () => {
  clients.splice(0).forEach((c) => c.stop());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  await new Promise((r) => wss.on("listening", r));
  const sockets: ServerSocket[] = [];
  const received: string[] = [];
  wss.on("connection", (s) => {
    sockets.push(s);
    s.on("message", (m) => received.push(String(m)));
  });
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, sockets, received };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function client(url: string, over: Partial<ConstructorParameters<typeof ResilientWs>[0]> = {}) {
  const got: string[] = [];
  const gaps: [number, GapReason][] = [];
  const c = new ResilientWs({
    name: "t",
    url,
    silenceMs: 5000,
    backoffMinMs: 20,
    onOpen: (send) => send("SUB"),
    onMessage: (d) => got.push(d),
    onGap: (ms, r) => gaps.push([ms, r]),
    ...over,
  });
  clients.push(c);
  c.start();
  return { c, got, gaps };
}

describe("ResilientWs", () => {
  it("subscribes on open and delivers frames", async () => {
    const s = await server();
    const { got } = client(s.url);
    await until(() => s.received.includes("SUB"));
    s.sockets[0]!.send("hello");
    await until(() => got.includes("hello"));
  });

  it("reconnects and resubscribes after the server drops, reporting one reconnect gap", async () => {
    const s = await server();
    const { c, got, gaps } = client(s.url);
    await until(() => s.sockets.length === 1);
    s.sockets[0]!.send("a");
    await until(() => got.length === 1);
    s.sockets[0]!.terminate();
    await until(() => s.sockets.length === 2 && s.received.filter((m) => m === "SUB").length === 2);
    expect(gaps).toEqual([]); // reported only once data resumes
    s.sockets[1]!.send("b");
    await until(() => got.length === 2);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]![1]).toBe("reconnect");
    expect(c.stats.reconnects).toBe(1);
  });

  it("forces a reconnect on silence and labels the gap as silence", async () => {
    const s = await server();
    const { got, gaps } = client(s.url, { silenceMs: 150 });
    await until(() => s.sockets.length === 1);
    s.sockets[0]!.send("a");
    await until(() => got.length === 1);
    // server stays connected but says nothing
    await until(() => s.sockets.length === 2);
    s.sockets[1]!.send("b");
    await until(() => gaps.length === 1);
    expect(gaps[0]![1]).toBe("silence");
    expect(gaps[0]![0]).toBeGreaterThanOrEqual(150);
  });

  it("gives a fresh connection a full silence window after a long outage (sleep/wake)", async () => {
    const s = await server();
    let now = Date.now();
    const { got, gaps } = client(s.url, { silenceMs: 150, now: () => now });
    await until(() => s.sockets.length === 1);
    s.sockets[0]!.send("a");
    await until(() => got.length === 1);
    now += 60_000; // machine slept for a minute
    await until(() => s.sockets.length === 2); // watchdog drops the dead connection once
    await new Promise((r) => setTimeout(r, 100)); // new connection is quiet, but for < silenceMs
    s.sockets[1]!.send("b");
    await until(() => got.length === 2);
    expect(s.sockets).toHaveLength(2); // not torn down in a loop
    expect(gaps[0]![1]).toBe("silence");
    expect(gaps[0]![0]).toBeGreaterThanOrEqual(60_000);
  });

  it("sends keepalive pings", async () => {
    const s = await server();
    client(s.url, { ping: { payload: "PING", intervalMs: 30 } });
    await until(() => s.received.filter((m) => m === "PING").length >= 2);
  });

  it("stays stopped after stop()", async () => {
    const s = await server();
    const { c } = client(s.url);
    await until(() => s.sockets.length === 1);
    c.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.sockets).toHaveLength(1);
  });
});
