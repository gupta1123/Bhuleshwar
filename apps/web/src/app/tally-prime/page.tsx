import { TallyPrimeDashboard } from "@/components/tally/TallyPrimeDashboard";
import { AppShell } from "@/components/dashboard/AppShell";

interface TallyPrimePageProps {
  searchParams?: Promise<{
    view?: string;
  }>;
}

export default async function TallyPrimePage({ searchParams }: TallyPrimePageProps) {
  const resolvedSearchParams = await searchParams;
  const initialView = resolvedSearchParams?.view === "connection" ? "connection" : "home";

  return (
    <AppShell>
      <main className="min-h-screen bg-[#f7f7f5] px-4 py-6 text-[#1a1a1a] sm:px-8 sm:py-8">
        <div className="mx-auto max-w-7xl">
          <TallyPrimeDashboard initialView={initialView} />
        </div>
      </main>
    </AppShell>
  );
}
