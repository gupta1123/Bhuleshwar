import { AppShell } from "@/components/dashboard/AppShell";
import { CollectionsDashboardPage } from "@/components/collections/CollectionsDashboardPage";

export default function CollectionFollowUpsRoute() {
  return (
    <AppShell>
      <CollectionsDashboardPage initialView="followUps" showWorkflowSummary={false} />
    </AppShell>
  );
}
