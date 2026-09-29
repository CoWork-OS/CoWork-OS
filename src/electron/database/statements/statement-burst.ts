import { AsyncLocalStorage } from "async_hooks";

/**
 * Keeps a domain's statement sequences uninterrupted on the worker backend (async SQLite
 * migration plan, DB6).
 *
 * Before a domain moved to the statement port, a service ran its statements
 * synchronously: nothing else ran between two of them unless the service awaited real
 * I/O in between. On the host backend that still holds, because a statement runs during
 * the call and the awaits between statements only pass through microtasks. In the
 * worker every statement is a round trip, and any other operation could run in between.
 *
 * The gate restores the old guarantee there. An operation's statements form a burst for
 * as long as it keeps issuing them without waiting on anything else. A statement from
 * another operation waits until the burst ends: a turn of the event loop passes after the
 * owner's last statement without the owner issuing another. Operations are told apart by
 * a statement context, opened per public call by `bindStatementContext`; a statement made
 * outside any context is an operation of its own.
 */

export interface StatementContext {
  readonly label: string;
}

const contexts = new AsyncLocalStorage<StatementContext>();

/** The current operation's context, if one is open. */
export function currentStatementContext(): StatementContext | undefined {
  return contexts.getStore();
}

/** Run `fn` as one operation, unless an operation is already open (then it joins it). */
export function withStatementContext<T>(label: string, fn: () => T): T {
  if (contexts.getStore()) return fn();
  return contexts.run({ label }, fn);
}

/**
 * Run `fn` as a new operation even inside another one: for work an operation schedules
 * rather than performs (timers, background runs, socket events), which would otherwise
 * inherit the context of the operation that scheduled it.
 */
export function detachedStatementContext<T>(label: string, fn: () => T): T {
  return contexts.run({ label }, fn);
}

/**
 * Open a statement context for every call of the methods defined on `owner` (a class's
 * prototype, or the class itself for static methods) that is not already inside one.
 * Call once per class, after its definition.
 */
export function bindStatementContext(owner: object, label: string): void {
  for (const name of Object.getOwnPropertyNames(owner)) {
    if (name === "constructor" || name === "prototype" || name === "length" || name === "name") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const method = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(owner, name, {
      ...descriptor,
      value: function statementContextMethod(this: unknown, ...args: unknown[]) {
        return withStatementContext(`${label}.${name}`, () => method.apply(this, args));
      },
    });
  }
}

interface Waiter {
  owner: StatementContext;
  resume: () => void;
}

export class StatementBurstGate {
  private owner: StatementContext | null = null;
  private inFlight = 0;
  /** Bumped by every statement the owner starts; a release check sees if it moved. */
  private generation = 0;
  private waiting: Waiter[] = [];
  private releaseScheduled = false;

  /** Resolves when `owner` may run a statement. */
  enter(owner: StatementContext): Promise<void> | null {
    if (this.owner === null) {
      this.owner = owner;
    } else if (this.owner !== owner) {
      return new Promise<void>((resume) => this.waiting.push({ owner, resume }));
    }
    this.generation += 1;
    this.inFlight += 1;
    return null;
  }

  /** A statement the current owner started has settled. */
  finished(): void {
    this.inFlight -= 1;
    if (this.inFlight === 0) this.scheduleRelease();
  }

  /**
   * Release after a turn of the event loop unless the owner started another statement:
   * its continuation runs in the microtasks after a statement settles, so a statement it
   * issues next arrives before the check.
   */
  private scheduleRelease(): void {
    if (this.releaseScheduled) return;
    this.releaseScheduled = true;
    const generation = this.generation;
    setImmediate(() => {
      this.releaseScheduled = false;
      if (this.inFlight > 0) return; // the last of those statements schedules again
      if (this.generation !== generation) {
        this.scheduleRelease(); // statements came and went since; wait one more turn
        return;
      }
      this.release();
    });
  }

  private release(): void {
    this.owner = null;
    const next = this.waiting.shift();
    if (!next) return;
    this.owner = next.owner;
    const admitted = [next, ...this.waiting.filter((waiter) => waiter.owner === next.owner)];
    this.waiting = this.waiting.filter((waiter) => waiter.owner !== next.owner);
    for (const waiter of admitted) {
      this.generation += 1;
      this.inFlight += 1;
      waiter.resume();
    }
  }
}

const gates = new WeakMap<object, Map<string, StatementBurstGate>>();

/** The gate shared by every port of `domain` on one connection. */
export function burstGateFor(domain: string, db: object): StatementBurstGate {
  let byDomain = gates.get(db);
  if (!byDomain) {
    byDomain = new Map();
    gates.set(db, byDomain);
  }
  let gate = byDomain.get(domain);
  if (!gate) {
    gate = new StatementBurstGate();
    byDomain.set(domain, gate);
  }
  return gate;
}
