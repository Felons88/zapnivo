"use client";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }
  return <button type="button" onClick={logout} className="rounded-full border border-white/30 px-4 py-2 text-xs font-bold hover:border-lime">Sign out</button>;
}
