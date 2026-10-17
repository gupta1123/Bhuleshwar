// Request-local static objects perform direct named-master dereferences. There
// is deliberately no Type: Ledger/Group collection and no company-wide filter.
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const literal = value => '("' + String(value).replaceAll('"', () => '" + $$Chr:34 + "') + '")';
export function buildTargetedMastersXml({ companyName, names, type = "Ledger" }) {
  if (!["Ledger", "Group"].includes(type) || !names.length || names.length > 50) throw new Error("Invalid targeted master request.");
  const fields = type === "Group" ? ["Name", "Parent", "GUID"] : [
    "Name", "Parent", "GUID", "PartyGSTIN", "GSTIN", "GSTRegistrationNumber",
    "GSTRegNumber", "GSTNo", "GSTNumber", "GSTIdentificationNumber", "LedgerGSTIN",
    "IsBillWiseOn", "Email", "LedgerPhone", "LedgerContact",
  ];
  const ids = names.map((_, i) => `KalikaMasterSeed${i + 1}`);
  const objects = names.map((name, i) => `<OBJECT NAME="${ids[i]}">${fields.map(field => `<LOCALFORMULA>${field} : ${xml(`$${field}:${type}:${literal(name)}`)}</LOCALFORMULA>`).join("")}</OBJECT>`).join("");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Kalika Targeted Masters</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>${objects}<COLLECTION NAME="Kalika Targeted Masters"><OBJECT>${ids.join(",")}</OBJECT><FETCH>${fields.join(",")}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}
