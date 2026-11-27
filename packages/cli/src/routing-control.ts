import { ROLES, type Role, type RoleRouting, resolveRouting } from "@rewire/pipeline";
import { type ModelRef, modelFamily, type Provider } from "@rewire/providers";
import { createRoutedProviders } from "./run.js";

/** The outcome of {@link RoutingControl.set}: refusals are values, never throws. */
export type RoutingPick =
  | { ok: true; routing: RoleRouting; note: string }
  | { ok: false; reason: string };

/** Where a role's model comes from: a pick this session, models.toml `[roles]`, or `resolveRouting`. */
export type RoutingSource = "session" | "file" | "auto";

/** The session overrides at one moment, for {@link RoutingControl.restore}. */
export type RoutingSnapshot = { readonly overrides: Readonly<Partial<Record<Role, ModelRef>>> };

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
 * A refused pick changes nothing. `current()` hands out a frozen snapshot: a run that took one
 * keeps it whatever is picked later.
 */
export class RoutingControl {
  private readonly avail: readonly ModelRef[];
  private readonly file: Partial<Record<Role, ModelRef>>;
  private readonly providers: (ref: ModelRef) => Provider;
  private session: Partial<Record<Role, ModelRef>> = {};
  private routing: RoleRouting;
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
    const next = { ...this.session };
    if (ref === undefined) delete next[role];
    else next[role] = { provider: ref.provider, model: ref.model };
    let routing: RoleRouting;
    try {
      routing = resolveRouting([...this.avail], { ...this.file, ...next });
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
    this.apply(next, routing);
    const chosen = `${role}: ${show(routing[role])} (${ref === undefined ? `default, ${this.source(role)}` : "session"})`;
    const note =
      routing.independence === "same-family"
        ? `${chosen}; independence: same-family (the reviewer or verifier shares the implementer's family)`
        : chosen;
    return { ok: true, routing: this.routing, note };
  }

  /** The session overrides now, to put back with {@link restore} (a failed chat-model swap). */
  snapshot(): RoutingSnapshot {
    return { overrides: { ...this.session } };
  }

  /** Puts a {@link snapshot} back. It held an applied routing, so it is not checked again. */
  restore(s: RoutingSnapshot): void {
    const overrides = { ...s.overrides };
    this.apply(overrides, resolveRouting([...this.avail], { ...this.file, ...overrides }));
  }

  /** Called with the new routing after every applied pick (and restore); returns its remover. */
  onChange(fn: (r: RoleRouting) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private apply(overrides: Partial<Record<Role, ModelRef>>, routing: RoleRouting): void {
    this.session = overrides;
    this.routing = freeze(routing);
    for (const l of [...this.listeners]) l(this.routing);
  }

  /**
   * Why `next` is refused for family independence, if it is. A reviewer or verifier of the
   * implementer's family is refused while `available` holds another family, unless that exact
   * pairing is already in effect (a models file may set it): a pick never makes it worse, and
   * an unrelated pick is not blocked by it.
   */
  private familyRefusal(next: RoleRouting): string | undefined {
    const implFam = modelFamily(next.implementer);
    const other = this.avail.find((m) => modelFamily(m) !== implFam);
    if (other === undefined) return undefined;
    for (const role of ["reviewer", "verifier"] as const) {
      const fam = modelFamily(next[role]);
      if (fam !== implFam) continue;
      const was = this.routing;
      if (same(was[role], next[role]) && same(was.implementer, next.implementer)) continue;
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
