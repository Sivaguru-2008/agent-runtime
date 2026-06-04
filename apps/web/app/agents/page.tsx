import { redirect } from "next/navigation";

// Agents live in the operator platform's surfaces. This protected route exists
// so the middleware guards /agents; it forwards to the operator console.
export default function AgentsPage() {
  redirect("/operator");
}
