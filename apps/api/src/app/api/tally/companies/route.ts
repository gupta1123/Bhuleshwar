import { withTeamAccess } from '@/lib/access/route-boundary';
import {permittedConnections} from '@/lib/access/connection-scope';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode, LOCAL_USER_ID } from "@/lib/local/mode";
import { listLocalTallyConnections } from "@/lib/local/tally-store";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import fs from "node:fs";
import path from "node:path";

type TallyConnectionWithSync = TallyConnectionRow & {
  latestSync?: LatestSyncRow | null;
};

type LatestSyncRow = {
  connection_id: string;
  company_name: string | null;
  completed_at: string | null;
  totals: Record<string, unknown> | null;
};

type HeartbeatEventRow = {
  connection_id: string;
  created_at: string | null;
  payload: Record<string, unknown> | null;
};

type HeartbeatCompany = {
  companyName: string;
  guid: string | null;
  financialYear: string | null;
  financialYearStart: string | null;
  booksFrom: string | null;
  currentPeriod: string | null;
  isActive: boolean;
};

type LocalTallyCompany = {
  companyName: string;
  bankLedgers: Array<{
    name: string;
    parent: string | null;
    bankName: string | null;
    bankAccountNumber: string | null;
  }>;
};

function isGenericTallyLabel(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    !normalized ||
    normalized === "tally" ||
    normalized === "tally prime" ||
    /^tally(?: prime)?\s*[-–]\s*(?:current year|\d{4}[-–]\d{2})$/.test(normalized)
  );
}

function virtualCompanyId(connectionId: string, companyName: string) {
  return `${connectionId}::${encodeURIComponent(companyName)}`;
}

function serializeCompany(
  connection: TallyConnectionWithSync,
  companyName: string,
  metadata?: HeartbeatCompany | null
) {
  const status = serializeTallyConnectionStatus(connection);
  const latestSync = connection.latestSync ?? null;
  const totals = latestSync?.totals && typeof latestSync.totals === "object" ? latestSync.totals : {};
  const bankAccountCount =
    typeof totals.bank_ledger === "number"
      ? totals.bank_ledger
      : typeof totals.ledger === "number"
        ? null
        : null;

  return {
    id: virtualCompanyId(connection.id, companyName),
    connectionId: connection.id,
    companyName,
    // Never manufacture a financial year from the API server clock. It must
    // come from this exact company in the live Tally heartbeat.
    financialYear: metadata?.financialYear ?? "",
    financialYearStart: metadata?.financialYearStart ?? null,
    booksFrom: metadata?.booksFrom ?? null,
    currentPeriod: metadata?.currentPeriod ?? null,
    companyGuid: metadata?.guid ?? null,
    isActive:
      status.bridgeConnected &&
      status.tallyReachable &&
      status.companyLoaded &&
      (metadata?.isActive === true ||
        companyName.trim().toLowerCase() === String(status.lastCompanyName ?? "").trim().toLowerCase()),
    status: status.status,
    bridgeConnected: status.bridgeConnected,
    tallyReachable: status.tallyReachable,
    companyLoaded: status.companyLoaded,
    bankAccountCount,
    lastSyncAt: latestSync?.completed_at ?? null,
    lastHeartbeatAt: connection.last_heartbeat_at,
    lastError: connection.last_error,
  };
}

function withLocalBankLedgers<T extends { companyName: string }>(
  company: T,
  localTallyCompanies: LocalTallyCompany[]
) {
  const local = localTallyCompanies.find(
    (entry) => entry.companyName.trim().toLowerCase() === company.companyName.trim().toLowerCase()
  );
  return {
    ...company,
    bankLedgers: local?.bankLedgers ?? [],
    bankAccountCount: local?.bankLedgers.length ?? ("bankAccountCount" in company ? company.bankAccountCount : null),
  };
}

function timestampValue(value: string | null | undefined) {
  return value ? new Date(value).getTime() || 0 : 0;
}

function normalizedCompanyNames(values: unknown[]) {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const value of values) {
    let name: unknown = value;
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      name = row.companyName ?? row.name;
    }
    if (typeof name !== "string") continue;
    const normalized = name.trim();
    if (!normalized || isGenericTallyLabel(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(normalized);
  }

  return names;
}

function nullablePayloadText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function companiesFromPayload(payload: Record<string, unknown> | null | undefined): HeartbeatCompany[] {
  if (!payload || typeof payload !== "object") return [];
  const rawCompanies = payload.companies ?? payload.availableCompanies;
  const companyRows = Array.isArray(rawCompanies) ? rawCompanies : [];

  const activeCompanyName =
    nullablePayloadText(payload.heartbeatCompanyName) ?? nullablePayloadText(payload.companyName);
  const seen = new Set<string>();
  const companies: HeartbeatCompany[] = [];

  for (const value of companyRows) {
    const row =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : ({ companyName: value } as Record<string, unknown>);
    const companyName = nullablePayloadText(row.companyName ?? row.name);
    if (!companyName || isGenericTallyLabel(companyName)) continue;
    const key = companyName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({
      companyName,
      guid: nullablePayloadText(row.guid),
      financialYear: nullablePayloadText(row.financialYear),
      financialYearStart: nullablePayloadText(row.financialYearStart),
      booksFrom: nullablePayloadText(row.booksFrom),
      currentPeriod: nullablePayloadText(row.currentPeriod),
      isActive:
        key === activeCompanyName?.toLowerCase() ||
        (row.isActive === true && Boolean(activeCompanyName)),
    });
  }

  if (activeCompanyName && !isGenericTallyLabel(activeCompanyName) && !seen.has(activeCompanyName.toLowerCase())) {
    companies.unshift({
      companyName: activeCompanyName,
      guid: null,
      financialYear: null,
      financialYearStart: null,
      booksFrom: null,
      currentPeriod: null,
      isActive: true,
    });
  }

  return companies;
}

function tallyDataRoots() {
  return normalizedCompanyNames([
    process.env.KALIKA_TALLY_DATA_ROOT,
    process.env.TALLY_DATA_ROOT,
    process.env.TALLY_DATA_PATH,
    path.join(process.env.PUBLIC || "C:\\Users\\Public", "TallyPrime", "data"),
  ]);
}

function extractReadableTallyStrings(text: string) {
  return [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9 .&()/_-]{1,78}/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isLikelyTallyCompanyName(value: string) {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();

  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (lower.includes("company features")) return false;
  if (lower === "company" || lower === "tally" || lower === "tally prime") return false;
  if (lower.startsWith("alter ") || lower.startsWith("create ")) return false;
  return /[a-z]/i.test(normalized);
}

function readTallyCompanyNameFromFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    const candidates = [
      ...extractReadableTallyStrings(buffer.toString("utf16le")),
      ...extractReadableTallyStrings(buffer.toString("latin1")),
    ];
    return candidates.find(isLikelyTallyCompanyName) ?? null;
  } catch {
    return null;
  }
}

function extractLocalBankLedgers(companyDir: string) {
  const candidateFiles = ["Manager.1800", "Index.1800", "TMESSAGE.TSF", "Company.1800", "CmpSave.1800"];
  const candidates: string[] = [];

  for (const fileName of candidateFiles) {
    try {
      const filePath = path.join(companyDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const buffer = fs.readFileSync(filePath);
      candidates.push(
        ...extractReadableTallyStrings(buffer.toString("utf16le")),
        ...extractReadableTallyStrings(buffer.toString("latin1"))
      );
    } catch {
      // Keep local fallback best-effort.
    }
  }

  const names = normalizedCompanyNames(candidates.map(cleanLocalTallyLabel)).filter((candidate) => {
    const lower = candidate.toLowerCase();
    if (!lower.includes("bank")) return false;
    if (lower.includes("bank charges")) return false;
    if (lower.includes("bank statement suspense")) return false;
    if (lower.includes("bank accounts")) return false;
    if (lower.includes("bank od")) return false;
    if (lower.includes("bank occ")) return false;
    if (lower.includes("cash-in-hand")) return false;
    if (lower.includes("connectedbanking")) return false;
    if (lower.includes("tallyconnect")) return false;
    if (lower.length < 5 || lower.length > 80) return false;
    return /\d{4,}/.test(candidate) || /\b(kotak|hdfc|icici|axis|sbi|yes|idfc|indusind|mahindra)\b/i.test(candidate);
  });

  return names.map((name) => ({
    name,
    parent: "Bank Accounts",
    bankName: name.replace(/\s*[-–]\s*\*?\d[\d* ]*$/, "").trim() || name,
    bankAccountNumber: name.match(/\d{4,}/)?.[0] ?? null,
  }));
}

function cleanLocalTallyLabel(value: string) {
  return value
    .replace(/^[0-9A-Z](?=(?:Kotak|HDFC|ICICI|Axis|SBI|YES|IDFC|IndusInd|Mahindra)\b)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readLocalTallyCompanies() {
  const companies: LocalTallyCompany[] = [];

  for (const dataRoot of tallyDataRoots()) {
    try {
      if (!fs.existsSync(dataRoot)) continue;
      for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const companyDir = path.join(dataRoot, entry.name);
        const companyName =
          readTallyCompanyNameFromFile(path.join(companyDir, "Company.1800")) ??
          readTallyCompanyNameFromFile(path.join(companyDir, "CmpSave.1800"));
        if (companyName) {
          companies.push({
            companyName,
            bankLedgers: extractLocalBankLedgers(companyDir),
          });
        }
      }
    } catch {
      // Local Tally data is a best-effort fallback for desktop development.
    }
  }

  const seen = new Set<string>();
  return companies.filter((company) => {
    const key = company.companyName.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: LOCAL_USER_ID } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }
    const connectionId = new URL(request.url).searchParams
      .get("connectionId")
      ?.trim();
    if (!connectionId) {
      return jsonWithCors(
        request,
        { error: "Select a Tally connector before loading companies." },
        { status: 400 }
      );
    }

    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const {links,rows}=await permittedConnections(request,connectionId);
      const companies=links.flatMap(link=>{
        const row=rows.find(row=>row.id===link.connection_id);
        if(!row)return [];
        return [{...serializeCompany(row,link.company_name,{companyName:link.company_name,guid:link.company_guid,
          financialYear:link.financial_year,financialYearStart:null,booksFrom:null,currentPeriod:null,isActive:row.last_company_name===link.company_name}),
          id:`${link.connection_id}::${link.company_guid}::${link.financial_year}`,accessCompanyId:link.company_id}];
      });
      return jsonWithCors(request,{companies},{headers:{'Cache-Control':'private, no-store'}});
    }

    if (localMode) {
      const localTallyCompanies = readLocalTallyCompanies();
      const companies = (await listLocalTallyConnections(user.id))
        .filter((connection) => connection.id === connectionId)
        .flatMap((connection) => {
          const status = serializeTallyConnectionStatus(connection);
          const companyName = status.lastCompanyName?.trim();
          if (
            !status.bridgeConnected ||
            !status.tallyReachable ||
            !status.companyLoaded ||
            !companyName ||
            isGenericTallyLabel(companyName)
          ) {
            return [];
          }
          return [
            withLocalBankLedgers(
              serializeCompany(connection, companyName, {
                companyName,
                guid: null,
                financialYear: null,
                financialYearStart: null,
                booksFrom: null,
                currentPeriod: null,
                isActive: true,
              }),
              localTallyCompanies
            ),
          ];
        })
        .sort(
          (left, right) =>
            timestampValue(right.lastHeartbeatAt) -
            timestampValue(left.lastHeartbeatAt)
        );

      return jsonWithCors(request, {
        companies,
        selectedCompanyId: companies[0]?.id ?? null,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("owner_user_id", user.id)
      .eq("id", connectionId)
      .is("revoked_at", null)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const connections = (data ?? []) as unknown as TallyConnectionRow[];
    const connectionIds = connections.map((connection) => connection.id);
    const latestSyncByConnection = new Map<string, LatestSyncRow>();
    const latestHeartbeatByConnection = new Map<string, HeartbeatEventRow>();
    const localTallyCompanies: LocalTallyCompany[] = [];

    if (connectionIds.length > 0) {
      const { data: syncRows, error: syncError } = await supabase
        .from("tally_master_sync_runs")
        .select("connection_id, company_name, completed_at, totals")
        .eq("owner_user_id", user.id)
        .in("connection_id", connectionIds)
        .order("created_at", { ascending: false })
        .limit(100);

      if (syncError) throw syncError;

      for (const row of (syncRows ?? []) as unknown as LatestSyncRow[]) {
        if (!latestSyncByConnection.has(row.connection_id)) {
          latestSyncByConnection.set(row.connection_id, row);
        }
      }

      const legacyConnectionIds = connections
        .filter(
          (connection) =>
            !Array.isArray(connection.last_companies_snapshot) ||
            connection.last_companies_snapshot.length === 0
        )
        .map((connection) => connection.id);
      if (legacyConnectionIds.length > 0) {
        const { data: eventRows, error: eventError } = await supabase
          .from("tally_connection_events")
          .select("connection_id, created_at, payload")
          .eq("owner_user_id", user.id)
          .in("connection_id", legacyConnectionIds)
          .eq("event_type", "bridge_heartbeat")
          .order("created_at", { ascending: false })
          .limit(200);

        if (eventError) throw eventError;

        for (const row of (eventRows ?? []) as unknown as HeartbeatEventRow[]) {
          if (!latestHeartbeatByConnection.has(row.connection_id)) {
            latestHeartbeatByConnection.set(row.connection_id, row);
          }
        }
      }
    }

    const companyEntries = connections.flatMap((connection) => {
      const latestSync = latestSyncByConnection.get(connection.id) ?? null;
      const status = serializeTallyConnectionStatus(connection);
      const latestHeartbeat = latestHeartbeatByConnection.get(connection.id) ?? null;
      const heartbeatAt = timestampValue(connection.last_heartbeat_at);
      const heartbeatFresh =
        heartbeatAt > 0 && Date.now() - heartbeatAt <= 45_000;
      if (
        !heartbeatFresh ||
        !status.bridgeConnected ||
        !status.tallyReachable
      ) {
        return [];
      }
      const heartbeatCompanies =
        Array.isArray(connection.last_companies_snapshot) &&
        connection.last_companies_snapshot.length > 0
          ? companiesFromPayload({ companies: connection.last_companies_snapshot })
          : companiesFromPayload(latestHeartbeat?.payload);

      return heartbeatCompanies.map((metadata) => ({
        company: serializeCompany(
          {
            ...connection,
            latestSync,
          },
          metadata.companyName,
          metadata
        ),
        hasSpecificName: !isGenericTallyLabel(metadata.companyName),
        updatedAt: connection.updated_at,
      }));
    });

    companyEntries.sort((a, b) => {
      const activeDiff =
        Number(b.company.isActive) - Number(a.company.isActive);
      if (activeDiff !== 0) return activeDiff;
      return timestampValue(b.updatedAt) - timestampValue(a.updatedAt);
    });
    const companies = companyEntries.map((entry) =>
      withLocalBankLedgers(entry.company, localTallyCompanies)
    );

    return jsonWithCors(request, {
      companies,
      selectedCompanyId:
        companyEntries.find((entry) => entry.company.isActive)?.company.id ??
        companies[0]?.id ??
        null,
    });
  } catch (error) {
    console.error("Error in GET /api/tally/companies:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
