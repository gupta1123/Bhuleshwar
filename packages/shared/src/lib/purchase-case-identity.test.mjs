import assert from "node:assert/strict";
import test from "node:test";
import { purchaseCaseIdentity } from "./purchase-case-identity.ts";

const invoice = (vendorName, buyerName, invoiceNumber, buyerGstin) => ({
  type: "Tax Invoice", fields: { vendorName, buyerName, invoiceNumber, buyerGstin },
});
const direct = invoice("Vishwa Geeta Ispat", "BSAPL - F.Y. 2025-2027", "VGI/7709");
const upstream = invoice("Shaurya Ispat", "Vishwa Geeta Ispat", "SI/4153");

test("register supplier and heading use the same invoice in either order", () => {
  for (const docs of [[direct, upstream], [upstream, direct], [upstream, direct, direct]]) {
    assert.deepEqual(purchaseCaseIdentity(docs), {
      supplier: "Vishwa Geeta Ispat", invoiceNumber: "VGI/7709", title: "Vishwa Geeta Ispat / VGI/7709",
    });
  }
});
test("matches BSAPL by GSTIN when the buyer name is unreadable", () => {
  assert.equal(purchaseCaseIdentity([invoice("Indrayani", "", "2004", "27AAACB2203M1ZZ")]).title, "Indrayani / 2004");
});
test("never substitutes BSAPL or an upstream seller for an unknown supplier", () => {
  for (const docs of [[upstream], [invoice("BSAPL", "Bhuleshwar Steel", "14")],
    [invoice("Unknown", "Bhuleshwar Steel", "14"), upstream], [direct, invoice("Other", "BSAPL", "42")]]) {
    assert.equal(purchaseCaseIdentity(docs).supplier, "Supplier pending");
  }
  assert.equal(purchaseCaseIdentity([upstream]).invoiceNumber, "");
});
test("multiple bills from the same direct supplier retain the name without guessing a number", () => {
  assert.equal(purchaseCaseIdentity([direct, invoice("Vishwa Geeta Ispat", "BSAPL", "42")]).title, "Vishwa Geeta Ispat");
});
