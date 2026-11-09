"use client";
import { useRouter } from "next/navigation";

export function LogoutButton({ light = false }: { light?: boolean }) {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }
  return <button type="button" onClick={logout} className={`rounded-full border px-4 py-2 text-xs font-bold ${light ? "border-silver/60 text-ink hover:border-ink" : "border-white/30 hover:border-lime"}`}>Sign out</button>;
}
