import { NextResponse } from "next/server";
import { listThreads } from "@/lib/receptionist/service";
import { FOLDERS, RECEPTIONIST_CATEGORIES, RECEPTIONIST_STATUSES, type Folder, type ReceptionistCategory, type ReceptionistStatus } from "@/lib/receptionist/types";
import { receptionistGuard } from "../_shared";

/** Staff-only thread list. Filters: folder | status, category, q. */
export async function GET(req: Request) {
  const g = await receptionistGuard();
  if (!g.ok) return g.res;

  const url = new URL(req.url);
  const folderParam = url.searchParams.get("folder");
  const statusParam = url.searchParams.get("status");
  const categoryParam = url.searchParams.get("category");
  const q = url.searchParams.get("q") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);

  const folder = (FOLDERS as readonly string[]).includes(folderParam ?? "") ? (folderParam as Folder) : undefined;
  const status = (RECEPTIONIST_STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as ReceptionistStatus) : undefined;
  const category = (RECEPTIONIST_CATEGORIES as readonly string[]).includes(categoryParam ?? "") ? (categoryParam as ReceptionistCategory) : undefined;

  const threads = await listThreads(g.db, { folder, status, category, q, limit: Number.isFinite(limit) ? limit : 100 });
  return NextResponse.json({ threads });
}
