import type { ZenzipApp } from "./app.js";
import type {
  MachineDefinition,
  MachineHistoryEntry,
  MachineTransition,
} from "./types.js";

/**
 * Persisted state machine (P3.5–P3.7): transitions are validated against the
 * definition and applied atomically in the store. Every transition emits
 * `<machine>.<toState>` through the event bus — durable workflow triggers
 * and app.on() subscribers can hook state changes.
 */
export class Machine<S extends string = string> {
  constructor(
    private readonly app: ZenzipApp,
    readonly name: string,
    readonly definition: MachineDefinition<S>,
  ) {}

  /** Create an instance in the initial state. False if it already exists. */
  async create(id: string): Promise<boolean> {
    return this.app._native.machineCreate(this.name, id);
  }

  /**
   * Apply an event. Throws on invalid transitions
   * (`invalid transition: … cannot handle 'X' in state 'Y'`).
   */
  async send(id: string, event: string): Promise<MachineTransition> {
    const result = JSON.parse(
      this.app._native.machineSend(this.name, id, event),
    ) as MachineTransition;
    // The Rust side emitted `<machine>.<to>` durably; mirror it to local
    // ephemeral subscribers.
    this.app._dispatchLocal(`${this.name}.${result.to}`, {
      machine: this.name,
      id,
      from: result.from,
      event,
      to: result.to,
    });
    return result;
  }

  async state(id: string): Promise<S | null> {
    return (await this.app._native.machineState(this.name, id)) as S | null;
  }

  /** Transition history, newest first. */
  async history(id: string, limit = 100): Promise<MachineHistoryEntry[]> {
    return JSON.parse(
      await this.app._native.machineHistory(this.name, id, limit),
    ) as MachineHistoryEntry[];
  }
}
