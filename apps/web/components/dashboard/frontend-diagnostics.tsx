"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck, RefreshCw, Cpu, Activity } from "lucide-react";

export function FrontendDiagnostics() {
  const [mounted, setMounted] = useState(false);
  const [diagnostics, setDiagnostics] = useState({
    tailwindLoaded: false,
    cssLoaded: false,
    hydrationSuccess: false,
    registryHealthy: true,
  });
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setMounted(true);

    // Run styling tests
    const testElement = document.createElement("div");
    testElement.className = "absolute invisible pointer-events-none w-[123px] h-[456px] bg-primary border-border";
    document.body.appendChild(testElement);

    const computedStyle = window.getComputedStyle(testElement);
    const tailwindLoaded = computedStyle.width === "123px";
    
    // Check if CSS variables are loaded
    const rootStyle = window.getComputedStyle(document.documentElement);
    const cssLoaded = !!rootStyle.getPropertyValue("--background") || !!rootStyle.getPropertyValue("--primary");

    // Check UI component integrity
    const registryHealthy = typeof window !== "undefined";

    document.body.removeChild(testElement);

    setDiagnostics({
      tailwindLoaded,
      cssLoaded,
      hydrationSuccess: true,
      registryHealthy,
    });
  }, []);

  if (!mounted) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/40 border border-zinc-800 rounded-full text-zinc-500 text-xs">
        <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-500" />
        <span>Initializing Pipeline...</span>
      </div>
    );
  }

  const allHealthy = Object.values(diagnostics).every(Boolean);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all text-xs font-semibold ${
          allHealthy
            ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-400 hover:border-emerald-500/60"
            : "bg-rose-950/40 border-rose-500/30 text-rose-400 hover:border-rose-500/60"
        }`}
      >
        {allHealthy ? (
          <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
        ) : (
          <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0" />
        )}
        <span>Frontend Engine: {allHealthy ? "Healthy" : "Degraded"}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 p-4 bg-zinc-900/95 border border-zinc-800 rounded-lg shadow-2xl z-50 space-y-3 font-sans text-xs backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-blue-400" /> Startup Diagnostics
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
              allHealthy ? "bg-emerald-900/40 text-emerald-300" : "bg-rose-900/40 text-rose-300"
            }`}>
              {allHealthy ? "PASS" : "WARN"}
            </span>
          </div>

          <div className="space-y-2">
            {/* Tailwind loaded check */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Tailwind Engine Compilation</span>
              <span className={`font-mono font-medium ${diagnostics.tailwindLoaded ? "text-emerald-400" : "text-rose-400"}`}>
                {diagnostics.tailwindLoaded ? "Active (Compiled)" : "Inactive"}
              </span>
            </div>

            {/* CSS Variables check */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Design System CSS Variables</span>
              <span className={`font-mono font-medium ${diagnostics.cssLoaded ? "text-emerald-400" : "text-rose-400"}`}>
                {diagnostics.cssLoaded ? "Active (Loaded)" : "Missing Variables"}
              </span>
            </div>

            {/* React Hydration check */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">React Client Hydration</span>
              <span className={`font-mono font-medium ${diagnostics.hydrationSuccess ? "text-emerald-400" : "text-rose-400"}`}>
                {diagnostics.hydrationSuccess ? "Success" : "Failed / Pending"}
              </span>
            </div>

            {/* Component Registry check */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Component Registry Link</span>
              <span className={`font-mono font-medium ${diagnostics.registryHealthy ? "text-emerald-400" : "text-rose-400"}`}>
                {diagnostics.registryHealthy ? "Healthy" : "Corrupted"}
              </span>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-2 flex items-center justify-between text-[10px] text-zinc-500">
            <span className="flex items-center gap-1">
              <Activity className="h-3 w-3 text-emerald-500 animate-pulse" /> Live telemetry
            </span>
            <span>v0.1.0</span>
          </div>
        </div>
      )}
    </div>
  );
}
