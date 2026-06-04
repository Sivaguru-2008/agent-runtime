import { redirect } from "next/navigation";

// Deterministic replays are the operator platform's primary surface. Protected
// route shim so the middleware guards /replays.
export default function ReplaysPage() {
  redirect("/operator");
}
