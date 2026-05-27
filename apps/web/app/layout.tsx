import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./globals.css";


export const metadata: Metadata = {
  title: "Runloop Console | Durable AI Agent Runtime",
  description: "The self-healing execution runtime and visual time-travel debugger that guarantees reliability for autonomous AI agents."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
