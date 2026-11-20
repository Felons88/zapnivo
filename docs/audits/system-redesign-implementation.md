# System platform redesign — implementation status

## Delivered in this stage

- Inventoried 138 internal page routes and 208 internal API route paths. The route matrix records the observed permission gate, dependencies, mutation hints, live-update hints, and a per-route review checkbox. The API matrix is a source-level heuristic, not a security certification.
- Changed `/system` into a role-filtered application launcher. Moved the previous technical overview to `/system/overview` without removing its data sources.
- Filtered the technical sidebar against the server-side role and route permission map. Business staff see business destinations; technical roles see their permitted control-plane destinations.
- Added light and dark system tokens, a persisted theme toggle, a persisted compact-sidebar toggle, responsive app tiles, and recently opened apps. Recent history is filtered against currently permitted apps.
- Added reusable page heading, panel, metric, and action components. Migrated the main headings/actions of `/system/kiosks`, `/system/venues`, and `/system/observability` to these primitives.
- Linked the existing business console back to the system application directory.
- Corrected the finance app tile and system sidebar link to require a business admin. `/admin/finance` now waits for that check before querying revenue data. Its existing summary API already enforces the admin role.

## Preserved integrations

The existing Supabase queries, service modules, API endpoints, helpdesk authorization/audit service, realtime refresh components, and subdomain routing remain in place. The launcher reads assigned support cases, pending system changes, and device attention counts only when the corresponding role permits the signal and the backend is configured. Missing data displays a dash, not an invented count.

## Validation

- `npm run typecheck`: passed.
- `npm test -- --run`: 185 files and 2,463 tests passed.
- `npm run build`: passed with `/system/overview` included.
- Browser automation: blocked in this local sandbox. Playwright's isolated server startup stalled; installed Edge exited at headless launch; Windows computer-use approval timed out; direct localhost access was denied by socket permissions. Interactive desktop/mobile, keyboard, contrast, and live-data QA remain unverified.

## Remaining work before calling the full brief complete

- Migrate the content of every internal route in the route matrix to the shared visual components. The shell and three technical headings are updated, but many existing page internals still use legacy styles.
- Audit direct-route and API permissions by department. Existing `admin`/`staff` roles are broad; the requested finance-specific staff permissions and cross-department entitlement model need backend authorization design and migration. Finance investigations remain staff-accessible under the existing policy.
- Build dedicated notification center and cross-application search for the system launcher; current links lead to the existing alert and search pages.
- Complete browser-based responsive, accessibility, performance, and critical workflow checks against a safely configured preview. Recheck all 138 routes with real role accounts and representative data.
- Verify a preview deployment, then production deployment and post-deploy smoke checks through the authorized Vercel workflow.
