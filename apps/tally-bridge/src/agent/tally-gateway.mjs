const XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
function escapeXml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => XML_ESCAPE[character]); }
function decodeXml(value) { return String(value || "").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&"); }
function tag(block, name) { return decodeXml(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]?.trim() || ""); }
function hsnCode(block, ...names) {
  for (const name of names) {
    const raw = tag(block, name);
    if (/^(?:not\s+found|not\s+available|n\/?a|none|null|undefined|-+)$/i.test(raw)) continue;
    const value = raw.replace(/\D/g, "");
    if (/^\d{4,8}$/.test(value)) return value;
  }
  return null;
}
function blocks(xml, name) { return [...String(xml || "").matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, "gi"))].map((match) => match[0]); }
function formulaString(value) { return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

function requestEnvelope(reportName, staticVariables = {}) {
  const variables = Object.entries(staticVariables).map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join("");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export Data</TALLYREQUEST><TYPE>Data</TYPE><ID>${reportName}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${variables}</STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

function compactCollectionEnvelope({ companyName, collectionName, nativeFields, collectionType, afterAlterId = 0, limit = 50 }) {
  const fetchFields = [...new Set(nativeFields)].join(",");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export Data</TALLYREQUEST><TYPE>Collection</TYPE><ID>${escapeXml(collectionName)}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No"><TYPE>${escapeXml(collectionType)}</TYPE><FETCH>${escapeXml(fetchFields)}</FETCH><FILTERS>KalikaAgentAfterAlterId</FILTERS><SORT>Default:$AlterID</SORT><MAXCOUNT>${Math.max(1, Math.min(50, limit))}</MAXCOUNT></COLLECTION><SYSTEM TYPE="Formulae" NAME="KalikaAgentAfterAlterId">$AlterID &gt; ${Number(afterAlterId || 0)}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export class TallyAgentGateway {
  constructor({ tallyUrl = "http://localhost:9000", timeoutMs = 20_000, execute } = {}) {
    this.tallyUrl = tallyUrl;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  // onStart runs when the request leaves the shared Tally queue, so callers
  // can tell queue wait apart from Tally's own time.
  async invoke(xml, { signal, timeoutMs = this.timeoutMs, onStart } = {}) {
    const request = async () => {
      onStart?.();
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(this.tallyUrl, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body: xml, signal: combined });
      const text = await response.text();
      if (!response.ok) throw new Error(`Tally returned HTTP ${response.status}.`);
      return text;
    };
    return this.execute ? this.execute(request, { priority: 50, kind: "background" }) : request();
  }

  async capabilities(identity, { signal } = {}) {
    try {
      const xml = await this.invoke(requestEnvelope("KalikaAgentCapabilities", { SVCURRENTCOMPANY: identity.companyName }), { signal, timeoutMs: 8_000 });
      const companyGuid = tag(xml, "COMPANYGUID");
      if (companyGuid) return {
        version: Number(tag(xml, "VERSION") || 1), companyGuid,
        financialYear: tag(xml, "FINANCIALYEAR") || identity.financialYear,
        highestAlterId: Number(tag(xml, "HIGHESTALTERID") || 0),
        reports: tag(xml, "REPORTS").split(",").filter(Boolean),
      };
    } catch {}
    const fallback = await this.invoke(compactCollectionEnvelope({
      companyName: identity.companyName,
      collectionName: "KalikaAgentCompanyIdentityFallback",
      collectionType: "Company",
      nativeFields: ["Name", "GUID", "StartingFrom", "AlterID"],
      afterAlterId: -1,
      limit: 1,
    }), { signal });
    const company = blocks(fallback, "COMPANY")[0] || fallback;
    return {
      version: 0,
      companyGuid: tag(company, "GUID") || identity.companyGuid,
      financialYear: identity.financialYear,
      highestAlterId: Number(tag(company, "ALTERID") || 0),
      reports: [],
      fallback: true,
    };
  }

  async changedMasters(identity, { masterType, afterAlterId = 0, batchSize = 50, fieldProfile = "full", signal } = {}) {
    const ledgerIdentityFields = ["Name", "GUID", "MasterID", "AlterID", "Parent"];
    const ledgerPurchaseFields = [...ledgerIdentityFields, "PartyGSTIN", "GSTIN", "GSTRegistrationNumber", "GSTRegNumber", "TaxType", "GSTDutyHead", "RateOfTaxCalculation"];
    const ledgerFullFields = [
      ...ledgerPurchaseFields, "ClosingBalance", "IsBillWiseOn", "Alias", "MailingName",
      "StateName", "CountryName", "Email", "LedgerMobile", "LedgerContact",
      "BankName", "BankAccountNumber", "BankAccountNo", "IFSCode", "BranchName", "BankAccHolderName",
    ];
    const definitions = {
      ledger: { collectionType: "Ledger", block: "LEDGER", fields:
        fieldProfile === "identity" ? ledgerIdentityFields : fieldProfile === "purchase" ? ledgerPurchaseFields : ledgerFullFields },
      stock_item: { collectionType: "Stock Item", block: "STOCKITEM", fields: [
        "Name", "GUID", "MasterID", "AlterID", "Parent", "BaseUnits", "OriginalBaseUnits",
        "GSTApplicable", "IsGSTApplicable", "GSTHSNCode", "GSTHSNName", "GSTHSNSACCode", "GSTHSNSACName", "HSNCode", "HSNSACCode", "HSNSACName", "GSTOVRDNHSNCODE", "HSNOVRDNCLASSIFICATION", "HSN", "HSNSAC", "HSNCLASSIFICATION", "GSTTaxRate", "RateOfTaxCalculation", "GSTRATE", "RateOfVAT",
      ] },
      group: { collectionType: "Group", block: "GROUP", fields: ["Name", "GUID", "MasterID", "AlterID", "Parent", "IsRevenue"] },
      unit: { collectionType: "Unit", block: "UNIT", fields: ["Name", "GUID", "MasterID", "AlterID", "OriginalName", "DecimalPlaces"] },
    };
    const definition = definitions[masterType];
    if (!definition) throw new Error(`Unsupported incremental master type: ${masterType}`);
    const xml = await this.invoke(compactCollectionEnvelope({ companyName: identity.companyName, collectionName: `KalikaAgentChanged${definition.block}`, collectionType: definition.collectionType, nativeFields: definition.fields, afterAlterId, limit: batchSize }), { signal });
    const masters = blocks(xml, definition.block).map((block) => {
      const rawClosingBalance = tag(block, "CLOSINGBALANCE") || null;
      const closingNumber = Number(String(rawClosingBalance || "").replace(/,/g, "").replace(/\s*(Dr|Cr)$/i, ""));
      const closingBalanceType = /\bCr$/i.test(String(rawClosingBalance || "")) ? "Cr" : /\bDr$/i.test(String(rawClosingBalance || "")) ? "Dr" : null;
      const taxRate = tag(block, "GSTTAXRATE") || tag(block, "RATEOFTAXCALCULATION") || tag(block, "GSTRATE") || tag(block, "RATEOFVAT") || null;
      return {
        name: tag(block, "NAME"), guid: tag(block, "GUID"), masterId: tag(block, "MASTERID"),
        alterId: Number(tag(block, "ALTERID") || 0), parent: tag(block, "PARENT"),
        gstin: tag(block, "PARTYGSTIN") || tag(block, "GSTIN") || tag(block, "GSTREGISTRATIONNUMBER") || tag(block, "GSTREGNUMBER") || null,
        alias: tag(block, "ALIAS") || null, mailingName: tag(block, "MAILINGNAME") || null,
        stateName: tag(block, "STATENAME") || null, countryName: tag(block, "COUNTRYNAME") || null,
        email: tag(block, "EMAIL") || null, phone: tag(block, "LEDGERMOBILE") || null,
        contactPerson: tag(block, "LEDGERCONTACT") || null,
        bankName: tag(block, "BANKNAME") || null,
        bankAccountNumber: tag(block, "BANKACCOUNTNUMBER") || tag(block, "BANKACCOUNTNO") || null,
        ifscCode: tag(block, "IFSCCODE") || null, branchName: tag(block, "BRANCHNAME") || null,
        accountHolderName: tag(block, "BANKACCHOLDERNAME") || null,
        // Tally Prime commonly exports the stock-item HSN/SAC entered on the
        // master as GSTHSNNAME. Keep the older tags for other Tally versions.
        hsnCode: hsnCode(block, "GSTHSNCODE", "GSTHSNSACCODE", "HSNCODE", "HSNSACCODE", "GSTOVRDNHSNCODE", "HSNOVRDNCLASSIFICATION", "HSN", "HSNSAC", "HSNCLASSIFICATION", "GSTHSNNAME", "GSTHSNSACNAME", "HSNSACNAME"),
        unitName: tag(block, "BASEUNITS") || tag(block, "ORIGINALBASEUNITS") || null,
        baseUnits: tag(block, "BASEUNITS") || null, taxRate,
        closingBalance: Number.isFinite(closingNumber) ? Math.abs(closingNumber) : null,
        closingBalanceType,
        raw: {
          tallyTag: definition.block,
          taxType: tag(block, "TAXTYPE") || null,
          gstDutyHead: tag(block, "GSTDUTYHEAD") || null,
          billWiseEnabled: /^yes$/i.test(tag(block, "ISBILLWISEON")),
          decimalPlaces: Number.isFinite(Number(tag(block, "DECIMALPLACES"))) ? Number(tag(block, "DECIMALPLACES")) : null,
          stateName: tag(block, "STATENAME") || null,
          countryName: tag(block, "COUNTRYNAME") || null,
          closingBalance: Number.isFinite(closingNumber) ? Math.abs(closingNumber) : null,
          closingBalanceType,
        },
      };
    }).filter((master) => master.name);
    return { masters, highestAlterId: masters.reduce((highest, master) => Math.max(highest, master.alterId), Number(afterAlterId || 0)), hasMore: masters.length >= batchSize };
  }

  async openBills(identity, { ledgerNames = [], dateFrom, dateTo, signal } = {}) {
    const requested = ledgerNames.map((name) => `$LedgerName = ${formulaString(name)}`).join(" OR ") || "Yes";
    const envelope = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export Data</TALLYREQUEST><TYPE>Collection</TYPE><ID>KalikaAgentOpenBills</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(identity.companyName)}</SVCURRENTCOMPANY><SVFROMDATE>${escapeXml(dateFrom || "")}</SVFROMDATE><SVTODATE>${escapeXml(dateTo || "")}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="KalikaAgentOpenBills" ISMODIFY="No"><TYPE>Bill</TYPE><CHILDOF>$$GroupSundryDebtors</CHILDOF><BELONGSTO>Yes</BELONGSTO><FETCH>Name,LedgerName,OpeningBalance,ClosingBalance,BillDate,DueDate,MasterID,AlterID</FETCH><FILTERS>KalikaAgentRequestedLedger,KalikaAgentPendingBill</FILTERS></COLLECTION><SYSTEM TYPE="Formulae" NAME="KalikaAgentRequestedLedger">${escapeXml(requested)}</SYSTEM><SYSTEM TYPE="Formulae" NAME="KalikaAgentPendingBill">NOT $$IsEmpty:$ClosingBalance AND $ClosingBalance != 0</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const xml = await this.invoke(envelope, { signal, timeoutMs: 30_000 });
    return blocks(xml, "BILL").map((block) => ({
      name: tag(block, "NAME"), ledgerName: tag(block, "LEDGERNAME") || tag(block, "PARENT"),
      billDate: tag(block, "BILLDATE") || tag(block, "DATE"), dueDate: tag(block, "DUEDATE"),
      closingBalance: tag(block, "CLOSINGBALANCE") || tag(block, "BALANCE"),
      masterId: tag(block, "MASTERID"), alterId: Number(tag(block, "ALTERID") || 0),
    })).filter((bill) => bill.name && bill.ledgerName);
  }

  async workflowVouchers(identity, { workflow, ledgerNames = [], dateFrom, dateTo, afterAlterId = 0, limit = 50, newestFirst = false, signal } = {}) {
    const ledgerFormula = ledgerNames.map((name) => `$PartyLedgerName = ${formulaString(name)}`).join(" OR ") || "Yes";
    const workflowFormula = workflow === "turnover_discount"
      ? `$VoucherTypeName = "Sales" OR $VoucherTypeName = "Credit Note"`
      : `$VoucherTypeName = "Sales" OR $VoucherTypeName = "Receipt" OR $VoucherTypeName = "Credit Note" OR $VoucherTypeName = "Debit Note" OR $VoucherTypeName = "Journal"`;
    const envelope = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export Data</TALLYREQUEST><TYPE>Collection</TYPE><ID>KalikaWorkflowVouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(identity.companyName)}</SVCURRENTCOMPANY><SVFROMDATE>${escapeXml(dateFrom || "")}</SVFROMDATE><SVTODATE>${escapeXml(dateTo || "")}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="KalikaWorkflowVouchers"><TYPE>Voucher</TYPE><FETCH>Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,AlterID,GUID,IsCancelled,Narration,Amount,AllLedgerEntries.LedgerName</FETCH><FILTERS>KalikaWorkflowType,KalikaWorkflowLedgers,KalikaWorkflowAfterAlter</FILTERS><SORT>Default:${newestFirst ? "-" : ""}$AlterID</SORT><MAXCOUNT>${Math.max(1, Math.min(50, Number(limit) || 50))}</MAXCOUNT></COLLECTION><SYSTEM TYPE="Formulae" NAME="KalikaWorkflowType">${escapeXml(workflowFormula)}</SYSTEM><SYSTEM TYPE="Formulae" NAME="KalikaWorkflowLedgers">${escapeXml(ledgerFormula)}</SYSTEM><SYSTEM TYPE="Formulae" NAME="KalikaWorkflowAfterAlter">$AlterID &gt; ${Math.max(0, Number(afterAlterId) || 0)}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const xml = await this.invoke(envelope, { signal, timeoutMs: 30_000 });
    return blocks(xml, "VOUCHER").map((block) => ({
      date: tag(block, "DATE"), effectiveDate: tag(block, "EFFECTIVEDATE"), voucherType: tag(block, "VOUCHERTYPENAME"),
      voucherNumber: tag(block, "VOUCHERNUMBER"), reference: tag(block, "REFERENCE"), partyLedgerName: tag(block, "PARTYLEDGERNAME"),
      masterId: tag(block, "MASTERID"), alterId: Number(tag(block, "ALTERID") || 0), guid: tag(block, "GUID"),
      isCancelled: /^yes$/i.test(tag(block, "ISCANCELLED")), narration: tag(block, "NARRATION"), amount: tag(block, "AMOUNT"),
      ledgerNames: blocks(block, "ALLLEDGERENTRIES.LIST").map((entry) => tag(entry, "LEDGERNAME")).filter(Boolean),
    })).filter((voucher) => voucher.alterId > Number(afterAlterId || 0) && voucher.voucherType);
  }

  async voucherIdentity(identity, { reference, voucherNumber, dateFrom, dateTo, signal } = {}) {
    const formulas = [];
    if (reference) formulas.push(`$Reference = ${formulaString(reference)}`);
    if (voucherNumber) formulas.push(`$VoucherNumber = ${formulaString(voucherNumber)}`);
    if (!formulas.length) throw new Error("Voucher identity lookup requires a deterministic reference or voucher number.");
    const envelope = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export Data</TALLYREQUEST><TYPE>Collection</TYPE><ID>KalikaVoucherIdentity</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(identity.companyName)}</SVCURRENTCOMPANY><SVFROMDATE>${escapeXml(dateFrom || "")}</SVFROMDATE><SVTODATE>${escapeXml(dateTo || "")}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="KalikaVoucherIdentity"><TYPE>Voucher</TYPE><FETCH>Date,VoucherTypeName,VoucherNumber,Reference,MasterID,AlterID,GUID,IsCancelled</FETCH><FILTERS>KalikaVoucherIdentityFilter</FILTERS></COLLECTION><SYSTEM TYPE="Formulae" NAME="KalikaVoucherIdentityFilter">${escapeXml(formulas.join(" AND "))}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const xml = await this.invoke(envelope, { signal, timeoutMs: 10_000 });
    return blocks(xml, "VOUCHER").slice(0, 10).map((block) => ({ voucherNumber: tag(block, "VOUCHERNUMBER"), reference: tag(block, "REFERENCE"), masterId: tag(block, "MASTERID"), alterId: Number(tag(block, "ALTERID") || 0), guid: tag(block, "GUID"), date: tag(block, "DATE"), voucherType: tag(block, "VOUCHERTYPENAME"), isCancelled: /^yes$/i.test(tag(block, "ISCANCELLED")) }));
  }

  async reconcile(identity, { signal } = {}) {
    return await this.capabilities(identity, { signal });
  }
}
