# UI audit findings (commit d335202 -> remediation)

Method: Playwright/Chromium against production (`before/`) and a local production build (`after/`) at
375, 390, 430, 768, 1024, 1366, 1440, 1920 widths; DOM geometry checks (`scripts/ui-audit.cjs`,
`findings.json`) AND manual review of the screenshots. Geometry found 0 flagged issues on both sets,
so every defect below was identified visually / functionally, not by geometry.

| # | Page / viewport | Defect | Sev | Root cause | Fix | Verified |
|---|---|---|---|---|---|---|
| 1 | `/` all | FAQ about renting/returning power banks on a B2B homepage | High | `HomeFaq` content | 8 B2B questions; JSON-LD derives from same array | after/1440-home; unit test |
| 2 | `/get-a-vending-machine`, `/vending/request` all | Heading "Interested in get a vending machine?" | High | `VendingLanding` built heading from `label.toLowerCase()` | Per-page `CLOSING_TITLE` map, neutral default | after/1440-inquiry; unit test over every page |
| 3 | `/` cards, `/vending/snacks`+`/drinks` all | Snacks and beverage used the same image | High | One shared asset | Distinct snack / beverage detail crops of the source concept | after/1440-home |
| 4 | `/get-a-vending-machine` all | Form 4000px below hero; "Go to the inquiry form" button pointed at its own section | High | Form rendered last | Form directly after hero on request pages; self-link removed; `scroll-mt-32`; hero visual hidden on mobile | after/375-inquiry |
| 5 | header, desktop | Hover opens a mega-menu, the click that follows closed it | Med | `onClick` toggled while hover had already opened | Click only closes a menu opened by click (`pinned`) | after/1440-menu-* |
| 6 | header, 1024-1279 | Search icon floated mid-header | Med | `lg:ml-0` while nav is `xl` | `xl:ml-0` | after/1024-home |
| 7 | mobile menu | "Vending solutions" label hidden under header + announcement | Med | `pt-28` too small | `pt-40` | after/390-mobile-menu |
| 8 | announcement bar 390/768 | Wrapped to 2-3 lines with orphaned arrow | Low | Long copy | Shorter copy below lg/md | after/390 + 768 |
| 9 | `/about` | "Explore all vending solutions" -> `/vending` = 404 | High | Link to non-existent route | Links to `/#solutions` / `/vending/snacks` | scripts/link-check.cjs: prod 1 broken, local 0 |
| 10 | industry pages | Hero right half empty; text-only | Med | No imagery | Representative image + honest caption per industry | after/1440-industry-offices |
| 11 | category hero | Two stacked overlays (tag + note) covered product shelves | Low | Duplicate disclosure | Note only where the visual has none | after/1440-snacks |
| 12 | `/business`, `/business/apply`, `/how-it-works` | "fully serviced/managed by Zapnivo", "you don't staff/stock" service promises | Med | Overstated copy | Reworded to "servicing agreed per location" | grep |
| 13 | `/contact` | Vending route pointed at partner application only | Low | Old route | Request-a-machine route with `?src=contact_page` | link-check |
| 14 | `/` | Repetitive disclosure copy, four stacked numbered sections, separate thin Partnerships + Service-area bands | Med | Copy + layout | Distinct copy per section; merged Partnerships + Service area; industries 2-col; removed repeated numbering; stretched-link category cards | after/1440-home |
| 15 | inquiry form | Server-side validation errors not surfaced | Low | No focus management | Scroll/focus first invalid field | code |

Not defects: fbclid page is byte-identical in layout to the plain URL; `<script>`/`onerror` payloads in
`fbclid`/`utm_*` are not reflected or executed; `?src=` is sanitized by `leadSourceTag`.

## Performance measurements (Lighthouse 13, production, after deploy ccb2db1)

Lab scores on this workstation are load-dependent: `environment.benchmarkIndex` was ~900-1000 for the
post-deploy runs versus ~2400 for the earlier baselines, so absolute scores are NOT comparable with
`artifacts/lighthouse-*.json`. To check for a regression, old (d335202) and new (ccb2db1) production builds
were run locally, interleaved, on the same machine (mobile, 3 runs each):

| build | run 1 | run 2 | run 3 |
|---|---|---|---|
| d335202 | 73 | 76 | 77 |
| ccb2db1 | 65 | 79 | 77 |

=> no measurable regression; run-to-run noise (+/-8) exceeds the difference. Accessibility 100, Best
Practices 96, SEO 100 on all six production pages measured (`lighthouse-*.json` in this folder).
No 90+ performance claim is made from these runs. Re-measure on an idle machine or with PageSpeed Insights / CrUX.
