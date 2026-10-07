import { CaseMismatchPage } from "@/components/cases/CaseMismatchPage";
import { RuntimeFieldSettingsBootstrap } from "@/components/settings/RuntimeFieldSettingsBootstrap";

export default async function SavedCaseMismatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <RuntimeFieldSettingsBootstrap />
      <CaseMismatchPage caseId={id} />
    </>
  );
}
