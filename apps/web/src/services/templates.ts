import type { CaseDoc, DocType } from "@/types/pipeline";

export const SAMPLE_DOCS: CaseDoc[] = [
  {
    id: "doc_po",
    type: "Purchase Order",
    title: "Purchase Order — PO-2026-0147",
    pages: 1,
    fields: {
      vendorName: "Pushpak Steel Industries Pvt. Ltd.",
      supplierGstin: "27AABCP0081C1ZX",
      buyerName: "Kalika Steel Alloys Pvt. Ltd.",
      buyerGstin: "27AACCK1502A1ZD",
      poNumber: "PO-2026-0147",
      documentDate: "2026-03-26",
      currency: "INR",
      subtotal: "1635300",
      taxAmount: "294354",
      totalAmount: "1929654",
      materialGrade: "E250A",
      itemQuantity: "35550",
      unit: "KG",
      hsnSac: "72161010",
      shipTo: "Plot No C-7/11, ADDL MIDC, Jalna",
    },
    md: `# Purchase Order

- Vendor: Pushpak Steel Industries Pvt. Ltd.
- Supplier GSTIN: 27AABCP0081C1ZX
- Buyer: Kalika Steel Alloys Pvt. Ltd.
- Buyer GSTIN: 27AACCK1502A1ZD
- PO Number: PO-2026-0147
- Date: 2026-03-26
- Material: MS Channel 150 x 75
- Grade: E250A
- Quantity: 35550 KG
- Subtotal: 1635300
- Tax: 294354
- Total: 1929654
- Currency: INR`,
    sourceHint: "case-po.pdf",
  },
  {
    id: "doc_tax_invoice",
    type: "Tax Invoice",
    title: "Tax Invoice — LD-2188/25-26",
    pages: 1,
    fields: {
      vendorName: "Pushpak Steel Industries Pvt. Ltd.",
      supplierGstin: "27AABCP0081C1ZX",
      buyerName: "Kalika Steel Alloys Pvt. Ltd.",
      buyerGstin: "27AACCK1502A1ZD",
      invoiceNumber: "LD-2188/25-26",
      referencePoNumber: "PO-2026-0147",
      irnNumber: "IRN-7d9c2bf1a7c1",
      ackNumber: "ACK-20260326-7842",
      ackDate: "2026-03-26",
      documentDate: "2026-03-26",
      currency: "INR",
      subtotal: "1635300",
      taxAmount: "294354",
      totalAmount: "1929654",
      itemQuantity: "35550",
      unit: "KG",
      vehicleNumber: "MH21X9939",
      dispatchFrom: "Lonand, Maharashtra",
      shipTo: "Jalna, Maharashtra",
    },
    md: `# Tax Invoice

- Vendor: Pushpak Steel Industries Pvt. Ltd.
- Buyer: Kalika Steel Alloys Pvt. Ltd.
- Invoice Number: LD-2188/25-26
- PO Reference: PO-2026-0147
- IRN: IRN-7d9c2bf1a7c1
- Ack Number: ACK-20260326-7842
- Date: 2026-03-26
- Material: MS Channel 150 x 75
- Quantity: 35550 KG
- Subtotal: 1635300
- Tax: 294354
- Total: 1929654
- Currency: INR`,
    sourceHint: "case-tax-invoice.pdf",
  },
  {
    id: "doc_eway",
    type: "E-Way Bill",
    title: "E-Way Bill — 272168387262",
    pages: 1,
    fields: {
      eWayBillNumber: "272168387262",
      invoiceNumber: "LD-2188/25-26",
      vendorName: "Pushpak Steel Industries Pvt. Ltd.",
      supplierGstin: "27AABCP0081C1ZX",
      buyerName: "Kalika Steel Alloys Pvt. Ltd.",
      buyerGstin: "27AACCK1502A1ZD",
      documentDate: "2026-03-26",
      transactionDate: "2026-03-26 11:22",
      vehicleNumber: "MH21X9939",
      dispatchFrom: "Lonand, Maharashtra",
      shipTo: "Jalna, Maharashtra",
      currency: "INR",
      taxAmount: "294354",
      totalAmount: "1929654",
    },
    md: `# E-Way Bill

- E-Way Bill Number: 272168387262
- Invoice Number: LD-2188/25-26
- Supplier: Pushpak Steel Industries Pvt. Ltd.
- Buyer: Kalika Steel Alloys Pvt. Ltd.
- Generated At: 2026-03-26 11:22
- Vehicle: MH21X9939
- Dispatch From: Lonand, Maharashtra
- Ship To: Jalna, Maharashtra
- Total Invoice Amount: 1929654
- Currency: INR`,
    sourceHint: "case-eway-bill.pdf",
  },
  {
    id: "doc_lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt — LR-758",
    pages: 1,
    fields: {
      lorryReceiptNumber: "758",
      documentDate: "2026-03-28",
      transporterName: "Tanuja Transport",
      vendorName: "Sambhaji Traders",
      buyerName: "Kalika Steel Alloys Pvt. Ltd.",
      routeFrom: "Aurangabad",
      routeTo: "Jalna",
      vehicleNumber: "MH49CX5586",
      netWeight: "8020",
    },
    md: `# Lorry Receipt

- LR Number: 758
- Date: 2026-03-28
- Transporter: Tanuja Transport
- From: Aurangabad
- To: Jalna
- Vehicle: MH49CX5586
- Material: Scrap
- Net Weight: 8020

Intentional mismatch:
- Vehicle number differs from the invoice and e-way bill`,
    sourceHint: "case-lr.pdf",
  },
  {
    id: "doc_weighment",
    type: "Weighment Slip",
    title: "Weighment Slip — 1813",
    pages: 1,
    fields: {
      weighmentNumber: "1813",
      weighbridgeName: "Pushpak Steel Industries Pvt. Ltd.",
      documentDate: "2026-03-26",
      vehicleNumber: "MH21X9939",
      grossWeight: "47040",
      tareWeight: "11490",
      netWeight: "35550",
    },
    md: `# Weighment Slip

- Weighment Number: 1813
- Weighbridge Name: Pushpak Steel Industries Pvt. Ltd.
- Date: 2026-03-26
- Vehicle: MH21X9939
- Material: MS Channel 150 x 75
- Gross Weight: 47040
- Tare Weight: 11490
- Net Weight: 35550`,
    sourceHint: "case-weighment-slip.pdf",
  },
];

export function matchSampleByIndex(index: number): CaseDoc {
  return SAMPLE_DOCS[index % SAMPLE_DOCS.length];
}

export function matchSampleByType(type: DocType): CaseDoc | null {
  return SAMPLE_DOCS.find((doc) => doc.type === type) ?? null;
}
