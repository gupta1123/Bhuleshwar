"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from '@/components/dashboard/PageHeader';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  MoreHorizontal,
  PlugZap,
  Server,
  TriangleAlert,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TallyCompanyLinkingPanel } from "@/components/tally/TallyCompanyLinkingPanel";
import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";

const DEFAULT_TALLY_URL = "http://localhost:9000";
const DEFAULT_LAN_TALLY_URL = "http://192.168.1.10:9000";
const SELECTED_CONNECTION_STORAGE_KEY = "kalika:selected-tally-connection";
const EXPECTED_MACHINE_STORAGE_PREFIX = "kalika:tally-connector-machine:";
const CONNECTION_CONTROL_STORAGE_PREFIX = "kalika:tally-connection-control:";

type TallySetupMode = "same_machine" | "lan_server";

type TallyConnection = {
  id: string;
  displayName: string;
  status: string;
  tallyUrl: string;
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  bridgeName: string | null;
  bridgeVersion: string | null;
  bridgeMachineId: string | null;
  lastHeartbeatAt: string | null;
  lastTestedAt: string | null;
  lastTallyReachable: boolean | null;
  lastCompanyLoaded: boolean | null;
  lastCompanyName: string | null;
  lastError: string | null;
  bridgeConnected?: boolean;
  tallyReachable?: boolean;
  companyLoaded?: boolean;
  heartbeatStale?: boolean;
  agentUpdate?: {
    installedVersion: string | null;
    latestVersion: string;
    minimumVersion: string;
    updateAvailable: boolean;
    updateRequired: boolean;
    downloadUrl: string;
    releaseUrl: string;
  };
};

type CompanyOption = {
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
  isActive?: boolean;
};

type ConnectionsResponse = {
  connections?: TallyConnection[];
  error?: string;
};

type CreateConnectionResponse = {
  connection?: TallyConnection;
  pairingCode?: string;
  controlToken?: string;
  error?: string;
};

type StatusResponse = {
  connection?: TallyConnection;
  error?: string;
};

type DisconnectOthersResponse = {
  connections?: TallyConnection[];
  disconnectedCount?: number;
  disconnectedConnectionIds?: string[];
  error?: string;
};

type CompaniesResponse = {
  companies?: CompanyOption[];
  selectedCompanyId?: string | null;
  error?: string;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error || `Request failed with status ${response.status}`;
}

function formatTime(value?: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getStatusLabel(connection?: TallyConnection | null) {
  if (!connection) return "Not connected";
  if (connection.status === "company_loaded") return "Company loaded";
  if (connection.status === "tally_reachable") return "Tally reachable";
  if (connection.status === "bridge_connected") return "Connector connected";
  if (connection.status === "connection_error") return "Connection error";
  if (connection.status === "waiting_for_bridge")
    return "Waiting for connector";
  return "Not connected";
}

function getStatusTone(connection?: TallyConnection | null) {
  if (!connection) return "neutral";
  if (connection.status === "company_loaded") return "success";
  if (
    connection.status === "tally_reachable" ||
    connection.status === "bridge_connected"
  )
    return "warning";
  if (connection.status === "connection_error") return "error";
  return "neutral";
}

const DEFAULT_BRIDGE_API_BASE_URL =
  "https://autodealer-workflow-465859fe2891.herokuapp.com";

function getBridgeApiBaseUrl() {
  // In local development the connector runs on the same workstation as this
  // browser. Never fall back to the hosted API here: doing so pairs the
  // desktop connector to a different connection record than localhost is
  // displaying, leaving the UI permanently "Waiting for connector".
  if (typeof window !== "undefined") {
    const { hostname, origin } = window.location;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return origin.replace(/\/+$/, "");
    }
  }
  const configuredBaseUrl = (
    process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  if (configuredBaseUrl) return configuredBaseUrl;
  return DEFAULT_BRIDGE_API_BASE_URL;
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear]
    .filter(Boolean)
    .join(" - ");
}

function buildConnectorConnectUrl(
  connection: TallyConnection,
  pairingCode: string,
  controlToken: string,
) {
  const params = new URLSearchParams({
    apiBase: getBridgeApiBaseUrl(),
    connectionId: connection.id,
    pairingCode,
    controlToken,
    tallyUrl: connection.tallyUrl || DEFAULT_TALLY_URL,
  });

  return `kalika-tally://connect?${params.toString()}`;
}

function normalizeTallyUrlInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function getSetupModeForUrl(value?: string | null): TallySetupMode {
  if (!value) return "same_machine";
  try {
    const url = new URL(normalizeTallyUrlInput(value));
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1"
      ? "same_machine"
      : "lan_server";
  } catch {
    return "lan_server";
  }
}

function openConnectorUrl(value: string) {
  window.location.assign(value);
}

function StatusCard({
  title,
  value,
  ok,
  detail,
}: {
  title: string;
  value: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-[#8a7f72]">
            {title}
          </div>
          <div className="mt-2 text-sm font-semibold text-[#1a1a1a]">
            {value}
          </div>
          <div className="mt-1 text-xs font-normal text-[#8a7f72] leading-snug">
            {detail}
          </div>
        </div>
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
            ok
              ? "bg-emerald-50 border-emerald-100 text-emerald-600"
              : "bg-amber-50 border-amber-100 text-amber-600"
          }`}
        >
          {ok ? (
            <CheckCircle2 className="h-4.5 w-4.5" />
          ) : (
            <TriangleAlert className="h-4.5 w-4.5" />
          )}
        </div>
      </div>
    </div>
  );
}

function HubCard({
  title,
  description,
  status,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  status: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="group flex min-h-[190px] w-full flex-col justify-between rounded-2xl border border-[#e5ddd0] bg-white p-6 text-left shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:border-[#cbd5e1] hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/10"
      onClick={onClick}
      type="button"
    >
      <div className="w-full">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 border border-amber-100/50 text-amber-700 transition-colors group-hover:bg-amber-100/60">
            {icon}
          </div>
          <ArrowRight className="h-5 w-5 text-[#8a7f72] transition-all duration-300 group-hover:translate-x-1 group-hover:text-[#1a1a1a]" />
        </div>
        <h3 className="text-sm font-semibold text-[#1a1a1a]">{title}</h3>
        <p className="mt-2 text-xs font-normal leading-relaxed text-[#8a7f72]">
          {description}
        </p>
      </div>
      <div className="mt-6 w-fit rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800">
        {status}
      </div>
    </button>
  );
}

interface TallyPrimeDashboardProps {
  initialView?: "home" | "connection";
}

export function TallyPrimeDashboard({ initialView = "home" }: TallyPrimeDashboardProps) {
  const router = useRouter();
  const [view, setView] = useState<"home" | "connection">(initialView);
  const [connections, setConnections] = useState<TallyConnection[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingOthers, setDisconnectingOthers] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"disconnect" | "disconnect_others" | null>(null);
  // localStorage is only read after mount so the first client render matches
  // the server render.
  const [mounted, setMounted] = useState(false);
  const [setupMode, setSetupMode] = useState<TallySetupMode>("same_machine");
  const [tallyUrlInput, setTallyUrlInput] = useState("");
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const statusRefreshInFlight = useRef(false);

  const selectedConnection =
    connections.find((connection) => connection.id === selectedId) ??
    connections[0] ??
    null;
  const selectedConnectionId = selectedConnection?.id ?? "";
  const expectedMachineId =
    mounted && selectedConnectionId
      ? window.localStorage.getItem(
          `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnectionId}`,
        )
      : null;
  const selectedControlToken =
    mounted && selectedConnectionId
      ? window.localStorage.getItem(
          `${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnectionId}`,
        )
      : null;
  const connectionBelongsToThisBrowser =
    !selectedConnection?.bridgeConnected ||
    (Boolean(selectedControlToken) &&
      (!expectedMachineId ||
        !selectedConnection?.bridgeMachineId ||
        expectedMachineId === selectedConnection.bridgeMachineId));
  const selectedCompany = connectionBelongsToThisBrowser
    ? (companies.find(
        (company) =>
          company.connectionId === selectedConnection?.id &&
          (company.isActive ||
            company.companyName.trim().toLowerCase() ===
              String(selectedConnection?.lastCompanyName ?? "")
                .trim()
                .toLowerCase()),
      ) ?? null)
    : null;
  const statusTone = connectionBelongsToThisBrowser
    ? getStatusTone(selectedConnection)
    : "error";
  const connectorActive =
    connectionBelongsToThisBrowser &&
    Boolean(selectedConnection?.bridgeConnected);
  const selectedActiveConnectionId = selectedConnection?.bridgeConnected
    ? (selectedConnection?.id ?? "")
    : "";
  const otherActiveConnectionCount = connections.filter(
    (connection) =>
      connection.bridgeConnected && connection.id !== selectedActiveConnectionId,
  ).length;
  const tallyReachable =
    connectionBelongsToThisBrowser &&
    selectedConnection?.tallyReachable === true;
  const companyLoaded =
    connectionBelongsToThisBrowser &&
    selectedConnection?.companyLoaded === true;
  const companyDetail = !connectionBelongsToThisBrowser
    ? "This connection is managed from another browser or computer. Click Reconnect to use this computer instead."
    : selectedConnection?.lastCompanyName ||
      selectedCompany?.companyName ||
      (selectedConnection?.companyLoaded
        ? "Company loaded"
        : "Company not detected yet");
  async function loadConnections(options?: { quiet?: boolean }) {
    try {
      if (!options?.quiet) {
        setLoading(true);
      }
      const response = await apiFetch("/api/tally/connections", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as ConnectionsResponse;
      const nextConnections = payload.connections ?? [];
      setConnections(nextConnections);
      const stored =
        typeof window !== "undefined"
          ? (window.localStorage.getItem(SELECTED_CONNECTION_STORAGE_KEY) ?? "")
          : "";
      const selectedConnectionId = nextConnections.some(
        (connection) => connection.id === (selectedId || stored),
      )
        ? (selectedId || stored)
        : nextConnections[0]?.id || "";
      setSelectedId(() => {
        if (typeof window !== "undefined" && selectedConnectionId) {
          window.localStorage.setItem(SELECTED_CONNECTION_STORAGE_KEY, selectedConnectionId);
        }
        return selectedConnectionId;
      });

      if (selectedConnectionId) {
        const companyResponse = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(selectedConnectionId)}`, {
          method: "GET",
          cache: "no-store",
        });
        if (companyResponse.ok) {
          const companyPayload =
            (await companyResponse.json()) as CompaniesResponse;
          setCompanies(companyPayload.companies ?? []);
        }
      } else {
        setCompanies([]);
      }
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to load Tally connections.",
      });
    } finally {
      setLoading(false);
    }
  }

  const refreshStatus = useCallback(async (connectionId: string) => {
    if (!connectionId || statusRefreshInFlight.current) return;

    statusRefreshInFlight.current = true;
    try {
      const response = await apiFetch(
        `/api/tally/connections/${connectionId}/status`,
        {
          method: "GET",
          cache: "no-store",
        },
      );
      if (response.status === 404) {
        setConnections((current) =>
          current.filter((connection) => connection.id !== connectionId),
        );
        setCompanies((current) =>
          current.filter((company) => company.connectionId !== connectionId),
        );
        setSelectedId((current) => (current === connectionId ? "" : current));
        if (typeof window !== "undefined") {
          if (
            window.localStorage.getItem(SELECTED_CONNECTION_STORAGE_KEY) ===
            connectionId
          ) {
            window.localStorage.removeItem(SELECTED_CONNECTION_STORAGE_KEY);
          }
          window.localStorage.removeItem(
            `${CONNECTION_CONTROL_STORAGE_PREFIX}${connectionId}`,
          );
          window.localStorage.removeItem(
            `${EXPECTED_MACHINE_STORAGE_PREFIX}${connectionId}`,
          );
        }
        setMessage(null);
        return;
      }
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (!payload.connection) return;

      setConnections((current) =>
        current.map((connection) =>
          connection.id === payload.connection?.id
            ? payload.connection
            : connection,
        ),
      );
    } catch (error) {
      // A single failed background poll is retried on the next tick; don't
      // leave a sticky error banner for a transient network blip.
      console.warn("Tally status refresh failed:", error);
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  async function connectConnector() {
    try {
      setCreating(true);
      setMessage(null);
      const tallyUrl =
        setupMode === "same_machine"
          ? DEFAULT_TALLY_URL
          : normalizeTallyUrlInput(tallyUrlInput);
      if (!tallyUrl) {
        throw new Error("Enter the Tally server URL or IP address.");
      }
      try {
        const parsedTallyUrl = new URL(tallyUrl);
        if (!["http:", "https:"].includes(parsedTallyUrl.protocol)) {
          throw new Error("Unsupported protocol");
        }
      } catch {
        throw new Error("Enter a valid Tally server URL.");
      }

      const response = await apiFetch("/api/tally/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName:
            setupMode === "same_machine" ? "Tally Prime" : "Tally Prime LAN",
          tallyUrl,
          reuseConnectionId:
            selectedConnection && !connectorActive ? selectedConnection.id : null,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as CreateConnectionResponse;
      if (
        !payload.connection ||
        !payload.pairingCode ||
        !payload.controlToken
      ) {
        throw new Error(
          "Connection created, but pairing details were missing.",
        );
      }

      // Reconnect may resume the same connection; replace it rather than list it twice.
      setConnections((current) => [
        payload.connection as TallyConnection,
        ...current.filter((connection) => connection.id !== payload.connection?.id),
      ]);
      setSelectedId(payload.connection.id);
      window.localStorage.setItem(
        SELECTED_CONNECTION_STORAGE_KEY,
        payload.connection.id,
      );
      window.localStorage.removeItem(
        `${EXPECTED_MACHINE_STORAGE_PREFIX}${payload.connection.id}`,
      );
      window.localStorage.setItem(
        `${CONNECTION_CONTROL_STORAGE_PREFIX}${payload.connection.id}`,
        payload.controlToken,
      );
      openConnectorUrl(
        buildConnectorConnectUrl(
          payload.connection,
          payload.pairingCode,
          payload.controlToken,
        ),
      );
      setMessage({
        tone: "success",
        text: "Connector launch requested. Approve the browser prompt if it appears.",
      });
      window.setTimeout(
        () => void refreshStatus(payload.connection?.id || ""),
        2500,
      );
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to connect Tally connector.",
      });
    } finally {
      setCreating(false);
    }
  }

  async function disconnectConnector() {
    if (!selectedConnection) return;

    try {
      setDisconnecting(true);
      setMessage(null);
      const controlToken = window.localStorage.getItem(
        `${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnection.id}`,
      );
      if (!controlToken) {
        throw new Error(
          "This connection was created in another browser. Reconnect from this browser to manage it.",
        );
      }
      const response = await apiFetch(
        `/api/tally/connections/${selectedConnection.id}/disconnect`,
        {
          method: "POST",
          headers: {
            "x-tally-control-token": controlToken,
          },
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (payload.connection) {
        setConnections((current) =>
          current.map((connection) =>
            connection.id === payload.connection?.id
              ? payload.connection
              : connection,
          ),
        );
      }
      window.localStorage.removeItem(
        `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnection.id}`,
      );
      window.localStorage.removeItem(
        `${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnection.id}`,
      );
      setMessage({
        tone: "success",
        text: "Connector disconnected.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to disconnect connector.",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  async function disconnectOtherConnectors() {
    try {
      setDisconnectingOthers(true);
      setMessage(null);
      const response = await apiFetch(
        "/api/tally/connections/disconnect-others",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            keepConnectionId: selectedActiveConnectionId || null,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as DisconnectOthersResponse;
      const disconnectedIds = payload.disconnectedConnectionIds ?? [];
      for (const connectionId of disconnectedIds) {
        window.localStorage.removeItem(
          `${EXPECTED_MACHINE_STORAGE_PREFIX}${connectionId}`,
        );
        window.localStorage.removeItem(
          `${CONNECTION_CONTROL_STORAGE_PREFIX}${connectionId}`,
        );
      }

      const nextConnections = payload.connections ?? [];
      setConnections(nextConnections);
      setSelectedId((current) => {
        if (
          selectedActiveConnectionId &&
          nextConnections.some(
            (connection) => connection.id === selectedActiveConnectionId,
          )
        ) {
          return selectedActiveConnectionId;
        }
        if (nextConnections.some((connection) => connection.id === current)) {
          return current;
        }
        return nextConnections[0]?.id || "";
      });
      setMessage({
        tone: "success",
        text:
          (payload.disconnectedCount ?? disconnectedIds.length) > 0
            ? "Other connector sessions disconnected."
            : "No other connector sessions were active.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to disconnect other connector sessions.",
      });
    } finally {
      setDisconnectingOthers(false);
    }
  }

  useEffect(() => {
    setMounted(true);
    void loadConnections();
  }, []);

  useEffect(() => {
    if (message?.tone !== "success") return;
    const timer = window.setTimeout(() => setMessage(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const tallyUrl = selectedConnection?.tallyUrl || DEFAULT_TALLY_URL;
    setTallyUrlInput(tallyUrl);
    setSetupMode(getSetupModeForUrl(tallyUrl));
  }, [selectedConnection?.id, selectedConnection?.tallyUrl]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    void refreshStatus(selectedConnectionId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus(selectedConnectionId);
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus(selectedConnectionId);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshStatus, selectedConnectionId]);

  useEffect(() => {
    if (!selectedConnection?.id) return;
    window.localStorage.setItem(
      SELECTED_CONNECTION_STORAGE_KEY,
      selectedConnection.id,
    );
  }, [selectedConnection?.id]);

  useEffect(() => {
    if (
      !selectedConnection?.id ||
      !selectedConnection.bridgeConnected ||
      !selectedConnection.bridgeMachineId
    ) {
      return;
    }
    const key = `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnection.id}`;
    if (!window.localStorage.getItem(key)) {
      window.localStorage.setItem(key, selectedConnection.bridgeMachineId);
    }
  }, [
    selectedConnection?.bridgeConnected,
    selectedConnection?.bridgeMachineId,
    selectedConnection?.id,
  ]);

  useEffect(() => {
    if (
      selectedConnection?.bridgeConnected &&
      message?.tone === "success" &&
      message.text.startsWith("Connector launch requested")
    ) {
      setMessage(null);
    }
  }, [message, selectedConnection?.bridgeConnected]);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  if (view === "home") {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
        <PageHeader sticky={false} className="mb-4" title="Tally Prime Integration"
          subtitle="Sync workflows with Tally Prime company ledgers" />

        {message ? (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-xs font-medium ${
              message.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <HubCard
            description="Configure, test, or launch the Tally desktop sync connector."
            icon={<Server className="h-5.5 w-5.5" />}
            onClick={() => setView("connection")}
            status={
              loading ? "Checking..." : getStatusLabel(selectedConnection)
            }
            title="Tally Connection"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      <PageHeader sticky={false} className="mb-4" title="Tally Connection"
        subtitle="Connect Tally Prime to sync workflows and post entries" />

      <section className="relative mb-5 max-w-5xl overflow-hidden rounded-2xl border border-[#ddd5c9] bg-white shadow-[0_10px_28px_rgba(64,51,35,0.06)]">
        <div className="absolute inset-y-0 right-0 hidden w-[42%] bg-[#f6f0e6] sm:block">
          <img
            alt=""
            className="h-full w-full object-cover opacity-90 mix-blend-multiply"
            src={selectedConnection?.companyLoaded ? "/images/tally/connection-ready.webp" : "/images/tally/connection-waiting.webp"}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-white via-white/75 to-transparent" />
        </div>
        <div className="relative px-6 sm:max-w-[68%] py-6 sm:min-h-[176px] sm:px-7 sm:py-7">
          <div className="flex items-center gap-2 text-[9px] font-extrabold uppercase tracking-[0.16em] text-[#8a7f72]">
            <span className={`h-2 w-2 rounded-full ${companyLoaded ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" : "bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.12)]"}`} />
            {companyLoaded ? "Connection ready" : connectorActive ? "Connector online" : "Setup required"}
          </div>
          <h2 className="mt-2 text-xl font-black tracking-tight text-[#1a1a1a] sm:text-2xl">
            {companyLoaded ? `Connected to ${selectedConnection?.lastCompanyName || "Tally Prime"}` : "Bring Tally Prime online"}
          </h2>
          <p className="mt-2 max-w-md text-xs font-semibold leading-5 text-[#6f6255]">
            {companyLoaded ? "Your connector, Tally Prime, and company are ready for Bhuleshwar workflows." : "Connect this workstation to sync companies, masters, and accounting entries."}
          </p>
        </div>
      </section>

      {message ? (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-xs font-medium ${
            message.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {!connectorActive ? (
        <section className="mb-5 rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-shadow duration-300 hover:shadow-[0_6px_18px_rgba(64,51,35,0.05)]">
          <div className="mb-4">
            <div className="text-xs font-medium text-[#8a7f72]">
              Tally target
            </div>
            <h3 className="mt-2 text-sm font-semibold text-[#1a1a1a]">
              Connection location
            </h3>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <button
              className={`rounded-2xl border p-4 text-left transition ${
                setupMode === "same_machine"
                  ? "border-[#1a1a1a] bg-amber-50"
                  : "border-[#e5ddd0] bg-white hover:bg-[#faf8f4]"
              }`}
              onClick={() => {
                setSetupMode("same_machine");
                setTallyUrlInput(DEFAULT_TALLY_URL);
              }}
              type="button"
            >
              <div className="text-sm font-semibold text-[#1a1a1a]">
                Same machine
              </div>
              <div className="mt-1 text-xs font-normal leading-5 text-[#8a7f72]">
                Tally and connector run on this computer.
              </div>
            </button>

            <button
              className={`rounded-2xl border p-4 text-left transition ${
                setupMode === "lan_server"
                  ? "border-[#1a1a1a] bg-amber-50"
                  : "border-[#e5ddd0] bg-white hover:bg-[#faf8f4]"
              }`}
              onClick={() => {
                setSetupMode("lan_server");
                setTallyUrlInput((current) =>
                  getSetupModeForUrl(current) === "same_machine" ? "" : current,
                );
              }}
              type="button"
            >
              <div className="text-sm font-semibold text-[#1a1a1a]">
                LAN/server
              </div>
              <div className="mt-1 text-xs font-normal leading-5 text-[#8a7f72]">
                Tally runs on another computer or server on your network.
              </div>
            </button>
          </div>

          {setupMode === "lan_server" ? (
            <div className="mt-4">
              <label
                className="text-xs font-normal text-[#8a7f72]"
                htmlFor="tally-url"
              >
                Tally server URL
              </label>
              <Input
                className="mt-2 h-11 rounded-xl border-[#d8ccbc] bg-white font-mono text-sm"
                id="tally-url"
                onChange={(event) => setTallyUrlInput(event.target.value)}
                placeholder={DEFAULT_LAN_TALLY_URL}
                value={tallyUrlInput}
              />
              <div className="mt-2 text-xs font-normal leading-5 text-[#8a7f72]">
                Use the Tally server IP or hostname reachable from the connector
                machine.
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-2xl bg-white border border-[#e5ddd0]"
            />
          ))}
        </div>
      ) : selectedConnection ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-shadow duration-300 hover:shadow-[0_6px_18px_rgba(64,51,35,0.05)]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 border border-amber-100/50 text-amber-700">
                  <Server className="h-5.5 w-5.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[#1a1a1a]">
                      {selectedConnection.displayName}
                    </h3>
                    <Badge
                      className={
                        statusTone === "success"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : statusTone === "error"
                            ? "border-red-200 bg-red-50 text-red-800"
                            : statusTone === "warning"
                              ? "border-amber-200 bg-amber-50 text-amber-800"
                              : "border-[#e5ddd0] bg-white text-[#8a7f72]"
                      }
                      variant="outline"
                    >
                      {connectionBelongsToThisBrowser
                        ? getStatusLabel(selectedConnection)
                        : "Reconnect required"}
                    </Badge>
                  </div>
                  <div className="mt-1 max-w-3xl text-xs font-medium text-[#8a7f72]">
                    {selectedCompany?.financialYear
                      ? formatCompanyOptionLabel(selectedCompany)
                      : companyDetail}
                  </div>
                </div>
              </div>

              <div className="flex w-full flex-wrap gap-2.5 lg:w-auto lg:shrink-0 lg:flex-nowrap lg:items-center lg:justify-end">
                  {!connectorActive ? (
                    <Button
                      className="w-fit whitespace-nowrap rounded-xl bg-[#2d2d2d] hover:bg-[#1a1a1a] text-xs font-medium text-white shadow-md transition-all"
                      disabled={creating}
                      onClick={() => void connectConnector()}
                      type="button"
                    >
                      {creating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      ) : (
                        <PlugZap className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Reconnect
                    </Button>
                  ) : (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button aria-label="Open connection menu" className="rounded-xl" size="icon" type="button" variant="outline"><MoreHorizontal className="h-4 w-4" /></Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-64 rounded-xl border-[#e5ddd0] p-2 shadow-xl">
                        <p className="px-2 pb-1 pt-1 text-[11px] font-semibold text-[#8a7f72]">Connection</p>
                        <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50" disabled={disconnecting} onClick={() => setConfirmAction("disconnect")} type="button"><PlugZap className="h-3.5 w-3.5" />Disconnect…</button>
                        {otherActiveConnectionCount > 0 ? <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50" disabled={disconnectingOthers} onClick={() => setConfirmAction("disconnect_others")} type="button"><PlugZap className="h-3.5 w-3.5" />Disconnect other sessions…</button> : null}
                        <div className="mt-1 border-t border-slate-100 px-2 pt-2 text-[11px] leading-4 text-[#8a7f72]">Last heartbeat {formatTime(selectedConnection.lastHeartbeatAt)}</div>
                      </PopoverContent>
                    </Popover>
                  )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <StatusCard
              detail={`Last seen ${formatTime(selectedConnection.lastHeartbeatAt)}${
                selectedConnection.agentUpdate?.updateAvailable
                  ? " · Update available: open Bhuleshwar Local Agent → ⋮ → Connector updates"
                  : ""
              }`}
              ok={connectorActive}
              title="Connector"
              value={connectorActive ? "Online" : "Waiting"}
            />
            <StatusCard
              detail={`Last checked: ${formatTime(selectedConnection.lastTestedAt)}`}
              ok={tallyReachable}
              title="Tally"
              value={tallyReachable ? "Reachable" : "Not reachable"}
            />
            <StatusCard
              detail={
                connectionBelongsToThisBrowser
                  ? selectedConnection.lastCompanyName ||
                    selectedConnection.lastError ||
                    companyDetail
                  : companyDetail
              }
              ok={companyLoaded}
              title="Company"
              value={companyLoaded ? "Loaded" : "Not detected"}
            />
          </div>
          {connectorActive ? (
            <>
              <TallyCompanyLinkingPanel connectionId={selectedConnection.id} onLinked={() => loadConnections({ quiet: true })} />
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-[260px] items-center justify-center rounded-2xl border border-[#e5ddd0] bg-white p-8 text-center shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-shadow duration-300 hover:shadow-[0_6px_18px_rgba(64,51,35,0.05)]">
          <div>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 border border-amber-200/50 text-amber-700">
              <PlugZap className="h-6 w-6 animate-pulse" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-[#1a1a1a]">
              No Tally connection found
            </h3>
            <p className="mt-1.5 text-xs font-normal text-[#8a7f72] max-w-sm">
            Install and open Bhuleshwar Local Agent on this computer, then connect
              it to Tally Prime to sync ledgers.
            </p>
            <Button
              className="mt-6 rounded-xl bg-[#2d2d2d] hover:bg-[#1a1a1a] px-6 py-5 text-xs font-medium text-white shadow-md transition-all"
              disabled={creating}
              onClick={() => void connectConnector()}
              type="button"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <PlugZap className="h-3.5 w-3.5 mr-1.5" />
              )}
              Connect Tally Prime
            </Button>
          </div>
        </div>
      )}
      <CaseConfirmDialog
        confirmLabel={confirmAction === "disconnect_others" ? "Disconnect others" : "Disconnect"}
        description={
          confirmAction === "disconnect_others"
            ? `${otherActiveConnectionCount} other active connector session${otherActiveConnectionCount === 1 ? "" : "s"} will stop and must reconnect from their own computer.`
            : "Bhuleshwar workflows that use Tally will stop. You will need to click Reconnect and approve the Local Agent again."
        }
        footnote={null}
        loading={disconnecting || disconnectingOthers}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action === "disconnect") void disconnectConnector();
          if (action === "disconnect_others") void disconnectOtherConnectors();
        }}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
        open={confirmAction !== null}
        title={confirmAction === "disconnect_others" ? "Disconnect other sessions?" : "Disconnect Tally?"}
      />
    </div>
  );
}
