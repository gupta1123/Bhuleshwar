type PartyFields = {
  buyerName?: string | null;
  buyerGstin?: string | null;
  vendorName?: string | null;
  supplierGstin?: string | null;
  invoiceNumber?: string | null;
};

export type NamingDocument = { type: string; fields: PartyFields };
export type DirectoryParty = PartyFields & { type: string };

export const SUPPLIER_PENDING = "Supplier pending";
const companyGstin = "27AAACB2203M1ZZ";

function key(value?: string | null) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isBhuleshwarName(value?: string | null) {
  return /bhuleshwar|bhuleshvar|^bsapl(?:$|fy|20|trishul)/.test(key(value));
}

function isCompany(name?: string | null, gstin?: string | null) {
  const id = (gstin || "").trim().toUpperCase();
  return id === companyGstin || isBhuleshwarName(name);
}

function sellerName(fields: PartyFields) {
  const name = (fields.vendorName || "").replace(/^m\s*\/\s*s\.?\s+/i, "").trim();
  return !key(name) || /^(na|unknown|none|nil|notavailable|notvisible|notapplicable)$/.test(key(name))
    || isCompany(name, fields.supplierGstin) ? "" : name;
}

export function purchaseCaseIdentity(documents: readonly NamingDocument[]) {
  const invoices = documents.filter(doc => doc.type === "Invoice" || doc.type === "Tax Invoice");
  if (!invoices.length) return null;
  const candidates = invoices.filter(({fields}) => isCompany(fields.buyerName, fields.buyerGstin));
  const sellers = new Set(candidates.map(({fields}) => key(sellerName(fields))));
  const refs = new Set(candidates.map(({fields}) => fields.invoiceNumber?.trim()).filter(Boolean));
  const supplier = sellers.size === 1 && !sellers.has("") ? sellerName(candidates[0].fields) : SUPPLIER_PENDING;
  const invoiceNumber = refs.size === 1 && sellers.size <= 1 ? [...refs][0] || "" : "";
  return { supplier, invoiceNumber, title: invoiceNumber ? supplier + " / " + invoiceNumber : supplier };
}
