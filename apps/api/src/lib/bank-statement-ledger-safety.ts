export type LedgerIdentity = {
  name: string;
  parent?: string | null;
};

export type GroupIdentity = {
  name: string;
  parent?: string | null;
};

function normalizeLedgerIdentity(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function isSuspenseLedgerIdentity(ledger: LedgerIdentity) {
  return (
    normalizeLedgerIdentity(ledger.name).includes("suspense") ||
    normalizeLedgerIdentity(ledger.parent).includes("suspense")
  );
}

export function resolveCompanySuspenseLedgerName(ledgers: LedgerIdentity[]) {
  const candidates = ledgers.filter(isSuspenseLedgerIdentity);
  const exactSuspense = candidates.filter(
    (ledger) => normalizeLedgerIdentity(ledger.name) === "suspense"
  );
  if (exactSuspense.length === 1) return exactSuspense[0].name;

  const exactBankStatementSuspense = candidates.filter(
    (ledger) => normalizeLedgerIdentity(ledger.name) === "bankstatementsuspense"
  );
  if (exactBankStatementSuspense.length === 1) return exactBankStatementSuspense[0].name;

  return candidates.length === 1 ? candidates[0].name : null;
}

export function activeLedgerNameSet(ledgers: LedgerIdentity[]) {
  return new Set(ledgers.map((ledger) => normalizeLedgerIdentity(ledger.name)).filter(Boolean));
}

export function activeLedgerContains(names: Set<string>, ledgerName?: string | null) {
  const normalized = normalizeLedgerIdentity(ledgerName);
  return Boolean(normalized && names.has(normalized));
}

export function masterParentDescendsFromGroup(
  parentName: string | null | undefined,
  groups: GroupIdentity[],
  targetGroupName: string
) {
  const target = normalizeLedgerIdentity(targetGroupName);
  const parentByName = new Map(
    groups
      .map((group) => [normalizeLedgerIdentity(group.name), group.parent ?? null] as const)
      .filter(([name]) => Boolean(name))
  );
  const visited = new Set<string>();
  let currentName: string | null | undefined = parentName;

  while (currentName) {
    const normalized = normalizeLedgerIdentity(currentName);
    if (!normalized || visited.has(normalized)) return false;
    if (normalized === target) return true;
    visited.add(normalized);
    currentName = parentByName.get(normalized) ?? null;
  }

  return false;
}

export function classifyPartyLedgerFromGroups(
  ledger: LedgerIdentity,
  groups: GroupIdentity[]
): "customer" | "supplier" | "other" {
  if (masterParentDescendsFromGroup(ledger.parent, groups, "Sundry Debtors")) {
    return "customer";
  }
  if (masterParentDescendsFromGroup(ledger.parent, groups, "Sundry Creditors")) {
    return "supplier";
  }
  return "other";
}


