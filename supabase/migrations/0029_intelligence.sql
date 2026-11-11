-- Intelligence platform stage 3-5 — migration 0029
-- AI agent registry + control center, knowledge lifecycle, experiments, eval lab.
-- All additive; staff RLS everywhere; service-role writes.

-- ─── Agent registry ──────────────────────────────────────────────────────────
create table ai_agents (
  id text primary key,                              -- e.g. 'support.public', 'fleet.ops'
  name text not null,
  description text,
  department text not null,                         -- support | operations | finance | growth | executive
  model text not null default 'openai/gpt-4o-mini',
  temperature numeric(3,2) not null default 0.2,
  max_tokens int not null default 700,
  timeout_ms int not null default 25000,
  permissions text[] not null default '{}',         -- e.g. {'support.public.read'}
  tools text[] not null default '{}',               -- allowlisted tool names
  enabled boolean not null default true,
  daily_budget_cents int not null default 0,        -- 0 = unset/default cap enforced in code
  monthly_budget_cents int not null default 0,
  max_calls_per_hour int not null default 60,
  escalation_policy text,                           -- e.g. 'needs_human' | 'staff_review'
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ai_agent_runs (
  id bigint generated always as identity primary key,
  agent_id text not null references ai_agents(id) on delete cascade,
  task text not null,                               -- short label, never raw prompts
  status text not null default 'running' check (status in ('running','ok','error','escalated','denied')),
  duration_ms int,
  model text,
  prompt_tokens int, completion_tokens int,
  cost_cents numeric(10,4),
  tool_calls int not null default 0,
  error text,                                       -- scrubbed message only
  actor text,                                       -- 'system' | staff email hash | 'public'
  created_at timestamptz not null default now()
);
create index ai_agent_runs_agent_idx on ai_agent_runs (agent_id, created_at desc);
create index ai_agent_runs_created_idx on ai_agent_runs (created_at desc);

-- Human approval queue for consequential agent-proposed actions.
create table ai_approvals (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references ai_agents(id) on delete cascade,
  run_id bigint references ai_agent_runs(id) on delete set null,
  action text not null,                             -- e.g. 'refund.issue', 'payout.modify'
  payload jsonb not null,                           -- sanitized proposal, no secrets
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create index ai_approvals_status_idx on ai_approvals (status, created_at desc);

-- ─── Knowledge lifecycle ─────────────────────────────────────────────────────
create table knowledge_articles (
  id text primary key,                              -- slug, e.g. 'returns-policy'
  title text not null,
  audience text not null check (audience in ('public','customer','partner','internal')),
  category text,
  body text not null,                               -- markdown-ish plain text
  status text not null default 'draft' check (status in ('draft','in_review','approved','published','archived')),
  version int not null default 1,
  effective_at timestamptz,
  source_ref text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_audience_idx on knowledge_articles (audience, status);

create table knowledge_versions (
  id bigint generated always as identity primary key,
  article_id text not null references knowledge_articles(id) on delete cascade,
  version int not null,
  title text not null, body text not null, status text not null,
  changed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (article_id, version)
);

-- ─── Experiments (A/B) ───────────────────────────────────────────────────────
create table experiments (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,                         -- e.g. 'hero_cta_copy'
  name text not null,
  hypothesis text,
  status text not null default 'draft' check (status in ('draft','approved','running','paused','concluded')),
  audience text not null default 'public',          -- never 'security'|'consent'|'pricing_disclosure'
  start_at timestamptz, end_at timestamptz,
  guardrail_metrics text[] not null default '{}',
  approved_by uuid references profiles(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (audience not in ('security','consent','pricing_disclosure'))
);

create table experiment_variants (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references experiments(id) on delete cascade,
  key text not null,                                -- 'control' | 'variant_a' ...
  config jsonb not null default '{}'::jsonb,        -- e.g. {headline: "..."}
  weight int not null default 50 check (weight > 0),
  unique (experiment_id, key)
);

create table experiment_assignments (
  id bigint generated always as identity primary key,
  experiment_id uuid not null references experiments(id) on delete cascade,
  subject_hash text not null,                       -- hashed anon id — no raw identifiers
  variant_key text not null,
  exposed_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (experiment_id, subject_hash)
);
create index experiment_assign_idx on experiment_assignments (experiment_id, variant_key);

-- ─── AI evaluation lab ───────────────────────────────────────────────────────
create table eval_suites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agent_id text references ai_agents(id) on delete set null,
  scenarios jsonb not null default '[]'::jsonb,     -- [{input, expect:{...}}] synthetic only
  version int not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table eval_runs (
  id bigint generated always as identity primary key,
  suite_id uuid not null references eval_suites(id) on delete cascade,
  agent_id text not null,
  model text,
  score numeric(5,2),                               -- 0-100 composite
  breakdown jsonb,                                  -- per-dimension scores
  latency_ms int, cost_cents numeric(10,4),
  passed int not null default 0, total int not null default 0,
  results jsonb,                                    -- per-scenario outcomes (sanitized)
  created_at timestamptz not null default now()
);
create index eval_runs_suite_idx on eval_runs (suite_id, created_at desc);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table ai_agents enable row level security;
alter table ai_agent_runs enable row level security;
alter table ai_approvals enable row level security;
alter table knowledge_articles enable row level security;
alter table knowledge_versions enable row level security;
alter table experiments enable row level security;
alter table experiment_variants enable row level security;
alter table experiment_assignments enable row level security;
alter table eval_suites enable row level security;
alter table eval_runs enable row level security;

create policy staff_agents on ai_agents for all using (is_staff());
create policy staff_agent_runs on ai_agent_runs for select using (is_staff());
create policy staff_approvals on ai_approvals for all using (is_staff());
create policy staff_knowledge on knowledge_articles for all using (is_staff());
create policy staff_kversions on knowledge_versions for select using (is_staff());
create policy staff_experiments on experiments for all using (is_staff());
create policy staff_exvariants on experiment_variants for select using (is_staff());
create policy staff_expassign on experiment_assignments for select using (is_staff());
create policy staff_evalsuites on eval_suites for all using (is_staff());
create policy staff_evalruns on eval_runs for select using (is_staff());

-- Public reads: only published public/customer knowledge articles.
create policy public_knowledge on knowledge_articles for select using (status = 'published' and audience in ('public','customer'));
-- Active experiment definitions are needed client-side for assignment (no PII in rows).
create policy public_experiments on experiments for select using (status in ('approved','running'));
create policy public_variants on experiment_variants for select using (true);
