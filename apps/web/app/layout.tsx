import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import { BackendOfflineBanner } from "@/components/system/backend-offline-banner";
import { ExplainModeProvider } from "@/components/explain/explain-mode";
import { ExplainPanel } from "@/components/explain/explain-panel";
import { TourProvider } from "@/components/onboarding/tour-provider";
import { TourOverlay } from "@/components/onboarding/tour-overlay";
import { GlossaryProvider, ConceptGlossary } from "@/components/onboarding/concept-glossary";


export const metadata: Metadata = {
  title: "Runloop Console | Durable AI Agent Runtime",
  description: "The self-healing execution runtime and visual time-travel debugger that guarantees reliability for autonomous AI agents."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {/* Explainability layer wraps the whole app so any screen can open the
            click-to-learn side panel and read the global "Explain Everything"
            mode. The side panel is mounted once, here, and summoned on demand. */}
        <ExplainModeProvider>
          {/* Onboarding + discovery layer wraps the explainability layer: the
              guided-tour state machine and the ⌘K concept glossary. Their
              overlays mount once, here, beside the click-to-learn panel. */}
          <TourProvider>
            <GlossaryProvider>
              {/* Global connectivity signal — shows "Backend offline" with host/port,
                  last healthy check, and failure reason whenever the API on port 4000
                  is unreachable, instead of letting every panel fail opaquely. */}
              <BackendOfflineBanner />
              {children}
              <ExplainPanel />
              <ConceptGlossary />
              <TourOverlay />
            </GlossaryProvider>
          </TourProvider>
        </ExplainModeProvider>
      </body>
    </html>
  );
}
