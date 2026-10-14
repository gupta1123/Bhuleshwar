import { normalizeAiBankStatement, normalizeName, correctPreviewRowsFromRunningBalance } from './bank-preview-normalization.mjs';
import { validateRunningBalanceContinuity } from '../../../worker/bank-statement-balance-validation.mjs';
import { normalizeAccountNumber, maskAccountNumber } from './bank-preview-normalization.mjs';

export function markBankLedgerRecommendationsUnavailable(rows, reason, status = "unavailable") {
  return rows.map((row) => {
    const rawPayload =
      row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
        ? row.raw_payload
        : {};
    return {
      ...row,
      suggested_ledger_name: null,
      suggestion_confidence: null,
      suggestion_reason: reason,
      raw_payload: {
        ...rawPayload,
        aiLedgerRecommendation: {
          matchType: "suspense",
          action: "use_suspense",
          ledgerName: null,
          candidateLedgerNames: [],
          confidence: null,
          reason,
          model: null,
          source: "none",
          status,
        },
      },
    };
  });
}

export function prepareLocalPreview(local, ledgerNames) {
  const extraction = validateLocalBalances(prepareLocalExtraction(local));
  const { parsed, diagnostics, extractionError, extractionSource } = extraction;
  const extractionIncomplete = Boolean(extractionError) || diagnostics.coverageComplete === false;
  const ledgerRecommendationError = extractionIncomplete
    ? 'Ledger matching is paused because one or more statement pages still need extraction review.' : null;
  const rows = extractionIncomplete
    ? markBankLedgerRecommendationsUnavailable(parsed.transactions, ledgerRecommendationError, 'deferred')
    : markCombinedLedgerRecommendationsCompleted(parsed.transactions, ledgerNames);
  return {
    rows, account: parsed.account, normalizedAccountNumber: normalizeAccountNumber(parsed.account.accountNumber),
    statementPeriodStart: parsed.statementPeriodStart, statementPeriodEnd: parsed.statementPeriodEnd, extractionIncomplete,
    metadata: { parser: 'openrouter_bank_statement_v1', extractionSource, jobStatus: 'completed', extractionError,
      extractionDiagnostics: diagnostics, ledgerRecommendationError, ledgerRecommendationIncompleteCount: extractionIncomplete ? rows.length : 0,
      normalizedAccountNumber: normalizeAccountNumber(parsed.account.accountNumber), maskedAccountNumber: maskAccountNumber(parsed.account.accountNumber),
      ifscCode: parsed.account.ifscCode, previewTransactionCount: rows.length,
      analysis: { stage: rows.length && !extractionIncomplete ? 'Statement analyzed' : 'Extraction needs attention',
        extractedStatementPeriodStart: parsed.statementPeriodStart, extractedStatementPeriodEnd: parsed.statementPeriodEnd } },
  };
}

export function markCombinedLedgerRecommendationsCompleted(rows, ledgerNames = [], model = process.env.OPENROUTER_ANYDOC_MODEL || 'openai/gpt-5.6-luna') {
  const allowed = new Set(ledgerNames.map((name) => normalizeName(name)).filter(Boolean));
  return rows.map((row) => {
    const rawPayload =
      row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
        ? row.raw_payload
        : {};
    const suggestedLedgerName = allowed.has(normalizeName(row.suggested_ledger_name))
      ? row.suggested_ledger_name
      : null;
    return {
      ...row,
      suggested_ledger_name: suggestedLedgerName,
      raw_payload: {
        ...rawPayload,
        aiLedgerRecommendation: {
          matchType: suggestedLedgerName ? "direct_match" : "suspense",
          action: suggestedLedgerName ? "use_existing_ledger" : "use_suspense",
          ledgerName: suggestedLedgerName,
          candidateLedgerNames: [],
          confidence: row.suggestion_confidence ?? 0,
          reason: row.suggestion_reason || null,
          model,
          source: "combined_ai_match",
          status: "completed",
        },
      },
    };
  });
}

export function prepareLocalExtraction(local) {
  const parsed = normalizeAiBankStatement(local.data);
  const coverageVerified = local.diagnostics?.coverage?.complete === true && local.diagnostics.coverage.sourceRows === parsed.transactions.length;
  parsed.transactions = parsed.transactions.map((transaction, index) => {
    const sourcePage = transaction.raw_payload?.row?.sourcePage;
    return { ...transaction, raw_payload: { ...transaction.raw_payload,
      vectorLedgerCandidates: local.diagnostics?.vectorCandidates?.[index] || [], extractionProvenance: {
      startPage: sourcePage || null, endPage: sourcePage || null, sourceIndex: index, method: 'local_agent_markdown_source_rows_v1',
    } } };
  });
  const connectorVector = local.diagnostics?.mode === 'connector_anydoc_vector_v1';
  return { parsed, extractionSource: connectorVector ? 'connector_anydoc_vector_v1' : 'anydoc_markdown_combined_ai',
    extractionError: coverageVerified ? null : 'Source transaction coverage could not be verified. Review is required before posting.',
    diagnostics: { pipeline: connectorVector ? 'connector_anydoc_vector_v1' : 'local_agent_markdown_combined_ai', localParsing: local.diagnostics,
      connectorParser: local.diagnostics?.parserDiagnostics || null, vectorCandidateCount: local.diagnostics?.vectorCandidateCount || 0,
      connectorTiming: local.diagnostics?.connectorMeasurements || null, coverageComplete: coverageVerified,
      errors: coverageVerified ? [] : ['Source transaction coverage could not be verified.'] } };
}

export function validateLocalBalances(extraction) {
  const parsed = extraction.parsed;
  let balance = validateRunningBalanceContinuity(parsed.transactions, parsed.openingBalance);
  if (balance.orientation === 'reverse') {
    parsed.transactions = correctPreviewRowsFromRunningBalance([...parsed.transactions].reverse(), parsed.openingBalance).reverse();
    balance = validateRunningBalanceContinuity(parsed.transactions, parsed.openingBalance);
    balance.correctedForReverseOrder = true;
  }
  extraction.diagnostics.balanceValidation = balance;
  if (!balance.valid) {
    extraction.diagnostics.coverageComplete = false;
    extraction.diagnostics.unresolvedPages = [...new Set([...(Array.isArray(extraction.diagnostics.unresolvedPages) ? extraction.diagnostics.unresolvedPages : []), ...balance.breaks.map(x => x.page).filter(Number.isFinite)])].sort((a,b) => a-b);
    extraction.extractionError = `Running-balance validation failed at ${balance.breaks.length} transaction${balance.breaks.length === 1 ? '' : 's'}.`;
  }
  return extraction;
}




