import type { SupabaseClient } from "@supabase/supabase-js";

// Connections created while team access is not enforced carry no organization.
// Resolve it from the owner's active membership so it points at a real
// access_organizations row instead of falling back to the user id.
export async function resolveOwnerOrganization(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("access_members")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(3);
  if (error) throw error;
  const organizations = [...new Set((data ?? []).map((row) => String(row.organization_id)).filter(Boolean))];
  return organizations.find((id) => id === userId) ?? (organizations.length === 1 ? organizations[0] : null);
}
