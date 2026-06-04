import { redirect } from "next/navigation";

// Task executions are inspected in the operator platform. Protected route shim.
export default function TasksPage() {
  redirect("/operator");
}
