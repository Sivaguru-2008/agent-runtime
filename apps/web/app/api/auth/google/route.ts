import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.RUNTIME_API_URL ?? "http://127.0.0.1:4000";

/**
 * Exchange a Google ID token for a session.
 *
 * The browser obtains the Google ID token via the Google Identity Services
 * button on /login and POSTs it here. We forward it to the API's POST
 * /auth/google (which verifies it against Google and upserts the user), then set
 * the returned session token as an httpOnly, SameSite=Lax cookie so it is never
 * exposed to client JS and is sent automatically on every same-origin request
 * (including the /api/runtime proxy, so founder/onboarding calls carry it).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "Expected JSON body." }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND_URL}/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
  } catch {
    return NextResponse.json(
      { error: "BACKEND_UNREACHABLE", message: "The authentication service is temporarily unreachable." },
      { status: 503 }
    );
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status });
  }

  const { sessionToken, expiresAt, user, isNewUser } = data as {
    sessionToken?: string;
    expiresAt?: string;
    user?: unknown;
    isNewUser?: boolean;
  };

  const res = NextResponse.json({ user, isNewUser });
  if (sessionToken) {
    const expires = expiresAt ? new Date(expiresAt) : undefined;
    const maxAge = expires ? Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)) : undefined;
    res.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      ...(maxAge !== undefined ? { maxAge } : {})
    });
  }
  return res;
}
