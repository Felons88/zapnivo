-- Migration 0007 — branded HTML email bodies in the outbox.
-- body keeps the plain-text fallback; html carries the rendered design-system template.

alter table email_outbox add column if not exists html text;
