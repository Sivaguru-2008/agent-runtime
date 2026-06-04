import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.RUNTIME_API_URL ?? "http://127.0.0.1:4000";

/**
 * Current user + onboarding state. Forwards the httpOnly session cookie to the
 * API's GET /auth/me as a Bearer token. Used by client pages to hydrate the
 * signed-in user without exposing the token to JS.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const upstream = await fetch(`${BACKEND_URL}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: "BACKEND_UNREACHABLE" }, { status: 503 });
  }
}
