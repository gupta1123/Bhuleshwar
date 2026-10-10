import { toNumber, toText, type DebitNoteProposalRow } from "@/lib/collections";
import { createHash } from "node:crypto";

export const DEBIT_NOTE_PDF_BUCKET = "debit-note-pdfs";

type SupabaseAdminClient = {
  storage: {
    createBucket: (name: string, options: { public: boolean; fileSizeLimit?: string; allowedMimeTypes?: string[] }) => Promise<{ error: unknown }>;
    from: (name: string) => {
      upload: (path: string, body: Buffer, options: { contentType: string; upsert: boolean }) => Promise<{ error: unknown }>;
      createSignedUrl: (path: string, expiresIn: number) => Promise<{ data: { signedUrl: string } | null; error: unknown }>;
    };
  };
};

function escapePdfText(value: unknown) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "");
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(toNumber(value));
}

function formatDate(value: unknown) {
  const text = toText(value, 20);
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function pdfText(x: number, y: number, size: number, text: unknown) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function pdfLine(x1: number, y1: number, x2: number, y2: number) {
  return `${x1} ${y1} m ${x2} ${y2} l S`;
}

function buildPdf(lines: string[]) {
  const content = lines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function debitNotePdfFileName(proposal: DebitNoteProposalRow) {
  const voucherNumber = toText(proposal.tally_voucher_number, 120) || `debit-note-${proposal.id.slice(0, 8)}`;
  return `${voucherNumber.replace(/[^a-z0-9._-]+/gi, "-")}.pdf`;
}

export function nativeTallyDebitNotePdfFileName(proposal: DebitNoteProposalRow) {
  const voucherNumber = toText(proposal.tally_voucher_number, 120) || "debit-note";
  const reference = toText(proposal.tally_open_reference_name, 120);
  const safe = ["tally-debit-note", voucherNumber, reference]
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safe || `debit-note-${proposal.id.slice(0, 8)}`}.pdf`;
}

export function generateDebitNotePdf(proposal: DebitNoteProposalRow) {
  const voucherNumber = toText(proposal.tally_voucher_number, 120) || "Debit Note";
  const companyName = toText(proposal.company_name, 120) || "Company";
  const partyName = toText(proposal.party_ledger_name, 160);
  const amount = money(proposal.recoverable_amount);
  const invoiceNumber = toText(proposal.linked_invoice_number, 120) || "-";
  const invoiceDate = formatDate(proposal.linked_invoice_date);
  const voucherDate = formatDate(proposal.tally_voucher_date || proposal.debit_note_date);
  const receiptDate = formatDate(proposal.receipt_date);
  const deadline = formatDate(proposal.discount_deadline);
  const narration = toText(proposal.narration, 260) || "Cash discount reversal.";

  return buildPdf([
    "0.22 w",
    pdfText(50, 790, 20, "Debit Note"),
    pdfText(50, 765, 11, companyName),
    pdfText(390, 790, 10, `Voucher No: ${voucherNumber}`),
    pdfText(390, 772, 10, `Date: ${voucherDate}`),
    pdfLine(50, 745, 545, 745),
    pdfText(50, 715, 12, "Customer"),
    pdfText(50, 695, 11, partyName),
    pdfText(50, 678, 9, `GSTIN: ${toText(proposal.party_gstin, 40) || "-"}`),
    pdfText(50, 660, 9, `Phone: ${toText(proposal.party_phone, 40) || "-"}`),
    pdfText(310, 715, 12, "Linked Invoice"),
    pdfText(310, 695, 11, invoiceNumber),
    pdfText(310, 678, 9, `Invoice date: ${invoiceDate}`),
    pdfText(310, 660, 9, `Receipt date: ${receiptDate}`),
    pdfLine(50, 625, 545, 625),
    pdfText(65, 598, 10, "Description"),
    pdfText(405, 598, 10, "Amount"),
    pdfLine(50, 585, 545, 585),
    pdfText(65, 555, 11, "Cash Discount recovery / short payment reversal"),
    pdfText(405, 555, 11, `INR ${amount}`),
    pdfText(65, 532, 9, `Discount deadline: ${deadline}`),
    pdfText(65, 514, 9, `Amount received: INR ${money(proposal.amount_received)}`),
    pdfText(65, 496, 9, `Original invoice amount: INR ${money(proposal.original_invoice_amount)}`),
    pdfLine(50, 465, 545, 465),
    pdfText(330, 438, 12, "Recoverable Amount"),
    pdfText(455, 438, 12, `INR ${amount}`),
    pdfLine(50, 410, 545, 410),
    pdfText(50, 382, 10, "Narration"),
    pdfText(50, 362, 9, narration),
    pdfText(50, 315, 8, "This debit note was generated from the confirmed Tally voucher details."),
  ]);
}

export function encodeDebitNotePdfReference(path: string) {
  return `storage://${DEBIT_NOTE_PDF_BUCKET}/${path}`;
}

export function decodeDebitNotePdfReference(reference: string | null | undefined) {
  const text = toText(reference, 2000);
  const prefix = `storage://${DEBIT_NOTE_PDF_BUCKET}/`;
  if (!text.startsWith(prefix)) return null;
  return text.slice(prefix.length);
}

export async function ensureDebitNotePdfBucket(supabase: SupabaseAdminClient) {
  const { error } = await supabase.storage.createBucket(DEBIT_NOTE_PDF_BUCKET, {
    public: false,
    fileSizeLimit: "5MB",
    allowedMimeTypes: ["application/pdf"],
  });
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (error && !/already exists|Duplicate/i.test(message)) {
    throw error;
  }
}

export async function uploadDebitNotePdf(supabase: SupabaseAdminClient, proposal: DebitNoteProposalRow) {
  await ensureDebitNotePdfBucket(supabase);
  const fileName = debitNotePdfFileName(proposal);
  const path = `${proposal.owner_user_id}/${proposal.id}/${fileName}`;
  const pdf = generateDebitNotePdf(proposal);
  const { error } = await supabase.storage.from(DEBIT_NOTE_PDF_BUCKET).upload(path, pdf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw error;
  return encodeDebitNotePdfReference(path);
}

export async function uploadNativeTallyDebitNotePdf(
  supabase: SupabaseAdminClient,
  proposal: DebitNoteProposalRow,
  pdf: Buffer,
  immutable = false
) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 5 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("The connector did not return a valid PDF document from Tally.");
  }
  if (pdf.length > 5 * 1024 * 1024) {
    throw new Error("The native Tally PDF exceeds the 5 MB document limit.");
  }

  await ensureDebitNotePdfBucket(supabase);
  const fileName = nativeTallyDebitNotePdfFileName(proposal);
  const digest = createHash("sha256").update(pdf).digest("hex");
  const path = `${proposal.owner_user_id}/${proposal.id}/native/${immutable ? `${digest}.pdf` : fileName}`;
  const { error } = await supabase.storage.from(DEBIT_NOTE_PDF_BUCKET).upload(path, pdf, {
    contentType: "application/pdf",
    upsert: !immutable,
  });
  if (error && !(immutable && /already exists|Duplicate/i.test(String((error as {message?:unknown}).message)))) throw error;

  return {
    reference: encodeDebitNotePdfReference(path),
    sha256: createHash("sha256").update(pdf).digest("hex"),
    byteSize: pdf.length,
  };
}

export async function createDebitNotePdfSignedUrl(
  supabase: SupabaseAdminClient,
  reference: string | null | undefined,
  expiresInSeconds = 60 * 60
) {
  const path = decodeDebitNotePdfReference(reference);
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(DEBIT_NOTE_PDF_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data?.signedUrl ?? null;
}
