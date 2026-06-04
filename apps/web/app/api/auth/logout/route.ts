import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.RUNTIME_API_URL ?? "http://127.0.0.1:4000";

/**
 * Log out: revoke the session server-side (best-effort) and clear the cookie.
 * Always returns ok and always clears the cookie, even if the backend call
 * fails — the user should never be stuck "logged in" locally.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await fetch(`${BACKEND_URL}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store"
      });
    } catch {
      // Best-effort revoke; clearing the cookie below is what matters locally.
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return res;
}
