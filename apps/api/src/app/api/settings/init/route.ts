import { withTeamAccess } from '@/lib/access/route-boundary';
import { settingsOrganization } from '@/lib/access/settings';
import { getFieldSettings } from "@/lib/field-settings-service";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const settings = await getFieldSettings(await settingsOrganization(request));
    
    if (!settings) {
      return jsonWithCors(request,
        { error: "Failed to load settings" },
        { status: 500 }
      );
    }

    return jsonWithCors(request, { 
      enabled: true, 
      count: settings.fieldSettings.length,
      fieldSettings: settings.fieldSettings,
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    console.error("Error initializing field settings:", error);
    return jsonWithCors(request,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withTeamAccess(GETHandler);
