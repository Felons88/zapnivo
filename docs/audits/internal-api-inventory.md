# Internal API route inventory

Generated from the current checkout: 208 route handlers (129 system, 79 business). This is a source index, not a security certification. Indirect guards and audits in imported services require review before mutations change.

| Route | Methods | Permission or guard in route | Audit indicator |
| --- | --- | --- | --- |
| `/api/system/activation` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/ai/agents/[id]/kill` | POST | system.ai.manage | Audit not found in route source |
| `/api/system/ai/agents/[id]/tools` | POST | system.ai.manage | Audit not found in route source |
| `/api/system/ai/agents/bulk` | POST | system.ai.manage | Audit not found in route source |
| `/api/system/ai/evals` | GET | system.ai.view | Audit not found in route source |
| `/api/system/ai/guardrails` | GET | system.ai.view | Audit not found in route source |
| `/api/system/ai/models` | GET | system.ai.view | Audit not found in route source |
| `/api/system/ai` | GET | system.ai.view | Audit not found in route source |
| `/api/system/app/env` | GET | system.deployments.view | Audit call present |
| `/api/system/app/health` | GET | system.deployments.view | Audit not found in route source |
| `/api/system/changes/[id]/decision` | POST | system.changes.decide | Audit not found in route source |
| `/api/system/changes` | GET, POST | system.changes.view, system.changes.request | Audit call present |
| `/api/system/commands/[id]/requeue` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/commands/[id]` | GET | system.kiosks.view | Audit not found in route source |
| `/api/system/commands` | GET | system.kiosks.view | Audit not found in route source |
| `/api/system/database/health` | GET | system.database.schema.view | Audit not found in route source |
| `/api/system/database/migrations` | GET | system.database.schema.view | Audit not found in route source |
| `/api/system/deployments/[id]/decision` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/deployments/[id]/execute` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/deployments/[id]/health-check` | POST | system.deployments.view | Audit not found in route source |
| `/api/system/deployments/[id]/monitor` | GET | system.deployments.view | Audit not found in route source |
| `/api/system/deployments/[id]/pipeline` | GET | system.deployments.view | Audit not found in route source |
| `/api/system/deployments/[id]` | GET | system.deployments.view | Audit not found in route source |
| `/api/system/deployments/github/overview` | GET | system.deployments.view | Audit call present |
| `/api/system/deployments/health-profile` | GET, POST | system.deployments.view, system.deployments.manage | Audit not found in route source |
| `/api/system/deployments/request-deploy` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/deployments/rollback` | GET, POST | system.deployments.view, system.deployments.manage | Audit not found in route source |
| `/api/system/deployments` | GET, POST | system.deployments.view, system.deployments.manage | Audit not found in route source |
| `/api/system/deployments/verify` | GET | system.deployments.view | Audit not found in route source |
| `/api/system/dev/endpoints` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/dev/ping` | POST | system.dashboard.view | Audit call present |
| `/api/system/dev/simulate` | POST | system.kiosks.manage | Audit call present |
| `/api/system/devices` | GET | system.kiosks.view | Audit not found in route source |
| `/api/system/emergency` | GET, POST | system.emergency.view, system.emergency.execute | Audit not found in route source |
| `/api/system/exceptions/[id]` | GET, PATCH | system.kiosks.view | Audit call present |
| `/api/system/exceptions` | GET | system.kiosks.view | Audit call present |
| `/api/system/flags` | GET, POST | system.flags.view, system.flags.manage | Audit not found in route source |
| `/api/system/health` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/incidents/[id]/acknowledge` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/incidents/[id]/assign` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/incidents/[id]/evidence` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/incidents/[id]/notes` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/incidents/[id]/transition` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/incidents` | GET | system.security.audit.view | Audit call present |
| `/api/system/infrastructure/api-services` | GET | system.integrations.view | Audit call present |
| `/api/system/infrastructure/database` | GET | system.database.schema.view | Audit call present |
| `/api/system/infrastructure/webhooks/[id]` | GET | system.integrations.view | Audit call present |
| `/api/system/infrastructure/webhooks` | GET | system.integrations.view | Audit call present |
| `/api/system/integrations/[id]/detail` | GET | system.integrations.view | Audit call present |
| `/api/system/integrations/[id]/health` | GET | system.integrations.view | Audit call present |
| `/api/system/integrations` | GET | system.integrations.view | Audit not found in route source |
| `/api/system/jobs/control` | POST | system.webhooks.retry | Audit call present |
| `/api/system/jobs/email-outbox/[id]/retry` | POST | system.webhooks.retry | Audit not found in route source |
| `/api/system/jobs` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/keys` | GET | system.integrations.view | Audit call present |
| `/api/system/kiosks/[id]/app-station` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/commands` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/config` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/credential/reencrypt` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/credential/revoke` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/credential/rotate/cancel` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/credential/rotate` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/credential` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/diagnostics` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/provision/revoke` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/provision` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/status` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/[id]/test-mode` | POST | system.kiosks.manage | Audit call present |
| `/api/system/kiosks/bulk` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/kiosks/certification` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit call present |
| `/api/system/kiosks/maintenance/[id]` | PATCH | system.kiosks.manage | Audit call present |
| `/api/system/kiosks/maintenance` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit call present |
| `/api/system/kiosks/onboarding` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit call present |
| `/api/system/kiosks/register` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/launch` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/mapbox/retrieve` | GET | system.kiosks.view | Audit not found in route source |
| `/api/system/mapbox/suggest` | GET | system.kiosks.view | Audit not found in route source |
| `/api/system/newsletter/resend` | POST | system.users.manage | Audit call present |
| `/api/system/newsletter` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/newsletter/test` | POST | system.users.manage | Audit call present |
| `/api/system/observability/alerts` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/observability/alerts/test` | POST | system.security.audit.view | Audit not found in route source |
| `/api/system/observability` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/observability/traces` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/ops-status` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/overview` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/pricing` | POST | system.flags.manage | Audit call present |
| `/api/system/recovery` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/recovery/tests` | POST | system.changes.request | Audit not found in route source |
| `/api/system/retention` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/retention/run` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/retention/runs` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/search` | GET | system.dashboard.view | Audit call present |
| `/api/system/secrets/rotate` | POST | system.secrets.rotate | Audit call present |
| `/api/system/secrets` | GET | system.integrations.view | Audit call present |
| `/api/system/security/bootstrap` | GET, POST | Other auth check; inspect route | Audit not found in route source |
| `/api/system/security/elevation` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/security/mfa/challenge` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/system/security/mfa/enroll` | POST | Other auth check; inspect route | Audit call present |
| `/api/system/security/mfa/factors` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/system/security/mfa/unenroll` | POST | Other auth check; inspect route | Audit call present |
| `/api/system/security/mfa/verify` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/system/security/readiness` | GET | system.security.audit.view | Audit not found in route source |
| `/api/system/security/users` | GET, POST, DELETE | system.security.audit.view, system.users.manage | Audit not found in route source |
| `/api/system/settings/app` | GET, POST, PUT | system.flags.view, system.flags.manage | Audit not found in route source |
| `/api/system/site-ops` | GET, POST | system.dashboard.view, system.flags.manage | Audit not found in route source |
| `/api/system/sites/[site]/media/[id]` | PATCH, DELETE | system.flags.manage, system.deployments.manage | Audit not found in route source |
| `/api/system/sites/[site]/media` | GET, POST | system.dashboard.view, system.flags.manage | Audit not found in route source |
| `/api/system/sites/[site]/pages/[page]/fields/[field]/publish` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/sites/[site]/pages/[page]/fields/[field]` | GET, PUT | system.dashboard.view, system.flags.manage | Audit not found in route source |
| `/api/system/sites/[site]/pages/[page]/fields/[field]/schedule` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/sites/[site]/pages/[page]/revisions` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/sites/[site]/pages` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/sites/[site]/revisions/[rid]/revert` | POST | system.deployments.manage | Audit not found in route source |
| `/api/system/sites/media/file/[id]` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/system/sites` | GET | system.dashboard.view | Audit not found in route source |
| `/api/system/sites/selftest` | POST | system.flags.manage | Audit not found in route source |
| `/api/system/status` | GET | system.dashboard.view | Audit call present |
| `/api/system/updates/campaigns/[id]` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/updates/campaigns` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/updates/config` | POST | system.kiosks.manage | Audit not found in route source |
| `/api/system/updates/releases/[id]` | GET, PATCH | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/updates/releases` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit not found in route source |
| `/api/system/venues/[id]` | GET, PATCH | system.kiosks.view, system.kiosks.manage | Audit call present |
| `/api/system/venues/duplicates` | POST | system.kiosks.view | Audit not found in route source |
| `/api/system/venues` | GET, POST | system.kiosks.view, system.kiosks.manage | Audit call present |
| `/api/system/webhooks/[id]/replay` | POST | system.webhooks.retry | Audit not found in route source |
| `/api/system/webhooks/[id]` | GET | system.integrations.view | Audit call present |
| `/api/system/webhooks` | GET | system.integrations.view | Audit call present |
| `/api/admin/advertising` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/agreements` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/ai/agents/[id]/enable` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/agents/[id]/kill` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/agents/[id]` | PATCH | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/agents/[id]/run` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/agents` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/approvals/[id]` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/approvals` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/ai/runs` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/customers` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/email-studio/inbound` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/email-studio/log` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/email-studio/preview` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/email-studio/senders` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/email-studio/test` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/email-studio/triggers` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/equipment` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/evals/[id]/run` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/evals` | GET, POST, PUT | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/events` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/experiments/[id]/transition` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/experiments` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/export` | GET | Other auth check; inspect route | Audit call present |
| `/api/admin/finance/assumptions` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/finance/by-venue` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/finance/investigations/[id]/assign` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/investigations/[id]/collect` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/investigations/[id]/decide` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/finance/investigations/[id]/recommend` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/investigations/[id]` | GET | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/investigations/[id]/status` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/investigations` | GET, POST | No literal auth check found | Audit not found in route source |
| `/api/admin/finance/summary` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/fleet` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/forecast` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/gifts/[id]/refund` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/gifts/launch-status` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/gifts` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/groups/[id]/credit` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/groups/funding/[id]/refund` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/helpdesk` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/inquiries` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/inventory` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/knowledge/[id]` | GET, PATCH | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/knowledge/[id]/transition` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/knowledge` | GET, POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/knowledge/stale` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/monetization/packages/[id]` | PATCH | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/monetization/plans/[id]` | PATCH | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/notifications` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/observability/issues/[id]/analyze` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/observability` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/onboarding` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/partners` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/payments/[id]/refund` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/payments/readiness` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/payouts` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/placements` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/prefs` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/privacy` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/promos` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/qr/[station]` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/phone/reply` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/receptionist/threads/[id]/approve-draft` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads/[id]/assign` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads/[id]/note` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads/[id]/reply` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads/[id]` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads/[id]/status` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/receptionist/threads` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/restock` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/revenue` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/sms` | GET, POST | Other auth check; inspect route | Audit call present |
| `/api/admin/statements` | POST | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/tickets/bulk` | POST | No literal auth check found | Audit not found in route source |
| `/api/admin/users` | POST | Other auth check; inspect route | Audit call present |
| `/api/admin/vending` | GET | Other auth check; inspect route | Audit not found in route source |
| `/api/admin/views` | POST | Other auth check; inspect route | Audit not found in route source |
