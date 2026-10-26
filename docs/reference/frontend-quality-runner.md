# Running the frontend quality measurements

The runner uses Lighthouse 13.5.0 directly as a replaceable Apache-2.0 development dependency, with chrome-launcher 1.2.1. LHCI was rejected after its dependency audit; the direct runner was explicitly approved. The application, domain and browser bundles do not import either tool. There is no Lighthouse server, telemetry or public report upload.

## Local measurement

Use a production build, the normal local database configuration in `.env`, installed Playwright Chromium, Caddy and OpenSSL. Commit the tree before measuring: the runner refuses dirty source and never overwrites an output directory. Do not run other builds or browsers on that runner while collecting samples.

```sh
npm ci
npx playwright install chromium
npm run build
npm run quality
npm run quality -- --scope=full --locale=en --profile=desktop --cache=warm
npm run quality -- --route=article --cache=cold
```

`quality` reuses the end-to-end seed, mock IdP, API, worker, database lock and schema preflight. The web process receives application/authentication database credentials only. The fixture hash covers the original manifest bytes and `scripts/e2e.mjs`; corpus version remains `43a-v3`. Item ids come from the seeded API, and authenticated measurement uses the synthetic end-to-end operator. The operator's cookie is scoped to `/admin` on localhost through CDP, never sent as a global request header or persisted in a summary.

The default set measures both public pages in Dutch, mobile, with five sequential samples per page. `--scope=full` includes the populated admin list, native editor and enhanced writer; `--scope=admin` measures only those three. Locales are `nl` and `en`; profiles are the pinned Lighthouse simulated mobile and desktop presets. Browser selection follows the exact Playwright version/revision in `package-lock.json`. Each measured sample starts a fresh Chromium process. `fresh` uses empty browser storage/cache; `warm` performs one unmeasured navigation in that fresh process before the measured navigation. `cold` additionally restarts the web process before every sample; its database and proxy remain warm. No mode claims a cold host, database or deployment. `--diagnostic` permits one additional five-sample batch for inconclusive or performance-only failures; both batches remain in the result.

Caddy provides HTTPS and the production `encode zstd gzip` and operational-route exclusions. TLS uses one ephemeral localhost certificate trusted by its SPKI only, with no general browser certificate bypass. Application CSP, cache headers and consent behaviour remain intact. The timed navigation supplies its own DOM identity artifact, response headers, request outcomes and errors. Every declared image URL, including lazy below-fold images, is checked after measurement. This validation does not alter Lighthouse timings. No login, missing image or wrong item can satisfy the evaluator.

Reports go to a unique `.scratch/quality/` directory, or `--out=<new-directory>`. Every sample has its original Lighthouse JSON/HTML, trace, network summary and identity metadata. The aggregate preserves raw category scores, metric values, spread, applicable audit ids and all batches. `summary.json` records the SHA, corpus hash/version, tool/browser/OS/runner settings, elapsed runner minutes, coverage gaps and repair proposals. A non-pass result exits nonzero. `--baseline=<summary.json>` adds diagnostic comparisons only when corpus, tools and runner settings agree and the predecessor passed. Absolute thresholds never change.

## CI and artifacts

The separate `Frontend quality` workflow builds once and reuses the build in isolated PostgreSQL/browser shards, each with a ten-minute deadline. Installation has a three-minute limit and measurement a six-minute limit, leaving artifact handling within the job budget. Apt keeps signature verification and uses the regular Ubuntu HTTPS mirrors; the initial Azure mirror stalled signed font/library downloads for over eight minutes. Every PR and main push runs the Dutch public corpus on mobile and desktop. Weekly Monday 05:17 UTC and manual dispatch use the same tested matrix: public nl/en, mobile/desktop, fresh/warm/cold, plus the three admin states in nl/en on mobile/desktop. An unmapped change still gets the default measurement.

CI pins Node 22.22.0, Ubuntu 24.04, Lighthouse 13.5.0, lockfile Chromium and Caddy 2.10.2 with its archive checksum. The actual GitHub image build, Chromium, CPU and runtime versions are recorded, so image drift cannot silently become a comparable baseline. Local results are a separate runner profile. Passing summaries also get a baseline artifact name. The workflow retrieves the latest successful main baseline for the cell profile; incompatible corpus/tool/runner settings explicitly produce no comparable baseline. Failed observation runs cannot replace the successful baseline history. Older successful reports remain in artifact history.

Raw public reports and encrypted admin originals are retained for 30 days; sanitized summaries for 90 days. Artifact upload and encryption run after failures too. Authenticated reports are archived with OpenSSL CMS to the public recipient certificate in `scripts/quality/artifact-recipient.pem`; CI has no decryption key. The operator keeps the matching private key outside git and CI. To inspect an authenticated archive:

```sh
openssl cms -decrypt -binary -inform DER -in private.tar.gz.cms -inkey /path/to/operator-private-key.pem -out private.tar.gz
tar -xzf private.tar.gz
```

Keep the operator key in controlled storage. Replace the public recipient in a reviewed tooling PR if the private key is lost or rotated; retain older private keys while their artifacts are retained. Plaintext admin originals remain locally in the ignored output directory for inspection; GitHub uploads only the encrypted archive and sanitized aggregate. The output directory and temporary key directory are owner-readable only.

## Calibration and enforcement

The first CI result was on 2026-10-26. The ten-working-day observation window ends on 2026-11-06; the workflow begins blocking non-pass measurements on 2026-11-09 at 00:00 UTC. Dev owns enforcement under frontend-quality step C. Enable blocking earlier once two independent complete batches on one candidate SHA meet the contract and the negative evaluator fixtures pass. Existing verify, security and accessibility gates remain blocking throughout. Reports always retain their real `pass`, `fail`, `inconclusive` or `not-measured` state during observation.

Branch protection is a separate delivery criterion. On 2026-10-26 the GitHub branch-protection endpoint returned “Branch not protected” for main; no required-status enforcement is claimed. Step C must require the measurement statuses and check the configuration, including keeping the admin/weekly evidence in the release decision. A successful observation job is not proof that the measured cells pass. Missing summaries fail the status step even during calibration; disabled/missed schedules require the next report consumer to inspect workflow history. The first scheduled event after merge remains unobserved until it actually occurs; manual dispatch exercises the same matrix but cannot prove a scheduler fired.

## Coverage and repair boundaries

The summary explicitly records the dynamic POST/iframe preview as unmeasured until a versioned state contract exists. A bare preview GET is an empty shell. The demanding theme in `43a-v3` is simulated, so it cannot establish a persisted tenant-theme measurement; that fixture belongs to the theme work. SiteChrome is now rendered on the public routes; its old planned manifest entry is superseded by those real measurements without changing the mbp-owned corpus. Future collections, restricted reads, conditional forms and managed embeds retain their implementation dependencies.

Manual keyboard/screen-reader, real browser zoom, hero contrast and field data keep the release scenarios and limits in [the quality contract](../architecture/frontend-quality.md). These automated runs do not establish WCAG conformance or real-user INP. Repairs go into the existing component, renderer, security or representation suites; the runner emits proposals and never rewrites private planning. A score failure does not authorize lowering thresholds, suppressing assets, changing security policy or fixing product code in the measurement PR.

## Consuming history and checking missed schedules

The read-only consumer keeps observation-job conclusions separate from actual cell states. It reads the original v1 summaries without decrypting admin evidence, validates the measured source contract, and retains every run/attempt/batch. Source contracts come from corpus, seed, lockfile, workflow and matrix bytes at the measured commit. A PR head and its measured merge commit are separate fields; the adapter checks the merge parent. Unsupported future corpus/matrix versions are missing evidence until a reviewed adapter supports them. Duplicate artifacts/cells, mismatched provenance, unavailable/corrupt reports and interrupted runs cannot pass. No latest/best-run selection occurs.

```sh
node scripts/quality/history.mjs --repo=bolsterdigital/mycel --run=40366473887 --out=.scratch/history-001
node scripts/quality/consume.mjs --input=.scratch/history-001 --as-of=2026-10-26T20:00:00Z --out=.scratch/consumed-001
```

Use a fresh output directory for each invocation. The adapter needs `gh` authenticated with repository contents/actions read access and `unzip`; the consumer itself needs only Node and the retained directory. `history.json` is the versioned input index: workflow status/cron/activation, watchdog observation, run id/attempt/event/head/measured SHA/status/time, measured source contract and artifact paths. `--run` adds historical run ids to all runs since rollout. API errors become coded missing evidence, never private response bodies. The adapter downloads only single-entry `summary.json` artifacts; it cannot publish raw Lighthouse reports. Local evidence can be indexed with event `local`, explicit `selection` (`scope`, `locale`, `profile`, `cache`), a source contract and local summary path; it remains separate from GitHub evidence. Output is sanitized JSON plus Markdown; original source summaries stay untouched in the input directory. Profiles and raw category scores remain separate, including all diagnostic batches.

The separate `Frontend quality watchdog` workflow observes daily at 06:31 UTC, on manual dispatch and on PRs. It uses only `contents: read` and `actions: read`, and retains its sanitized output for 90 days. It does not write statuses, issues, messages or planning. Workflow enabled state, API availability, artifacts and the last completed scheduled watchdog run are visible. A watchdog that has never fired, is disabled, failed or has no completed scheduled observation in 48 hours is not healthy. This is liveness evidence, not proof that monitored scores pass. The initial watchdog workflow is absent from main until merge, so its local/PR observation correctly reports missing monitoring evidence.

Weekly expectations begin after the B merge at 2026-10-26 17:30:57 UTC, using Monday 05:17 UTC. The first firing is due 2026-11-02 05:17 UTC and overdue at 2026-11-03 05:17 UTC. The explicitly labelled 24-hour GitHub operational grace does not extend calibration. Before expiry, absence is `pending`; afterwards it is `not-measured` under dev `#43C-report`. Only an actual schedule event in that weekly firing window can fulfil it; manual, main and local evidence cannot. A real schedule event can still have failed or missing measurements. Until actual weekly and watchdog firings are observed, every dev handoff runs these commands locally with the current UTC clock and records the date/outcome. Both GitHub schedules can fail, so this is not independent external monitoring.

New measurement proposals use `#43C-report`, preview coverage uses `#43C-preview`, and historical `#43B` remains an explicit source alias. Product repair ownership/tier stays separate. Proposals are deduplicated by cause across retained runs but preserve every run/cell reference; registering a new child cause still needs a six-field record and private-planning deduplication. Coverage dependencies, including the simulated demanding theme and unmeasured POST/iframe preview, remain visible. The consumer never closes them from a green available subset. Stable required-status enforcement, effective branch protection, preview measurement and the factory-improvement report are separate deliveries.
