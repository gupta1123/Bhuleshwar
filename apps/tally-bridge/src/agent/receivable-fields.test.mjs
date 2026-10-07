import test from "node:test";
import assert from "node:assert/strict";
import { fetchCustomerOpenBillsFromTally, buildOpenBillAmountIndex } from "../bridge.mjs";
import { billFields, voucherFields, openBillsByLedgerFromFields, openBillAmountIndexFromFields } from "./receivable-fields.mjs";

// The field calculation must give exactly the result of the XML calculation it
// replaces, on the same Tally records.
async function xmlResult(ledgerNames, billXml, voucherXml) {
  const outcome = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9" }, { ledgerNames, companyName: "Demo Co", asOfDate: "2027-03-31" }, {
    forceVoucherEvidence: true,
    billExport: { xml: billXml.join("\n"), batchCount: 0 },
    voucherExport: { xml: voucherXml.join("\n"), batchCount: 0 },
  });
  return outcome.result.byLedger;
}
const fieldResult = (ledgerNames, billXml, voucherXml) =>
  openBillsByLedgerFromFields(ledgerNames, billXml.map(billFields), voucherXml.map(voucherFields)).byLedger;

const bill = ({ name, ledger, closing, opening, date = "20260405", due, type, advance, voucherType = "Sales", number, pendingOnly }) =>
  `<BILL NAME="${name}"><NAME>${name}</NAME><LEDGERNAME>${ledger}</LEDGERNAME>${advance ? "<ISADVANCE>Yes</ISADVANCE>" : ""}` +
  `${type ? `<BILLTYPE>${type}</BILLTYPE>` : ""}<DATE>${date}</DATE>${due ? `<DUEDATE>${due}</DUEDATE>` : ""}` +
  `<VOUCHERNUMBER>${number || name}</VOUCHERNUMBER><VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>` +
  `${opening !== undefined ? `<OPENINGBALANCE>${opening}</OPENINGBALANCE>` : ""}` +
  `${pendingOnly ? `<PENDINGAMOUNT>${closing}</PENDINGAMOUNT>` : `<CLOSINGBALANCE>${closing}</CLOSINGBALANCE>`}</BILL>`;
const entry = (ledger, amount, debit, allocations = []) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT>` +
  allocations.map(([name, value, billType]) => `<BILLALLOCATIONS.LIST><NAME>${name}</NAME>${billType ? `<BILLTYPE>${billType}</BILLTYPE>` : ""}<AMOUNT>${value}</AMOUNT></BILLALLOCATIONS.LIST>`).join("") +
  "</ALLLEDGERENTRIES.LIST>";
const voucher = ({ type, date, effective, number, reference, narration, party, entries, id }) =>
  `<VOUCHER VCHTYPE="${type}"><DATE>${date}</DATE>${effective ? `<EFFECTIVEDATE>${effective}</EFFECTIVEDATE>` : ""}<VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
  `<VOUCHERNUMBER>${number}</VOUCHERNUMBER>${reference ? `<REFERENCE>${reference}</REFERENCE>` : ""}${narration ? `<NARRATION>${narration}</NARRATION>` : ""}` +
  `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><MASTERID>${id}</MASTERID>${entries.join("")}</VOUCHER>`;

test("fields give the same open bills as the XML calculation on awkward records", async () => {
  const A = "Apex Traders &amp; Sons, Pune", B = "Balaji Stores";
  const ledgers = ["Apex Traders & Sons, Pune", B, "Nobody Ltd"];
  const bills = [
    bill({ name: "INV/26-27/001", ledger: A, closing: "-600.00", opening: "-1000.00", due: "20260505" }),
    bill({ name: "INV/26-27/002", ledger: A, closing: "-250.00", pendingOnly: true }),
    bill({ name: "ADV-7", ledger: A, closing: "300.00", voucherType: "Receipt" }),
    bill({ name: "ON-ACC", ledger: B, closing: "500.00", advance: true }),
    bill({ name: "TI-9", ledger: B, closing: "-1180.00", opening: "-1180.00", voucherType: "Tax Invoice", number: "TI/9" }),
    bill({ name: "INV-PAID", ledger: B, closing: "-100.00", opening: "-100.00" }),
    bill({ name: "OLD-1", ledger: B, closing: "-75.50", date: "1-Apr-25", type: "Agst Ref" }),
  ];
  const vouchers = [
    voucher({ id: 1, type: "Sales", date: "20260405", number: "INV/26-27/001", narration: "Steel bars &lt;TMT&gt;", party: A,
      entries: [entry(A, "-1000.00", true, [["INV/26-27/001", "-1000.00", "New Ref"]]), entry("Sales Steel", "847.46", false), entry("Output IGST 18%", "152.54", false)] }),
    voucher({ id: 2, type: "Receipt", date: "20260410", effective: "20260409", number: "R-1", party: A,
      entries: [entry(A, "400.00", false, [["INV/26-27/001", "400.00", "Agst Ref"]]), entry("HDFC Bank", "-400.00", true)] }),
    voucher({ id: 3, type: "Receipt", date: "20260412", number: "R-2", narration: "Advance received", party: A,
      entries: [entry(A, "300.00", false, [["ADV-7", "300.00", "Advance"]]), entry("Cash", "-300.00", true)] }),
    voucher({ id: 4, type: "Tax Invoice", date: "20260406", number: "TI/9", reference: "PO-55", party: B,
      entries: [entry(B, "-1180.00", true, [["TI-9", "-1180.00"]]), entry("Output CGST", "90.00", false), entry("Sales Local", "1000.00", false)] }),
    voucher({ id: 5, type: "Receipt", date: "20260420", number: "R-3", narration: "Payment against INV-PAID in full", party: B,
      entries: [entry(B, "100.00", false), entry("Axis Bank", "-100.00", true)] }),
    voucher({ id: 6, type: "Sales", date: "20260407", number: "INV-PAID", party: B, entries: [entry(B, "-100.00", true, [["INV-PAID", "-100.00"]]), entry("Sales Local", "100.00", false)] }),
    voucher({ id: 7, type: "Credit Note", date: "20260421", number: "CN-1", party: B, entries: [entry(B, "50.00", false, [["TI-9", "50.00"]])] }),
  ];
  assert.deepEqual(fieldResult(ledgers, bills, vouchers), await xmlResult(ledgers, bills, vouchers));
});

test("fields give the same open bills as the XML calculation on 300 random customers", async () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const ledgers = Array.from({ length: 300 }, (_, index) => `Customer ${index} ${pick(["Pvt Ltd", "& Co", "Traders", ""])}`.trim());
  const bills = [], vouchers = [];
  let id = 0;
  for (const name of ledgers) {
    const xmlName = name.replace(/&/g, "&amp;");
    for (let n = 0; n < 1 + Math.floor(random() * 4); n += 1) {
      const ref = `${pick(["INV", "TI", "ADV", "SI"])}/${Math.floor(random() * 900) + 100}`;
      const amount = (Math.floor(random() * 90000) + 100) / 100;
      const paid = random() < 0.5 ? Math.round(amount * random() * 100) / 100 : 0;
      bills.push(bill({ name: ref, ledger: xmlName, closing: (-(amount - paid)).toFixed(2), opening: random() < 0.8 ? (-amount).toFixed(2) : undefined,
        date: `2026${pick(["04", "05", "06"])}${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`, advance: random() < 0.05, pendingOnly: random() < 0.1,
        voucherType: pick(["Sales", "Tax Invoice", "Receipt", ""]) }));
      if (random() < 0.9) vouchers.push(voucher({ id: ++id, type: pick(["Sales", "Tax Invoice", "Sales GST"]), date: "20260401", number: ref, narration: random() < 0.5 ? `Supply ${ref}` : "", party: xmlName,
        entries: [entry(xmlName, (-amount).toFixed(2), true, [[ref, (-amount).toFixed(2)]]), entry(pick(["Sales A", "Sales B"]), amount.toFixed(2), false), entry("Output GST", "0.00", false)] }));
      if (paid) vouchers.push(voucher({ id: ++id, type: pick(["Receipt", "Bank Receipt", "Payment"]), date: `2026${pick(["04", "05"])}15`, number: `R-${id}`, narration: random() < 0.3 ? `against ${ref}` : "", party: xmlName,
        entries: [entry(xmlName, paid.toFixed(2), false, random() < 0.8 ? [[ref, paid.toFixed(2), pick(["Agst Ref", "Advance", ""])]] : []), entry("Bank", (-paid).toFixed(2), true)] }));
    }
  }
  for (let offset = 0; offset < ledgers.length; offset += 50) {
    const batch = ledgers.slice(offset, offset + 50);
    assert.deepEqual(fieldResult(batch, bills, vouchers), await xmlResult(batch, bills, vouchers));
  }
  const byXml = buildOpenBillAmountIndex(bills.join("\n"));
  assert.deepEqual(openBillAmountIndexFromFields(bills.map(billFields)), byXml, "bank amount suggestions index");
});
