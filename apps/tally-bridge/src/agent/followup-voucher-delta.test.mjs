import assert from "node:assert/strict";
import test from "node:test";
import { TallyAgentGateway } from "./tally-gateway.mjs";

test("payment follow-up delta reads are AlterID-bounded and include settlement voucher types", async () => {
  let request = "";
  const gateway = new TallyAgentGateway({
    execute: async (invoke) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, options) => {
        request = String(options.body);
        return new Response(`<ENVELOPE><BODY><DATA><COLLECTION>
          <VOUCHER><DATE>20260903</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
          <VOUCHERNUMBER>R-1</VOUCHERNUMBER><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME>
          <ALTERID>42</ALTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME></ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME></ALLLEDGERENTRIES.LIST></VOUCHER>
        </COLLECTION></DATA></BODY></ENVELOPE>`, { status: 200 });
      };
      try { return await invoke(); } finally { globalThis.fetch = originalFetch; }
    },
  });
  const rows = await gateway.workflowVouchers({ companyName: "Company" }, {
    workflow: "payment_followups", afterAlterId: 41, limit: 25,
  });
  assert.match(request, /KalikaWorkflowAfterAlter/);
  assert.match(request, /\$AlterID &gt; 41/);
  assert.match(request, /<MAXCOUNT>25<\/MAXCOUNT>/);
  for (const type of ["Sales", "Receipt", "Credit Note", "Debit Note", "Journal"]) assert.match(request, new RegExp(type));
  assert.deepEqual(rows, [{
    date: "20260903", effectiveDate: "", voucherType: "Receipt", voucherNumber: "R-1",
    reference: "", partyLedgerName: "Customer A", masterId: "", alterId: 42, guid: "",
    isCancelled: false, narration: "", amount: "", ledgerNames: ["Customer A", "Bank"],
  }]);
});

test("summary VOUCHER counters and stale AlterIDs are ignored", async () => {
  const gateway = new TallyAgentGateway({
    execute: async (invoke) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(`<ENVELOPE><BODY><DESC><CMPINFO><VOUCHER>10</VOUCHER></CMPINFO></DESC>
        <DATA><COLLECTION><VOUCHER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><ALTERID>9</ALTERID></VOUCHER></COLLECTION></DATA>
      </BODY></ENVELOPE>`, { status: 200 });
      try { return await invoke(); } finally { globalThis.fetch = originalFetch; }
    },
  });
  assert.deepEqual(await gateway.workflowVouchers({ companyName: "Company" }, {
    workflow: "payment_followups", afterAlterId: 10,
  }), []);
});

test("the initial follow-up watermark reads only the newest eligible voucher", async () => {
  let request = "";
  const gateway = new TallyAgentGateway({
    execute: async (invoke) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, options) => {
        request = String(options.body);
        return new Response(`<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><ALTERID>99</ALTERID></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`);
      };
      try { return await invoke(); } finally { globalThis.fetch = originalFetch; }
    },
  });
  const rows = await gateway.workflowVouchers({ companyName: "Company" }, {
    workflow: "payment_followups", afterAlterId: 0, limit: 1, newestFirst: true,
  });
  assert.match(request, /<SORT>Default:-\$AlterID<\/SORT>/);
  assert.match(request, /<MAXCOUNT>1<\/MAXCOUNT>/);
  assert.equal(rows[0].alterId, 99);
});
