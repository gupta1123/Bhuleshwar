import { CaseDetailPage } from "@/components/cases/CaseDetailPage";
import { RuntimeFieldSettingsBootstrap } from "@/components/settings/RuntimeFieldSettingsBootstrap";

export default async function SavedCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <RuntimeFieldSettingsBootstrap />
      <CaseDetailPage caseId={id} />
    </>
  );
}
