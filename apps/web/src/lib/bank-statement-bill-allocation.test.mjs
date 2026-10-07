import assert from "node:assert/strict";
import test from "node:test";

import { allocateReceiptByFifo } from "./bank-statement-bill-allocation.ts";

const mahavirBills = [
  { referenceName: "MSC/26-27/404", invoiceDate: "2026-08-05", pendingAmount: 95_000 },
  { referenceName: "MSC/26-27/403", invoiceDate: "2026-08-05", pendingAmount: 75_000 },
];

test("records the full receipt as an advance when Tally has no open bills", () => {
  const result = allocateReceiptByFifo(83_000, [], "ADV-20260817-260001");

  assert.deepEqual(result.allocations, [
    {
      referenceType: "Advance",
      referenceName: "ADV-20260817-260001",
      allocatedAmount: 83_000,
      pendingAmountAfterAllocation: 83_000,
      statusAfterAllocation: "advance",
    },
  ]);
  assert.equal(result.newAdvanceAmount, 83_000);
  assert.equal(result.unallocatedAmount, 0);
});

test("allocates the Mahavir receipt across same-date bills by stable reference order", () => {
  const result = allocateReceiptByFifo(94_000, mahavirBills, "ADV-unused");

  assert.deepEqual(
    result.allocations.map(({ referenceType, referenceName, allocatedAmount }) => ({
      referenceType,
      referenceName,
      allocatedAmount,
    })),
    [
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/403", allocatedAmount: 75_000 },
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/404", allocatedAmount: 19_000 },
    ]
  );
  assert.equal(result.unallocatedAmount, 0);
  assert.equal(result.newAdvanceAmount, 0);
});

test("prioritizes an invoice reference found in narration", () => {
  const result = allocateReceiptByFifo(94_000, mahavirBills, "ADV-unused", "MSC/26-27/404");

  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].referenceName, "MSC/26-27/404");
  assert.equal(result.allocations[0].allocatedAmount, 94_000);
});

test("records only the amount exceeding all open bills as an advance", () => {
  const result = allocateReceiptByFifo(200_000, mahavirBills, "ADV-20260817-example");

  assert.deepEqual(result.allocations.map((allocation) => allocation.allocatedAmount), [75_000, 95_000, 30_000]);
  assert.equal(result.allocations[2].referenceType, "Advance");
  assert.equal(result.allocations[2].referenceName, "ADV-20260817-example");
  assert.equal(result.newAdvanceAmount, 30_000);
  assert.equal(result.unallocatedAmount, 0);
});

test("uses due date before invoice date and leaves undated bills last", () => {
  const result = allocateReceiptByFifo(
    60_000,
    [
      { referenceName: "UNDATED", pendingAmount: 40_000 },
      { referenceName: "LATER-INVOICE", invoiceDate: "2026-07-01", dueDate: "2026-07-20", pendingAmount: 40_000 },
      { referenceName: "EARLIER-DUE", invoiceDate: "2026-07-10", dueDate: "2026-07-15", pendingAmount: 40_000 },
    ],
    "ADV-unused"
  );

  assert.deepEqual(result.allocations.map((allocation) => allocation.referenceName), ["EARLIER-DUE", "LATER-INVOICE"]);
  assert.deepEqual(result.allocations.map((allocation) => allocation.allocatedAmount), [40_000, 20_000]);
});
