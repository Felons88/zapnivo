-- Migration 0066 — fleet realtime publication (Phase 4.2 kiosk fleet ops).
--
-- Adds the three fleet-ingest tables to supabase_realtime so the
-- /system/kiosks console (src/app/system/kiosks/FleetLive.tsx) receives
-- postgres_changes pushes for heartbeats/status/firmware (system_devices),
-- command state transitions (system_device_commands) and auth telemetry
-- (system_device_messages). Same guarded DO-block style as 0023.
--
-- RLS: realtime inherits SELECT policies; all three tables already restrict
-- reads to has_system_access() (0042/0043/0044) — i.e. profiles.system_role
-- holders who are not suspended. Non-system users receive nothing, so no new
-- policies are required.
--
-- Column exposure: realtime events carry full rows. system_devices holds
-- credential material only as non-reversible forms (device_secret_hash =
-- sha256, device_secret_enc* = AES-GCM ciphertext requiring a server-side
-- key), but we still revoke column-level SELECT on the secret columns from
-- `authenticated` so direct PostgREST reads by system-console users cannot
-- pull them either. Service-role reads (fleet stats, ingest, device-auth)
-- are unaffected. Realtime payload column-granularity is not guaranteed by
-- Postgres — the row-level policy remains the boundary, and the values are
-- ciphertext/hash only.

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table system_devices';
  exception when others then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table system_device_commands';
  exception when others then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table system_device_messages';
  exception when others then null;
  end;
end $$;

-- Defense-in-depth: secret/hash columns are never needed by browser clients
-- (the console renders via service-role server components + router.refresh()).
revoke select (device_secret_hash, device_secret_enc, device_secret_enc_next, provision_token_hash)
  on public.system_devices from authenticated;
