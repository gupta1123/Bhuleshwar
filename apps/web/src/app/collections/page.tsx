import { AppShell } from "@/components/dashboard/AppShell";
import { CollectionsDashboardPage } from "@/components/collections/CollectionsDashboardPage";

export default function CollectionsRoute() {
  return (
    <AppShell>
      <CollectionsDashboardPage />
    </AppShell>
  );
}
