import { ROLES, type Role, type RoleRouting, resolveRouting } from "@rewire/pipeline";
import { type ModelRef, modelFamily, type Provider } from "@rewire/providers";
import { createRoutedProviders } from "./run.js";

/** The outcome of {@link RoutingControl.set}: refusals are values, never throws. */
export type RoutingPick =
  | { ok: true; routing: RoleRouting; note: string }
  | { ok: false; reason: string };

/** Where a role's model comes from: a pick this session, models.toml `[roles]`, or `resolveRouting`. */
export type RoutingSource = "session" | "file" | "auto";

/**
 * A validated pick not yet in effect ({@link RoutingControl.plan}): `routing` is what `commit()`
 * would apply. Until then nothing changed and no listener was called.
 */
export type RoutingPlan =
  | { ok: true; routing: RoleRouting; commit: () => RoutingPick }
  | { ok: false; reason: string };

const same = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;
const show = (r: ModelRef): string => `${r.provider}:${r.model}`;

const freeze = (r: RoleRouting): RoleRouting => {
  const out = { ...r } as RoleRouting;
  for (const role of ROLES) out[role] = Object.freeze({ ...r[role] });
  return Object.freeze(out);
};

/**
 * The routing of an interactive session, changed by `/model` picks. Effective overrides are the
 * models file's `[roles]` overridden by the session picks (never persisted); the routing is
 * `resolveRouting(available, effective)`. A pick is applied only when the resulting routing
 * resolves, keeps the reviewer and the verifier off the implementer's family while `available`
 * holds another family, and has every provider creatable (`createRoutedProviders`, no network).
 * A refused pick changes nothing. A pick that needs work first (rebuilding the chat session) is
 * {@link plan}ned, the work done with the candidate routing, then committed. `current()` hands
 * out a frozen snapshot: a run that took one keeps it whatever is picked later.
 */
export class RoutingControl {
  private readonly avail: readonly ModelRef[];
  private readonly file: Partial<Record<Role, ModelRef>>;
  private readonly providers: (ref: ModelRef) => Provider;
  private session: Partial<Record<Role, ModelRef>> = {};
  private routing: RoleRouting;
  /** The routing of the models file alone: returning to any of its pairings is never refused. */
  private readonly fileRouting: RoleRouting;
  /** Bumped on every commit: a plan made before another commit is stale. */
  private version = 0;
  private readonly listeners = new Set<(r: RoleRouting) => void>();

  constructor(o: {
    available: ModelRef[];
    fileOverrides: Partial<Record<Role, ModelRef>>;
    providers: (ref: ModelRef) => Provider;
  }) {
    this.avail = Object.freeze(o.available.map((r) => Object.freeze({ ...r })));
    this.file = { ...o.fileOverrides };
    this.providers = o.providers;
    this.routing = freeze(resolveRouting([...this.avail], this.file));
    this.fileRouting = this.routing;
  }

  current(): RoleRouting {
    return this.routing;
  }

  available(): readonly ModelRef[] {
    return this.avail;
  }

  source(role: Role): RoutingSource {
    if (this.session[role] !== undefined) return "session";
    return this.file[role] !== undefined ? "file" : "auto";
  }

  /** `ref` undefined is the "default" pick: it removes this session's override for `role`. */
  set(role: Role, ref: ModelRef | undefined): RoutingPick {
    const p = this.plan(role, ref);
    return p.ok ? p.commit() : p;
  }

  /**
   * Validates a pick (resolves, family rule, providers creatable) without applying it. `commit()`
   * applies it, unless another pick was committed since (then it is refused, nothing changes).
   */
  plan(role: Role, ref: ModelRef | undefined): RoutingPlan {
    const next = { ...this.session };
    if (ref === undefined) delete next[role];
    else next[role] = { provider: ref.provider, model: ref.model };
    let routing: RoleRouting;
    try {
      routing = freeze(resolveRouting([...this.avail], { ...this.file, ...next }));
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
    const refusal = this.familyRefusal(routing);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    try {
      createRoutedProviders(routing, this.providers);
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
    const base = this.version;
    const commit = (): RoutingPick => {
      if (this.version !== base) {
        return { ok: false, reason: "refused: the routing changed meanwhile; pick again" };
      }
      this.apply(next, routing);
      const chosen = `${role}: ${show(routing[role])} (${ref === undefined ? `default, ${this.source(role)}` : "session"})`;
      const note =
        routing.independence === "same-family"
          ? `${chosen}; independence: same-family (the reviewer or verifier shares the implementer's family)`
          : chosen;
      return { ok: true, routing: this.routing, note };
    };
    return { ok: true, routing, commit };
  }

  /** Called with the new routing after every applied pick; returns its remover. */
  onChange(fn: (r: RoleRouting) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private apply(overrides: Partial<Record<Role, ModelRef>>, routing: RoleRouting): void {
    this.session = overrides;
    this.routing = freeze(routing);
    this.version++;
    for (const l of [...this.listeners]) {
      try {
        l(this.routing);
      } catch {
        // A listener's bug must not turn an applied pick into a throw (refusals are values).
      }
    }
  }

  /**
   * Why `next` is refused for family independence, if it is. A reviewer or verifier of the
   * implementer's family is refused while `available` holds another family, unless that exact
   * pairing is already in effect or is the models file's own (a file may set it): a pick never
   * makes it worse, an unrelated pick is not blocked by it, and "default" always gets back to
   * the file's routing.
   */
  private familyRefusal(next: RoleRouting): string | undefined {
    const implFam = modelFamily(next.implementer);
    const other = this.avail.find((m) => modelFamily(m) !== implFam);
    if (other === undefined) return undefined;
    for (const role of ["reviewer", "verifier"] as const) {
      const fam = modelFamily(next[role]);
      if (fam !== implFam) continue;
      const kept = (was: RoleRouting): boolean =>
        same(was[role], next[role]) && same(was.implementer, next.implementer);
      if (kept(this.routing) || kept(this.fileRouting)) continue;
      return (
        `refused: the ${role} ${show(next[role])} would share the implementer's family ` +
        `(${fam}, ${show(next.implementer)}) while a model of another family ` +
        `(${modelFamily(other)}, ${show(other)}) is available`
      );
    }
    return undefined;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
