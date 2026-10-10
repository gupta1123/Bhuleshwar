import { toNumber, toText, type DebitNoteProposalRow } from "@/lib/collections";

export class WhatsappRejectedError extends Error {}

export type Msg91TemplateLanguage = {
  name?: string;
  language?: string;
  status?: string;
  variables?: string[];
  variable_type?: Record<string, { type?: string; parameter_name?: string }>;
};

export type Msg91Template = {
  name?: string;
  category?: string;
  namespace?: string;
  languages?: Msg91TemplateLanguage[];
};

export type Msg91DebitNoteSendInput = {
  proposal: DebitNoteProposalRow;
  recipientPhone: string;
  documentUrl: string;
  documentName?: string;
};

const CONTROL_BASE_URL = "https://control.msg91.com/api/v5/whatsapp";
const API_BASE_URL = "https://control.msg91.com/api/v5/whatsapp";

function envText(name: string) {
  return String(process.env[name] ?? "").trim();
}

export function getMsg91WhatsappConfig() {
  const authkey = envText("MSG91_AUTHKEY");
  const senderNumber = envText("MSG91_WHATSAPP_NUMBER") || "919822486740";
  const templateName = envText("MSG91_DEBIT_NOTE_TEMPLATE_NAME") || "share_invoice";
  const languageCode = envText("MSG91_DEBIT_NOTE_TEMPLATE_LANGUAGE") || "en";
  const templateMode = envText("MSG91_DEBIT_NOTE_TEMPLATE_MODE") || "share_invoice_fallback";
  const templateNamespace = envText("MSG91_DEBIT_NOTE_TEMPLATE_NAMESPACE");
  const fallbackDocumentUrl = envText("MSG91_DEBIT_NOTE_TEST_DOCUMENT_URL");

  return {
    authkey,
    senderNumber,
    templateName,
    languageCode,
    templateMode,
    templateNamespace,
    fallbackDocumentUrl,
    isConfigured: Boolean(authkey && senderNumber),
  };
}

export function normalizeWhatsappPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

export async function fetchMsg91WhatsappTemplates() {
  const config = getMsg91WhatsappConfig();
  if (!config.authkey) {
    throw new Error("MSG91_AUTHKEY is not configured.");
  }

  const response = await fetch(`${CONTROL_BASE_URL}/get-template-client/${config.senderNumber}`, {
    headers: {
      authkey: config.authkey,
      "content-type": "application/json",
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `MSG91 template fetch failed with ${response.status}`);
  }
  return payload as { status?: string; hasError?: boolean; data?: Msg91Template[]; errors?: unknown };
}

function formatInrPlain(value: unknown) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(toNumber(value));
}

function formatDateForMessage(value: unknown) {
  const text = toText(value, 20);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function proposalCustomerName(proposal: DebitNoteProposalRow) {
  return toText(proposal.party_contact_person, 80) || toText(proposal.party_ledger_name, 120);
}

function proposalVoucherNumber(proposal: DebitNoteProposalRow) {
  return (
    toText(proposal.tally_voucher_number, 120) ||
    (proposal.linked_invoice_number ? `DN-CD-${toText(proposal.linked_invoice_number, 100)}` : `DN-CD-${proposal.id.slice(0, 8)}`)
  );
}

function buildTemplatePayload(input: Msg91DebitNoteSendInput, phone: string) {
  const config = getMsg91WhatsappConfig();
  const proposal = input.proposal;
  const companyName = toText(proposal.company_name, 120) || "Kalika";
  const debitNoteNumber = proposalVoucherNumber(proposal);
  const debitNoteDate = formatDateForMessage(proposal.tally_voucher_date || proposal.debit_note_date);
  const amount = formatInrPlain(proposal.recoverable_amount);
  const invoiceNumber = toText(proposal.linked_invoice_number, 120) || "the linked invoice";
  const documentUrl = input.documentUrl;

  if (config.templateMode === "debit_note_created_v1") {
    return {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: config.templateName,
        language: {
          code: config.languageCode,
          policy: "deterministic",
        },
        namespace: config.templateNamespace,
        to_and_components: [
          {
            to: [phone],
            components: {
              header_1: { type: "document", value: documentUrl, filename: input.documentName || `${debitNoteNumber}.pdf` },
              body_1: { type: "text", value: proposalCustomerName(proposal) },
              body_2: { type: "text", value: companyName },
              body_3: { type: "text", value: debitNoteNumber },
              body_4: { type: "text", value: debitNoteDate },
              body_5: { type: "text", value: amount },
              body_6: { type: "text", value: invoiceNumber },
            },
          },
        ],
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    type: "template",
    template: {
      name: config.templateName,
      language: {
        code: config.languageCode,
        policy: "deterministic",
      },
      namespace: config.templateNamespace,
      to_and_components: [
        {
          to: [phone],
          components: {
            header_1: { type: "document", value: documentUrl, filename: input.documentName || `${debitNoteNumber}.pdf` },
            body_var_1: { type: "text", value: proposalCustomerName(proposal) },
            body_var_2: { type: "text", value: debitNoteNumber },
            body_var_3: { type: "text", value: debitNoteDate },
            body_var_4: { type: "text", value: `₹${amount}` },
            body_var_5: { type: "text", value: companyName },
          },
        },
      ],
    },
  };
}

export async function sendDebitNoteWhatsapp(input: Msg91DebitNoteSendInput) {
  const config = getMsg91WhatsappConfig();
  if (!config.authkey) {
    throw new Error("MSG91_AUTHKEY is not configured.");
  }
  if (!config.templateNamespace) {
    throw new Error("MSG91_DEBIT_NOTE_TEMPLATE_NAMESPACE is not configured.");
  }
  const phone = normalizeWhatsappPhone(input.recipientPhone);
  if (!phone) {
    throw new Error("Customer WhatsApp number is missing.");
  }

  const body = {
    integrated_number: config.senderNumber,
    content_type: "template",
    payload: buildTemplatePayload(input, phone),
  };

  const response = await fetch(`${API_BASE_URL}/whatsapp-outbound-message/bulk/`, {
    method: "POST",
    headers: {
      authkey: config.authkey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.hasError) {
    if ([400,401,403,404,422].includes(response.status)) {
      throw new WhatsappRejectedError('WhatsApp provider rejected the request. Check its configuration, template and recipient before retrying.');
    }
    throw new Error(payload?.message || payload?.error || JSON.stringify(payload?.errors ?? payload) || "MSG91 send failed.");
  }
  return { payload, request: body };
}
