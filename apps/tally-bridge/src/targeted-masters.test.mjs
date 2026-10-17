import test from "node:test";
import assert from "node:assert/strict";
import { buildTargetedMastersXml } from "./targeted-masters.mjs";
import { exportNamedCashDiscountMasters, exportCashDiscountAncestorGroups, selectCashDiscountLedgers } from "./bridge.mjs";

test("direct master lookup never creates a full ledger/group collection", () => {
  for (const type of ["Ledger", "Group"]) {
    const text = buildTargetedMastersXml({ companyName: "Company & Co", names: ['A & B', 'C "D"'], type });
    assert.doesNotMatch(text, /<TYPE>(Ledger|Group)<\/TYPE>|<FILTER>/);
    assert.match(text, /Company &amp; Co/);
    assert.match(text, /\$\$Chr:34/);
    assert.match(text, /KalikaMasterSeed1,KalikaMasterSeed2/);
    if (type === "Ledger") {
      assert.match(text, /PartyGSTIN/);
      assert.match(text, /LedgerGSTIN/);
    }
  }
  assert.throws(() => buildTargetedMastersXml({ names: Array(51).fill("A") }));
});

test("only requested masters are fetched in bounded batches and missing results fail closed", async () => {
  const names = Array.from({length: 103}, (_, i) => `Party ${i}`);
  let offset = 0; const sizes = [];
  const masters = await exportNamedCashDiscountMasters({}, "Company", names, "Ledger", async (_, request) => {
    const count = (request.match(/<OBJECT NAME=/g) || []).length; sizes.push(count);
    return '<ENVELOPE>' + names.slice(offset, offset += count).map((name, i) => `<KALIKAMASTERSEED${i+1}><NAME>${name}</NAME><GUID>guid-${offset+i}</GUID><PARENT>Receivables</PARENT></KALIKAMASTERSEED${i+1}>`).join('') + '</ENVELOPE>';
  });
  assert.deepEqual(sizes, [50, 50, 3]);
  assert.deepEqual(masters.map(m => m.name), names);
  await assert.rejects(exportNamedCashDiscountMasters({}, "Company", ["A"], "Ledger", async () => '<ENVELOPE/>'), /incomplete/);
  await assert.rejects(exportNamedCashDiscountMasters({}, "Company", ["A"], "Ledger", async () => '<KALIKAMASTERSEED1><NAME>Wrong</NAME><GUID>x</GUID></KALIKAMASTERSEED1>'), /incomplete/);
});

test("only ancestors of outstanding-bill parties are read, preserving nested scope rules", async () => {
  const calls = [];
  const ledgers = [{ name: "Customer", parent: "Local Receivables" }, { name: "Supplier", parent: "Sundry Creditors" }];
  const parents = { "Local Receivables": "Sundry Debtors", "Sundry Debtors": "Current Assets", "Current Assets": "Primary", "Sundry Creditors": "Current Liabilities", "Current Liabilities": "Primary" };
  const groups = await exportCashDiscountAncestorGroups({}, "Company", ledgers, async (_, company, names, type) => {
    assert.equal(company, "Company"); assert.equal(type, "Group"); calls.push(...names);
    return names.map(name => ({ name, parent: parents[name] }));
  });
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(!calls.includes("Primary"));
  assert.deepEqual(selectCashDiscountLedgers(ledgers, groups, { mode: "strict" }).map(l => l.name), ["Customer"]);
  assert.deepEqual(selectCashDiscountLedgers(ledgers, groups, { mode: "strict", excludedGroupNames: ["Local Receivables"] }), []);
});
