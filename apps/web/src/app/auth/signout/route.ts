import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("message", "Signed out successfully.");

  return NextResponse.redirect(loginUrl, { status: 302 });
}
