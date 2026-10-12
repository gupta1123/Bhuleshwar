import test from "node:test";
import assert from "node:assert/strict";
import { extractInvoiceCoreFieldsFromText } from "./invoice-core-fields.ts";

test("recovers invoice core fields from the packet tax invoice text", () => {
  const fields = extractInvoiceCoreFieldsFromText(`
    Tax Invoice Document number KTC/26-27/0723-RT Document date 23/07/2026
    Supplier GSTIN 27KTC2607071Z5 Buyer GSTIN 27NYXCO1234A1Z7
    Taxable value INR 861,100.00 Grand total INR 1,016,098.00
  `);
  assert.deepEqual(fields, {
    invoiceNumber: "KTC/26-27/0723-RT",
    documentDate: "2026-07-23",
    supplierGstin: "27KTC2607071Z5",
    buyerGstin: "27NYXCO1234A1Z7",
    totalAmount: "1016098",
    totalTaxableAmount: "861100",
    subtotal: "861100",
  });
});

test("does not treat a purchase-order number as an invoice number", () => {
  const fields = extractInvoiceCoreFieldsFromText("Purchase Order PO No NYX/PO/26-27/0722-RT Order Date 22/07/2026");
  assert.equal(fields.invoiceNumber, undefined);
});
