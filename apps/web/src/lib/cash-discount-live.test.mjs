import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";

function harness() {
  let now = 1000;
  const sockets = [];
  const timers = new Map();
  let nextTimer = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1; handlers = new Map(); sent = []; closes = 0;
    constructor() { sockets.push(this); queueMicrotask(() => this.emit("open")); }
    addEventListener(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); }
    emit(name, data) { for (const handler of this.handlers.get(name) || []) handler(data); }
    message(value) { this.emit("message", { data: JSON.stringify(value) }); }
    send(raw) {
      const message = JSON.parse(raw); this.sent.push(message);
      if (message.type === "authenticate") queueMicrotask(() => this.message({ type: "authenticated" }));
    }
    close() { this.closes += 1; this.readyState = 3; this.emit("close"); }
  }
  const exports = {};
  const source = fs.readFileSync(new URL("./cash-discount-live.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, {
    exports, require: () => ({ getApiAccessToken: async () => "token" }),
    WebSocket: Socket, Date: { now: () => now }, crypto: { randomUUID }, URL,
    process: { env: { NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL: "ws://localhost/test" } },
    window: { setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id) => timers.delete(id) },
  });
  return { request: exports.runCashDiscountLiveRequest, sockets, timers, advance: (ms) => { now += ms; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a second request does not replace a two-minute-old socket with pending work", async () => {
  const h = harness();
  const first = h.request({ connectionId: "pc-A", companyName: "A", operation: "scan" });
  await tick();
  h.advance(125_000);
  const second = h.request({ connectionId: "pc-A", companyName: "A", operation: "company_check" });
  await tick();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closes, 0);
  for (const message of h.sockets[0].sent.filter((entry) => entry.type === "request")) {
    h.sockets[0].message({ type: "result", requestId: message.requestId, success: true, data: {} });
  }
  await Promise.all([first, second]);
  assert.equal(h.timers.size, 0);
});

test("aborting a scan relays cancellation and clears its timeout", async () => {
  const h = harness(); const controller = new AbortController();
  const request = h.request({ connectionId: "pc-A", companyName: "A", operation: "scan", signal: controller.signal });
  const rejected = assert.rejects(request, /cancelled/);
  await tick(); controller.abort(new Error("cancelled")); await rejected;
  assert.equal(h.sockets[0].sent.filter((message) => message.type === "cancel").length, 1);
  assert.equal(h.timers.size, 0);
});

test("switching connector cancels reads on the previous socket", async () => {
  const h = harness();
  const first = h.request({ connectionId: "pc-A", companyName: "A", operation: "scan" });
  const rejected = assert.rejects(first, /replaced/);
  await tick();
  const second = h.request({ connectionId: "pc-B", companyName: "B", operation: "company_check" });
  await tick(); await rejected;
  assert.equal(h.sockets[0].sent.at(-1).type, "cancel");
  assert.equal(h.sockets.length, 2);
  const message = h.sockets[1].sent.find((entry) => entry.type === "request");
  h.sockets[1].message({ type: "result", requestId: message.requestId, success: true, data: {} });
  await second;
});
