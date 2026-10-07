"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Cable,
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  Play,
  Power,
  RefreshCw,
  Terminal,
  Wifi,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api-client";

const WINDOWS_BRIDGE_ROOT = "C:\\Autodealer\\tally-bridge";
const DEFAULT_TALLY_URL = "http://localhost:9000";
const DEFAULT_UTM_API_BASE =
  process.env.NEXT_PUBLIC_TALLY_CONNECT_API_BASE || "http://192.168.1.34:3001";

type TallyConnection = {
  id: string;
  displayName: string;
  tallyUrl: string;
};

type CreateConnectionResponse = {
  connection?: TallyConnection;
  pairingCode?: string;
  controlToken?: string;
  error?: string;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function getDefaultApiBase() {
  if (typeof window === "undefined") return DEFAULT_UTM_API_BASE;
  const { hostname } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return DEFAULT_UTM_API_BASE;
  }
  return `${window.location.protocol}//${hostname}:3001`;
}

function escapeCommandValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function CommandRow({
  label,
  command,
  icon: Icon = Terminal,
}: {
  label: string;
  command: string;
  icon?: typeof Terminal;
}) {
  const [copied, setCopied] = useState(false);

  const copyCommand = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="rounded-lg border border-[#d9e2dd] bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[#edf1ee] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[#e7f4ed] text-[#147a4f]">
            <Icon className="h-4 w-4" />
          </span>
          <span className="truncate text-sm font-bold text-[#1f2a24]">{label}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-8 shrink-0 rounded-md border-[#cbd8d1] px-3 text-xs font-bold text-[#496257] hover:bg-[#f3f7f5]"
          onClick={copyCommand}
        >
          {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Clipboard className="mr-1.5 h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 text-left text-xs font-semibold leading-6 text-[#25372f]">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function CodeValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyValue = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="rounded-lg border border-[#edf1ee] bg-[#f8faf8] p-4">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[#6a7c73]">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div className="min-h-10 flex-1 rounded-md border border-[#d9e2dd] bg-white px-3 py-2 font-mono text-xs font-bold text-[#17211c]">
          {value || "Generate codes"}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!value}
          className="h-10 rounded-md border-[#cbd8d1] px-3 text-xs font-bold text-[#496257] hover:bg-[#f3f7f5]"
          onClick={copyValue}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

export default function TallyConnectPage() {
  const [apiBase, setApiBase] = useState(DEFAULT_UTM_API_BASE);
  const [tallyUrl, setTallyUrl] = useState(DEFAULT_TALLY_URL);
  const [companyName, setCompanyName] = useState("");
  const [connection, setConnection] = useState<TallyConnection | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [controlToken, setControlToken] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setApiBase(getDefaultApiBase());
  }, []);

  const normalizedTallyUrl = useMemo(() => normalizeUrl(tallyUrl) || DEFAULT_TALLY_URL, [tallyUrl]);
  const hasCodes = Boolean(connection?.id && pairingCode && controlToken);
  const safeCompanyName = companyName.trim() || connection?.displayName || "Tally Prime";
  const escapedApiBase = escapeCommandValue(apiBase);
  const escapedTallyUrl = escapeCommandValue(normalizedTallyUrl);
  const escapedCompanyName = escapeCommandValue(safeCompanyName);
  const escapedControlToken = escapeCommandValue(controlToken);
  const connectionCode = connection?.id ?? "";

  const windowsCommands = hasCodes
    ? [
        {
          id: "open-project",
          label: "Open the bridge folder",
          command: `cd "${WINDOWS_BRIDGE_ROOT}"`,
          icon: Terminal,
        },
        {
          id: "test-tally",
          label: "Check Tally reachability",
          command: `npm.cmd run test -- --tally-url "${escapedTallyUrl}" --company-name "${escapedCompanyName}"`,
          icon: Wifi,
        },
        {
          id: "pair",
          label: "Pair the bridge",
          command: `npm.cmd run pair -- --api-base "${escapedApiBase}" --connection-id "${connectionCode}" --pairing-code "${pairingCode}" --control-token "${escapedControlToken}" --tally-url "${escapedTallyUrl}" --company-name "${escapedCompanyName}"`,
          icon: Cable,
        },
        {
          id: "start",
          label: "Start live connector",
          command: `npm.cmd run start -- --tally-url "${escapedTallyUrl}" --company-name "${escapedCompanyName}"`,
          icon: Play,
        },
        {
          id: "sync",
          label: "Sync Tally masters",
          command: `npm.cmd run sync -- --tally-url "${escapedTallyUrl}" --company-name "${escapedCompanyName}"`,
          icon: RefreshCw,
        },
        {
          id: "disconnect",
          label: "Disconnect local bridge",
          command: "npm.cmd run disconnect",
          icon: Power,
        },
      ]
    : [];

  const createConnection = async () => {
    try {
      setCreating(true);
      setMessage(null);
      const nextTallyUrl = normalizeUrl(tallyUrl);

      if (!nextTallyUrl) {
        throw new Error("Enter the Tally URL before generating codes.");
      }

      const nextApiBase = normalizeUrl(apiBase);
      if (!nextApiBase) {
        throw new Error("Enter the API base before generating codes.");
      }

      const response = await apiFetch("/api/tally/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: companyName.trim() || "Tally Prime",
          tallyUrl: nextTallyUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as CreateConnectionResponse;
      if (!payload.connection || !payload.pairingCode || !payload.controlToken) {
        throw new Error("Connection was created, but pairing details were missing.");
      }

      setConnection(payload.connection);
      setPairingCode(payload.pairingCode);
      setControlToken(payload.controlToken);
      setApiBase(nextApiBase);
      setTallyUrl(payload.connection.tallyUrl || nextTallyUrl);
      setMessage({ tone: "success", text: "Connection code, pairing code and control token generated." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to generate Tally connection codes.",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppShell>
      <div className="min-h-screen bg-[#f6f8f6] px-4 py-6 text-[#1f2a24] sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <section className="rounded-lg border border-[#d9e2dd] bg-white px-6 py-7 shadow-sm sm:px-8">
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-[#cfe3d8] bg-[#eef8f3] px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-[#147a4f]">
              <Cable className="h-3.5 w-3.5" />
              Local Tally bridge
            </div>
            <h1 className="max-w-2xl text-3xl font-extrabold tracking-tight text-[#17211c] sm:text-4xl">
              Connect Kalika to Tally from this Mac
            </h1>
            <p className="mt-4 max-w-3xl text-sm font-medium leading-7 text-[#52645b]">
              Generate a real connection code, pairing code and control token, then run the PowerShell commands below inside the UTM Windows machine while Tally Prime is open and the target company is loaded.
            </p>
          </section>

          <section className="rounded-lg border border-[#d9e2dd] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#17211c]">Connection Details</h2>
                <p className="mt-1 text-sm font-medium text-[#65766d]">
                  Fill these once. The commands update with the generated codes.
                </p>
              </div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#e7f4ed] text-[#147a4f]">
                <KeyRound className="h-5 w-5" />
              </span>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#6a7c73]">
                  API base
                </span>
                <Input
                  className="mt-2 h-11 rounded-md border-[#d9e2dd] bg-white font-mono text-xs font-semibold"
                  value={apiBase}
                  onChange={(event) => setApiBase(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#6a7c73]">
                  Tally URL
                </span>
                <Input
                  className="mt-2 h-11 rounded-md border-[#d9e2dd] bg-white font-mono text-xs font-semibold"
                  value={tallyUrl}
                  onChange={(event) => setTallyUrl(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#6a7c73]">
                  Company name
                </span>
                <Input
                  className="mt-2 h-11 rounded-md border-[#d9e2dd] bg-white font-mono text-xs font-semibold"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                />
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                type="button"
                disabled={creating}
                className="h-11 rounded-md bg-[#147a4f] px-5 text-sm font-bold text-white hover:bg-[#0f6741]"
                onClick={createConnection}
              >
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Cable className="mr-2 h-4 w-4" />}
                Generate connection and pairing codes
              </Button>
              {message ? (
                <div
                  className={`rounded-md border px-3 py-2 text-xs font-bold ${
                    message.tone === "success"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-red-200 bg-red-50 text-red-800"
                  }`}
                >
                  {message.text}
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-[#d9e2dd] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#17211c]">Codes To Use</h2>
                <p className="mt-1 text-sm font-medium text-[#65766d]">
                  These are the actual values used by the pair command.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <CodeValue label="Connection code" value={connectionCode} />
              <CodeValue label="Pairing code" value={pairingCode} />
              <CodeValue label="Control token" value={controlToken} />
              <CodeValue label="Company name" value={safeCompanyName} />
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-extrabold text-[#17211c]">UTM Windows PowerShell Commands</h2>
              <p className="mt-1 text-sm font-medium text-[#65766d]">
                Generate codes first, then run these in PowerShell. The commands use npm.cmd to avoid the Windows npm.ps1 execution-policy error.
              </p>
            </div>
            {hasCodes ? (
              windowsCommands.map((entry) => (
                <CommandRow
                  key={entry.id}
                  label={entry.label}
                  command={entry.command}
                  icon={entry.icon}
                />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-[#cbd8d1] bg-white p-6 text-sm font-bold text-[#65766d]">
                Generate connection and pairing codes to build the Mac commands.
              </div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
