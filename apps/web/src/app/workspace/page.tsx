import { RuntimeFieldSettingsBootstrap } from "@/components/settings/RuntimeFieldSettingsBootstrap";
import { WorkspacePage } from "@/components/workspace/WorkspacePage";

export default function PacketWorkspacePage() {
  return (
    <>
      <RuntimeFieldSettingsBootstrap />
      <WorkspacePage />
    </>
  );
}
