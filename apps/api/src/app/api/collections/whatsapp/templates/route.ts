import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { fetchMsg91WhatsappTemplates, getMsg91WhatsappConfig } from "@/lib/msg91/whatsapp";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const config = getMsg91WhatsappConfig();
    if (!config.isConfigured) {
      return jsonWithCors(
        request,
        { error: "MSG91 WhatsApp is not configured.", templates: [], configured: false },
        { status: 409 }
      );
    }

    const payload = await fetchMsg91WhatsappTemplates();
    const templates = (payload.data ?? []).map((template) => ({
      name: template.name,
      category: template.category,
      languages: (template.languages ?? []).map((language) => ({
        language: language.language,
        status: language.status,
        variables: language.variables ?? [],
        variableType: language.variable_type ?? {},
      })),
    }));

    return jsonWithCors(request, {
      configured: true,
      senderNumber: config.senderNumber,
      activeTemplateName: config.templateName,
      activeTemplateMode: config.templateMode,
      templates,
    });
  } catch (error) {
    console.error("Error in GET /api/collections/whatsapp/templates:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export const GET = withTeamAccess(GETHandler);
