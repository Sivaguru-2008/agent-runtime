import { redirect } from "next/navigation";

// /landing is a public alias for the marketing/console home.
export default function LandingPage() {
  redirect("/");
}
