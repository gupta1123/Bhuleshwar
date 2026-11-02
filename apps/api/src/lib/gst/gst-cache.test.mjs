import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const load = (file) => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
};
const { encryptSecret, decryptSecret } = await load("./secret-box.ts");
const { createSandboxClient, SandboxError, periodParts } = await load("./sandbox-client.ts");
const { getReturn, isFinalReturn, PullBlockedError } = await load("./return-store.ts");

const KEY = Buffer.alloc(32, 7).toString("base64");

test("secrets round-trip and reject tampering or the wrong key", () => {
  const stored = encryptSecret("taxpayer-token", KEY);
  assert.equal(decryptSecret(stored, KEY), "taxpayer-token");
  assert.notEqual(stored, encryptSecret("taxpayer-token", KEY), "each encryption uses a fresh IV");
  assert.throws(() => decryptSecret(stored, Buffer.alloc(32, 8).toString("base64")));
  assert.throws(() => decryptSecret(stored.slice(0, -2) + "xx", KEY));
  assert.throws(() => encryptSecret("x", "short"), /32 bytes/);
});

test("period maps to year and zero-padded month", () => {
  assert.deepEqual(periodParts("2026-09"), { year: "2026", month: "09" });
  assert.throws(() => periodParts("2026-13"));
});

function fakeSandbox(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, method: init.method });
    const out = await handler(u, init);
    return { status: out.status ?? 200, ok: (out.status ?? 200) < 400, json: async () => out.body };
  };
  const client = createSandboxClient({ baseUrl: "https://sandbox.test", apiKey: "k", apiSecret: "s", fetchImpl, now: () => 1_000_000 });
  return { client, calls };
}

const session = (over = {}) => ({ token: "tok", sessionExpiry: 10_000_000_000, tokenExpiry: 10_000_000_000, ...over });

test("a token with time left is reused; a lapsing one is refreshed without an OTP", async () => {
  const { client, calls } = fakeSandbox(() => ({ body: { data: { access_token: "new", session_expiry: 9e9, token_expiry: 8e9 } } }));
  const same = await client.ensureSession(session());
  assert.equal(same.refreshed, false);
  assert.equal(calls.length, 0);
  const next = await client.ensureSession(session({ tokenExpiry: 1_000_000 + 60_000 }));
  assert.equal(next.refreshed, true);
  assert.equal(next.session.token, "new");
  assert.equal(calls[0].path, "/gst/compliance/tax-payer/session/refresh");
  assert.equal(calls[0].headers.authorization, "tok");
  await assert.rejects(client.ensureSession(session({ sessionExpiry: 999_999 })), (e) => e instanceof SandboxError && e.kind === "session");
});

test("GSTR-2A pulls one call per section and merges them", async () => {
  const { client, calls } = fakeSandbox((u) => ({
    body: { data: { status_cd: "1", data: u.pathname.includes("/b2b/") ? { b2b: [{ ctin: "A" }] } : { cdn: [{ ctin: "B" }] } }, transaction_id: "t" },
  }));
  const out = await client.getGstr2a(session(), "2026-09", ["b2b", "cdn"]);
  assert.equal(out.calls, 2);
  assert.deepEqual(out.payload.data.data, { b2b: [{ ctin: "A" }], cdn: [{ ctin: "B" }] });
  assert.deepEqual(calls.map((c) => c.path), [
    "/gst/compliance/tax-payer/gstrs/gstr-2a/b2b/2026/09",
    "/gst/compliance/tax-payer/gstrs/gstr-2a/cdn/2026/09",
  ]);
  assert.equal(calls[0].headers["x-source"], "primary");
});

test("a multi-file GSTR-2B is fetched file by file and merged", async () => {
  const { client, calls } = fakeSandbox((u) => {
    const file = u.searchParams.get("file_number");
    if (!file) return { body: { data: { status_cd: "3", data: { fc: 2 } }, transaction_id: "t" } };
    return { body: { data: { status_cd: "1", data: { docdata: { b2b: [{ ctin: `F${file}` }] } } } } };
  });
  const out = await client.getGstr2b(session(), "2026-09");
  assert.equal(out.calls, 3);
  assert.deepEqual(out.payload.data.data.docdata.b2b, [{ ctin: "F1" }, { ctin: "F2" }]);
  assert.deepEqual(calls.slice(1).map((c) => c.query.file_number), ["1", "2"]);
});

test("portal and session errors are classified", async () => {
  const portal = fakeSandbox(() => ({ body: { data: { status_cd: "0", error: { error_cd: "RET13508", message: "Not generated" } } } }));
  await assert.rejects(portal.client.getGstr3b(session(), "2026-09"), (e) => e.kind === "portal" && e.errorCode === "RET13508");
  const expired = fakeSandbox(() => ({ body: { data: { error: { error_cd: "AUTH4033", message: "Invalid Session" } } } }));
  await assert.rejects(expired.client.getGstr2b(session(), "2026-09"), (e) => e.kind === "session");
  const limited = fakeSandbox(() => ({ status: 429, body: {} }));
  await assert.rejects(limited.client.getGstr2b(session(), "2026-09"), (e) => e.kind === "rate_limit");
});

function memoryStore(initial = []) {
  const rows = new Map(initial);
  const log = [];
  return {
    rows, log,
    readSnapshot: async (key) => rows.get(`${key.gstin}|${key.returnType}|${key.period}`) ?? null,
    saveSnapshot: async (key, row) => { rows.set(`${key.gstin}|${key.returnType}|${key.period}`, row); },
    countCallsSince: async () => log.filter((entry) => entry.ok).length,
    logCalls: async (entries) => { log.push(...entries); },
  };
}

const KEY_2B = { organizationId: "org", gstin: "27AAAAA0000A1Z5", returnType: "gstr2b", period: "2026-09" };
const NOW = Date.parse("2026-11-02T08:00:00Z");

test("first load calls the portal once; every later load is free", async () => {
  const store = memoryStore();
  let portalCalls = 0;
  const fetchFromPortal = async () => { portalCalls += 1; return { payload: { x: 1 }, transactionId: "t1", calls: 1 }; };
  const deps = { store, fetchFromPortal, now: () => NOW };
  const first = await getReturn(deps, KEY_2B);
  assert.equal(first.source, "portal");
  for (let i = 0; i < 5; i += 1) assert.equal((await getReturn(deps, KEY_2B)).source, "cache");
  assert.equal(portalCalls, 1);
  assert.equal(store.log.length, 1);
  assert.equal(first.snapshot.isFinal, true, "September 2B is final in November");
});

test("refresh waits out the minimum gap, then counts a second fetch", async () => {
  const store = memoryStore();
  let clock = NOW;
  const deps = { store, fetchFromPortal: async () => ({ payload: {}, transactionId: "t", calls: 1 }), now: () => clock };
  await getReturn(deps, KEY_2B);
  clock += 10 * 60_000;
  await assert.rejects(getReturn(deps, KEY_2B, { refresh: true }), (e) => e instanceof PullBlockedError && e.kind === "refresh_too_soon");
  clock += 60 * 60_000;
  const again = await getReturn(deps, KEY_2B, { refresh: true });
  assert.equal(again.source, "portal");
  assert.equal(again.snapshot.fetchCount, 2);
});

test("the daily cap blocks a pull before the portal is touched", async () => {
  const store = memoryStore();
  for (let i = 0; i < 9; i += 1) store.log.push({ ok: true });
  let touched = false;
  const deps = { store, fetchFromPortal: async () => { touched = true; return { payload: {}, transactionId: "", calls: 1 }; }, now: () => NOW };
  await assert.rejects(
    getReturn(deps, { ...KEY_2B, returnType: "gstr2a" }, { policy: { dailyCap: 10, minRefreshMinutes: 60 } }),
    (e) => e instanceof PullBlockedError && e.kind === "daily_cap",
  );
  assert.equal(touched, false);
});

test("a failed pull is logged, saves nothing, and is retried next time", async () => {
  const store = memoryStore();
  const deps = { store, fetchFromPortal: async () => { throw new SandboxError("Not generated", "portal", 200, "RET13508", "tx9"); }, now: () => NOW };
  await assert.rejects(getReturn(deps, KEY_2B), /Not generated/);
  assert.equal(store.rows.size, 0);
  assert.deepEqual(store.log.map((l) => [l.ok, l.transactionId]), [[false, "tx9"]]);
});

test("finality: 2A is never final, 2B after the 15th of the next month, 3B after the month", () => {
  assert.equal(isFinalReturn("gstr2a", "2020-01", NOW), false);
  assert.equal(isFinalReturn("gstr2b", "2026-10", NOW), false);
  assert.equal(isFinalReturn("gstr2b", "2026-09", NOW), true);
  assert.equal(isFinalReturn("gstr3b", "2026-10", NOW), true);
  assert.equal(isFinalReturn("gstr3b", "2026-11", NOW), false);
});
