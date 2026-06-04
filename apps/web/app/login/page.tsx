"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Zap, ShieldCheck } from "lucide-react";

/**
 * Login / signup entry (Phase 1 + Phase 2 redirect target).
 *
 * Renders the Google Identity Services "Continue with Google" button. Google
 * performs the email/password (or passkey) challenge and returns a signed ID
 * token to the callback; we POST it to /api/auth/google, which verifies it
 * server-side, upserts the user, and sets an httpOnly session cookie. New users
 * are routed into /onboarding; returning users go to ?next or /dashboard.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (resp: { credential?: string }) => void;
          }) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const buttonRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCredential(idToken: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken, source: "login" })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message ?? "Sign-in failed. Please try again.");
        setBusy(false);
        return;
      }
      // New users start onboarding; everyone else goes to their destination.
      router.push(data?.isNewUser ? "/onboarding" : next);
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!clientId) return;
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    function init() {
      if (!window.google || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId!,
        callback: (resp) => {
          if (resp.credential) void handleCredential(resp.credential);
        }
      });
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: "filled_blue",
        size: "large",
        text: "continue_with",
        shape: "pill",
        width: 320
      });
    }
    if (existing) {
      init();
    } else {
      const script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      script.onload = init;
      document.head.appendChild(script);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-4">
      <Link href="/" className="flex items-center gap-2 mb-10 text-zinc-400 hover:text-blue-300 transition-colors">
        <Zap className="h-5 w-5 text-blue-400" />
        <span className="font-semibold">Agent Runtime</span>
      </Link>

      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <h1 className="text-2xl font-semibold mb-1">Welcome</h1>
        <p className="text-sm text-zinc-400 mb-8">
          Sign in to your durable agent runtime. New here? Signing in creates your account.
        </p>

        {clientId ? (
          <div className="flex justify-center" aria-busy={busy}>
            <div ref={buttonRef} />
          </div>
        ) : (
          <div className="text-sm text-yellow-300/90 bg-yellow-950/20 border border-yellow-900/60 rounded-lg px-3 py-2">
            Google sign-in is not configured. Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> to
            enable “Continue with Google”.
          </div>
        )}

        {busy && <p className="text-xs text-zinc-500 mt-4 text-center">Signing you in…</p>}
        {error && (
          <div className="mt-4 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="mt-8 flex items-center gap-2 text-xs text-zinc-500">
          <ShieldCheck className="h-3.5 w-3.5 text-zinc-600" />
          We never see your password — Google verifies it.
        </div>
      </div>

      <p className="text-xs text-zinc-600 mt-6">
        Prefer an API key without an account?{" "}
        <Link href="/signup" className="text-blue-400 hover:text-blue-300">
          Self-serve a developer key →
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
      <LoginInner />
    </Suspense>
  );
}
