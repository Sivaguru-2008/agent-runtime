/**
 * Route protection (Phase 2).
 *
 * Edge middleware that gates the dashboard. It validates the HMAC-signed session
 * cookie (verifySessionToken — same format the API mints) WITHOUT a DB round-trip
 * and enforces:
 *
 *   • Protected pages (PROTECTED_PREFIXES) require a valid session, else a
 *     redirect to /login?next=<path>.
 *   • Founder pages/APIs (FOUNDER_PREFIXES) require a session whose `founder`
 *     claim is true, else a redirect to /dashboard (pages) or 403 (API).
 *   • An already-authenticated user hitting /login is bounced to /dashboard.
 *
 * Public routes (/, /landing, /docs, /pricing, /login, /signup) and the auth
 * endpoints are always reachable. This is defense-in-depth in front of the API,
 * which independently enforces auth (machine API key) and founder sessions.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, getSessionSecret, SESSION_COOKIE } from "@/lib/auth/session";

// Page route prefixes that require a logged-in user.
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/agents",
  "/tasks",
  "/replays",
  "/settings",
  "/api-keys",
  "/onboarding",
  "/operator",
  "/founder"
];

// Subset of the above (plus the founder API) that additionally require is_founder.
const FOUNDER_PAGE_PREFIXES = ["/founder"];
const FOUNDER_API_PREFIXES = ["/api/runtime/admin/founder"];

function hasPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + "/"));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = await verifySessionToken(token, getSessionSecret());
  const authed = claims != null;
  const isFounder = claims?.founder === true;

  // Founder API: hard 403 (not a redirect) for non-founders / unauthenticated.
  if (hasPrefix(pathname, FOUNDER_API_PREFIXES)) {
    if (!authed) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "Sign in required." }, { status: 401 });
    }
    if (!isFounder) {
      return NextResponse.json({ error: "FORBIDDEN", message: "Founder access required." }, { status: 403 });
    }
    return NextResponse.next();
  }

  // Already authenticated and visiting the login page → go to the dashboard.
  if (pathname === "/login" && authed) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Founder pages: redirect non-founders to their own dashboard.
  if (hasPrefix(pathname, FOUNDER_PAGE_PREFIXES)) {
    if (!authed) {
      const url = new URL("/login", request.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    if (!isFounder) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  // Other protected pages: require any valid session.
  if (hasPrefix(pathname, PROTECTED_PREFIXES) && !authed) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Run on everything except Next internals and static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|svg|gif|ico|css|js|woff2?)$).*)"]
};
