import { withTeamAccess } from '@/lib/access/route-boundary';
import { getFieldSettings, saveFieldSettings } from "@/lib/field-settings-service";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { settingsOrganization } from "@/lib/access/settings";
import { AccessError } from "@/lib/access/server";

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
      fieldSettings: settings.fieldSettings,
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    console.error("Error in GET /api/settings/field:", error);
    return jsonWithCors(request,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { settings } = body;

    if (!Array.isArray(settings)) {
      return jsonWithCors(request,
        { error: "Invalid settings format" },
        { status: 400 }
      );
    }

    const success = await saveFieldSettings(settings, await settingsOrganization(request));

    if (!success) {
      return jsonWithCors(request,
        { error: "Failed to save settings" },
        { status: 500 }
      );
    }

    return jsonWithCors(request, { success: true });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    console.error("Error in POST /api/settings/field:", error);
    return jsonWithCors(request,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
