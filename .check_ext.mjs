import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split(/\r?\n/).filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^"|"$/g,"")];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// extensions live in pg_extension — query via a known table? Try rpc helpers first
for (const rpc of ["exec_sql","run_sql","sql","query"]) {
  try { const r = await db.rpc(rpc, { sql: "select 1" }); console.log(rpc, "→", JSON.stringify(r.error ?? r.data).slice(0,120)); }
  catch(e){ console.log(rpc, "threw", String(e).slice(0,80)); }
}
