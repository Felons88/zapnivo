"use client";
import { btnClass } from "@/components/ui";

export function SignOutButton() {
  return (
    <button type="button" className={btnClass("light", "border border-mist")} onClick={async () => { await fetch("/api/auth/login", { method: "DELETE" }); window.location.href = "/login"; }}>
      Sign out
    </button>
  );
}
