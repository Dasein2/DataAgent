# Read-only analysis workbench implementation

Baseline: `4213793`. Source data remains read-only. No arbitrary source DDL/DML or approval bypass.

## Delivery checklist

- [x] Foundations: bounded session-scoped metadata cache/pool, opt-in exact-SQL result reuse, cost preflight, actionable errors and budgets.
- [x] Discovery: column/comment search, bounded catalog overview/batch descriptions, relationships with declared/inferred distinction, sampling and timezone/freshness disclosures.
- [x] Results: streaming bounded summaries/projection, precise local transformations, immutable lineage, local SQL snapshots, quotas/retention, opt-in pre-storage masking.
- [x] BI: pie/donut/scatter/KPI/area/stacked views, explicit value order, series limits, chart inventory/archive/revision; never aggregate in chart compiler.
- [x] HTTP: caller ownership on every new read/write-local endpoint, validation, export action audit.
- [x] UI: paged full-width explorer, schema/context/history sidebars, compact evidence/progress, artifact dashboard, command palette, accessible responsive neutral theme.
- [x] Verification: typecheck/build, unit/service/local integration tests, browser QA, operator documentation. Real-engine and performance qualifications below remain explicit release gates.

## Verification record — 2026-11-17

- `npm run check`: passed.
- `npm run build`: passed; local SQL tests also exercised the compiled worker after build.
- `npm test`: **219 passed, 0 failed, 0 skipped**. Coverage includes metadata coalescing/concurrency, local SQL AST restrictions, exact decimal aggregation, storage serialization, cost policy/unknown estimates/cancellation, new charts/ref precision, explicit TopN+Other/null handling, truncated-cell refusal, ownership, purge/retention, archive-index rebuild, export audit and UI module/download authentication regressions.
- `npm run test:integration:local`: **10 passed, 1 skipped, 0 failed** using the PostgreSQL-protocol PGlite fixture. The skipped test is genuine PostgreSQL control-connection cancellation; the MySQL suite is disabled without a running test server.
- Browser QA with local fixtures, no business database: historical session read; command palette Enter; 523-row explorer at **501–523 / 523**, 23 rows and disabled next button; column display; statistics; local COUNT=523 with parent lineage; truncation disclosure; one rendered dashboard chart; CSV/SVG/PNG downloads. CSV has 524 lines including header and retains `9007199254740993.10`.
- Responsive visual review: **390×844** dark explorer fits in a **378px** dialog with no document overflow; desktop explorer and dashboard render. Generated PNG/SVG are non-empty. Browser evidence is development-only under ignored `.tmp/`, not source-controlled fixtures.
- Final regression caught and fixed: optional artifact lineage/timezone fields must be omitted when absent so persisted and returned artifact records remain deeply equal.

### Delivery re-check — 2026-11-18

- Re-ran `npm run check`, `npm run build`, `npm test` and `npm run test:integration:local`: the same 219 unit/service tests and 10 local integration tests pass; the genuine PostgreSQL cancellation case remains skipped under PGlite.
- Attempted `npm run test:integration` with the ignored local test DSNs. PostgreSQL at `127.0.0.1:55444` and MySQL at `127.0.0.1:53306` both returned `ECONNREFUSED`; all 21 cases failed during connection setup before SQL execution. This is neither a passing real-engine qualification nor evidence of an engine regression. The Docker daemon was also unavailable, so the isolated compose fixtures could not be started in this run.
- No Doris/StarRocks test targets or business end-to-end credentials were supplied to this verification run. The release gates below remain open.

## Remaining deployment qualifications

- [ ] Real PostgreSQL server: cancellation/control-connection acknowledgement, privileges, query plans, partition metadata and representative workload performance.
- [ ] Running MySQL, Doris and StarRocks servers: target-version conformance and resource-policy behavior; no claim these live-engine integrations passed.
- [ ] Production load/latency/token benchmarks and capacity sizing; no unmeasured speedup claims.
- [ ] Operator-specific grants/RLS/approved views, model data-egress approval, authentication binding, process/container memory limits and data/audit retention.

Implementation is complete for the scoped roadmap; these environment-dependent qualifications are not silently treated as complete. No production database changes or deployment were performed. See [使用与运维](readonly-bi-workbench.md) and `.env.example`.

## Corrections to the initial discussion

- Read-only does not mean side-effect-free, fresh, cheap, or mutually consistent. Keep user SQL serialized on its pinned connection; use independently proven, bounded connections only for metadata. Do not share a transaction/connection concurrently.
- Metadata and result caches are session/identity scoped. Result reuse is explicit, disabled by default, keyed by exact SQL and limits; never lowercase literals, remove SQL hints, or ignore LIMIT. Report age and original execution time. Known volatile/session-dependent expressions and unknown functions are rejected conservatively; this is not a proof about view definitions or user-defined types/operators.
- LIMIT caps returned rows, not scanned rows. Examine scan nodes, not only root output cardinality. Enforce budgets on preflight too; EXPLAIN estimates are advisory and engine-dependent. Never silently rewrite SQL.
- Paging only exposes rows already stored. Truncation cannot be repaired with result_read; rerun a reduced/aggregated query.
- Query execution time is not data freshness or a cross-query consistent snapshot. Freshness requires explicit source-watermark evidence.
- Chart snapshots and refs are immutable. Rename creates a revision; archive hides an artifact, not deletes cited evidence. TopN + Other belongs to an explicit local transformation or source SQL, with lineage.
- Local snapshots do not magically reduce source extraction cost. Import only an existing bounded result, reject incomplete input by default, preserve precision and retention/ownership. No arbitrary files/network/extensions in local SQL.
- Policies based on output-column names cannot enforce source-level column access control across aliases/expressions. Database grants, row-level security, and approved views remain the security boundary. Masking is defense in depth, not a substitute.
- No unmeasured latency/token reduction claims. Benchmark before claiming improvement.
