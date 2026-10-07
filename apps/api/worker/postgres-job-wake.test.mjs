import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionPoolerUrl,
  createCoalescingWakeSignal,
  notificationTargetsWorker,
} from "./postgres-job-wake.mjs";

test("wake signal interrupts an active polling wait", async () => {
  const signal = createCoalescingWakeSignal();
  const waiting = signal.wait(1000);
  signal.notify();
  assert.equal(await waiting, "notify");
});

test("wake signals received while busy coalesce", async () => {
  const signal = createCoalescingWakeSignal();
  signal.notify();
  signal.notify();
  assert.equal(await signal.wait(1000), "notify");
});

test("notification payloads are filtered by worker pool", () => {
  assert.equal(notificationTargetsWorker('{"workerPool":"local"}', "local"), true);
  assert.equal(notificationTargetsWorker('{"workerPool":"remote"}', "local"), false);
  assert.equal(notificationTargetsWorker("", "local"), true);
});

test("session pooler URL reuses credentials without exposing them", () => {
  const result = new URL(
    buildSessionPoolerUrl({
      directUrl: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require",
      projectRef: "example",
      poolerHost: "aws-0-region.pooler.supabase.com",
    })
  );
  assert.equal(result.hostname, "aws-0-region.pooler.supabase.com");
  assert.equal(result.username, "postgres.example");
  assert.equal(result.password, "secret");
  assert.equal(result.searchParams.get("sslmode"), "require");
  assert.equal(result.searchParams.get("uselibpqcompat"), "true");
});

