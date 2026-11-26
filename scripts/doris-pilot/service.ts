import { AppError } from "../../src/errors.js";
import type { DbSession } from "../../src/db/session.js";
import type { ResultStore } from "../../src/results/store.js";
import { CatalogDraft, type CatalogVersion, type BusinessTable } from "../../src/business/types.js";
import { compileMetric, relationPassed, validateCatalog } from "./planner.js";
import { BusinessCatalogStore, fingerprint } from "./store.js";
import { readBusinessView } from "../../src/business/view.js";
export { BusinessCatalogStore };

const cap = 2_000;
export class BusinessAnalysis {
  constructor(private readonly catalog: BusinessCatalogStore, private readonly connection: string, private readonly db: DbSession, private readonly results: ResultStore) {}
  get enabled() { return Boolean(this.catalog.active(this.connection)?.enabled); }

  private requireIdle() {
    if (this.db.snapshot().status !== "ready") throw new AppError("SESSION_UNAVAILABLE", "Reconnect before changing the business catalog");
  }
  private async scope() {
    return fingerprint([this.connection, await this.db.businessPermissionKey(), [...this.db.scopesView].sort()]);
  }
  private async viewScope() {
    const permissions = await this.scope();
    return { permissions, version: this.catalog.active(this.connection) };
  }

  async list() {
    const { permissions, version } = await this.viewScope();
    const versions = this.catalog.list(permissions);
    const current = version && versions.some(v => v.id === version.id) ? version : undefined;
    return { active: current?.id, enabled: Boolean(current?.enabled), versions };
  }
  async get(id: string) { return this.catalog.get(await this.scope(), id); }
  async draft(input: unknown) {
    this.requireIdle();
    const c = CatalogDraft.parse(input);
    validateCatalog(c);
    const scope = await this.scope();
    await this.bind(c, c.tables);
    if (scope !== await this.scope()) throw new AppError("FORBIDDEN", "Database privileges changed while checking the catalog");
    return this.catalog.save(scope, c);
  }

  async publish(id: string, reviewer: string) {
    this.requireIdle();
    const scope = await this.scope();
    const { catalog } = this.catalog.get(scope, id);
    const verified = await this.bind(catalog, catalog.tables);
    if (scope !== await this.scope()) throw new AppError("FORBIDDEN", "Database privileges changed while publishing the catalog");
    return this.catalog.save(scope, catalog, { reviewer, binding: verified, connection: this.connection });
  }

  async enable(enabled: boolean) {
    this.requireIdle();
    if (!enabled) { this.catalog.enable(this.connection, false); return; }
    const { permissions, version } = await this.viewScope();
    if (!version) throw new AppError("INVALID_INPUT", "Publish a signed version first");
    // get() proves the active revision is in the currently granted scope before enabling.
    this.catalog.get(permissions, version.id);
    this.catalog.enable(this.connection, true);
  }

  async lookup(question: string) {
    const { permissions, version: selected } = await this.viewScope();
    if (!selected?.enabled) return { mode: "exploration", candidates: [], reason: "当前连接未启用已发布业务目录" };
    const version = this.catalog.get(permissions, selected.id);
    const c = version.catalog;
    const q = question.trim().toLowerCase();
    const indexed = this.catalog.lookup(permissions, version.id, q);
    const match = (terms: string[]) => Math.max(0, ...terms.map(t => t.toLowerCase()).map(t => t === q ? 1000 : q.includes(t) ? 100 + t.length : t.includes(q) ? q.length : 0));
    const metrics = c.metrics.map(m => ({ m, score: match([m.id, m.label, ...m.aliases]) || (indexed.some(r => r.kind === "metric" && r.id === m.id) ? 1 : 0) }))
      .filter(x => x.score).sort((a,b) => b.score - a.score).slice(0, 5);
    const tableMatches = c.tables.filter(t => match([t.name, t.label, ...t.aliases, ...t.fields.flatMap(f => [f.column, f.label, ...f.aliases])]) || indexed.some(r => r.kind === "table" && r.id === t.id)).slice(0, 5);
    return { version: version.id, domain: c.domain, timezone: c.timezone, coverage: "published_domain_only", ambiguity: metrics.length > 1,
      candidates: metrics.map(({m}) => ({ id: m.id, label: m.label, definition: m.definition, unit: m.unit, owner: m.owner,
        table: m.table, dimensions: m.dimensions, filters: m.allowedFilters, matched_by: "business name, alias or catalog term",
        paths: c.relations.filter(r => r.metrics.includes(m.id)).map(r => ({ ...r, state: relationPassed(r) ? "published" : "candidate" })) })),
      tables: tableMatches.map(t => ({ id: t.id, schema: t.schema, name: t.name, label: t.label, grain: t.grain, through: t.completeThrough })) };
  }

  async analyze(input: unknown, options: { taskId?: string; signal?: AbortSignal; expectedVersion?: string } = {}) {
    const { permissions, version: selected } = await this.viewScope();
    if (!selected?.enabled) throw new AppError("FEATURE_UNSUPPORTED", "Business analysis is not enabled on this connection; raw SQL remains exploration");
    if (options.expectedVersion && options.expectedVersion !== selected.id) throw new AppError("INVALID_INPUT", "The active definition changed. Do not silently re-run a historical result under a new formula.");
    const version = this.catalog.get(permissions, selected.id);
    const plan = compileMetric(version, input);
    const bound = await this.bind(version.catalog, plan.tables, plan.evidence.request);
    if (Object.entries(bound).some(([id, value]) => version.binding?.[id] !== value))
      throw new AppError("INVALID_INPUT", "Published schema/key metadata changed; review and publish a new version before querying");
    const now = await this.viewScope();
    if (now.permissions !== permissions || now.version?.id !== version.id || !now.version.enabled)
      throw new AppError("FORBIDDEN", "Permissions or the active business revision changed before querying");
    if (options.signal?.aborted) throw new AppError("QUERY_CANCELLED", "Business analysis cancelled before its source query");
    const assertPlanActive = () => {
      const active = this.catalog.active(this.connection);
      if (!active?.enabled || active.id !== version.id) throw new AppError("FORBIDDEN", "The business revision was disabled or replaced before dispatch");
    };
    const meta = await this.db.query(plan.sql, { planKey: fingerprint([permissions, version.id, bound]), maxRows: cap, taskId: options.taskId, signal: options.signal, label: plan.metric.label, business: plan.evidence, assertPlanActive });
    return this.db.measure("verification", () => readBusinessView(this.results, meta));
  }

  /** Re-bind against the pinned account, not a metadata snapshot from another role or connection. */
  private async bind(catalog: CatalogVersion["catalog"], tables: BusinessTable[], request?: import("../../src/business/types.js").MetricRequest) {
    const descriptions: Record<string, string> = Object.create(null);
    const keys = new Map<string, Map<string, string>>();
    for (const t of tables) {
      const d = await this.db.describeBusiness(t.schema, t.name);
      if (!["table", "view", "materialized_view"].includes(d.object.kind)) throw new AppError("INVALID_INPUT", `Unsupported business object ${t.id}`);
      if (t.level === "detail" && d.keyModel?.kind === "aggregate") throw new AppError("INVALID_INPUT", `Aggregate-key model cannot be used as detail: ${t.id}`);
      const column = (key: string) => {
        const found = d.columns.find(f => f.name === key);
        if (!found) throw new AppError("SQL_FIELD_ERROR", `Missing field ${t.id}.${key}`);
        if (this.db.businessMasked(key)) throw new AppError("FORBIDDEN", `Field ${t.id}.${key} matches an output masking rule; it cannot be aliased by a business template`);
        return found.type;
      };
      const numeric = (key: string) => {
        if (!/^(?:(?:tiny|small|big|large)?int|decimal(?:v[23])?)(?:\b|\()/i.test(column(key))) throw new AppError("INVALID_INPUT", `Measure ${t.id}.${key} must be exact numeric`);
      };
      const filter = ({ field, value }: { field: string; value: string | number }) => {
        const type = column(field);
        if (typeof value === "number") numeric(field);
        else if (!/^(?:char|varchar|string|text)(?:\b|\()/i.test(type))
          throw new AppError("INVALID_INPUT", `Filter ${t.id}.${field} must use the field's native type; no implicit numeric or date coercion`);
      };
      t.keys.forEach(column); t.fields.forEach(f => column(f.column));
      if (t.time) {
        const type = column(t.time.field);
        if (!(t.time.storage === "business_date" ? /^date(?:v2)?$/i : /^datetime(?:v2)?(?:\(\d\))?$/i).test(type))
          throw new AppError("INVALID_INPUT", `The declared time storage for ${t.id} does not match ${type}`);
      }
      if (t.ingestTime) column(t.ingestTime);
      if (t.partition) column(t.partition);
      for (const m of catalog.metrics) {
        const a = m.measure;
        if (t.id === m.table) {
          m.filters.forEach(filter); m.allowedFilters.forEach(f => column(f.field));
          if (request?.metric_id === m.id) for (const f of request.filters) filter({ field: m.allowedFilters.find(k => k.id === f.id)!.field, value: f.value });
          if (a.kind === "sum" || a.kind === "net") numeric(a.field);
          if (a.kind === "distinct") column(a.field);
          if (a.kind === "ratio") filter(a.numerator);
        }
        for (const dimension of m.dimensions) if ((dimension.relation ? catalog.relations.find(r => r.id === dimension.relation)?.to : m.table) === t.id) column(dimension.field);
        if (a.kind === "net" && catalog.relations.find(r => r.id === a.relation)?.to === t.id) { numeric(a.deduction); a.filters.forEach(filter); }
      }
      const joinFields = catalog.relations.flatMap(r => r.from === t.id ? r.fromFields : r.to === t.id ? r.toFields : []);
      keys.set(t.id, new Map(joinFields.map(key => [key, column(key).toLowerCase().replace(/\s+/g, "")])));
      descriptions[t.id] = fingerprint([t.schema, t.name, d.object.kind, d.columns.map(f => [f.name, f.type, f.nullable]), d.primaryKey, d.keyModel, d.partitionKey]);
    }
    for (const r of catalog.relations) {
      const from = keys.get(r.from), to = keys.get(r.to);
      if (from && to && r.fromFields.some((field, i) => from.get(field) !== to.get(r.toFields[i]!)))
        throw new AppError("INVALID_INPUT", `Relationship ${r.id} needs matching key types; implicit casts are not published`);
    }
    return descriptions;
  }
}
