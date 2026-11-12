-- 0047_bootstrap_single_grant.sql
-- Phase 2.1 bootstrap hardening: at most ONE privileged bootstrap grant may
-- ever exist. Without this, two different accounts holding the env token +
-- verified TOTP could both pass attemptBootstrap concurrently and each receive
-- sysadmin. The partial unique index makes the second insert fail at the DB
-- level regardless of application-level races.

create unique index if not exists system_bootstrap_grants_single
  on system_bootstrap_grants ((true));

comment on index system_bootstrap_grants_single is
  'Enforces a single privileged bootstrap grant globally — replay and concurrent bootstrap impossible.';
