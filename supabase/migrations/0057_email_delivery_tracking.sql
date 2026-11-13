-- Migration 0057 — bounded auto-retry for failed email_outbox rows.
--
-- flushOutbox (src/lib/helpdesk/mailer.ts) only picks status='queued', so a
-- transient provider error stranded rows in 'failed' until a human clicked
-- retry in System Control. `attempts` counts automatic requeues; the sweep
-- requeues failed rows older than 15 minutes while attempts < 5, then leaves
-- them 'failed' for manual review (getSystemJobs already surfaces the count).

alter table email_outbox
  add column if not exists attempts integer not null default 0;
