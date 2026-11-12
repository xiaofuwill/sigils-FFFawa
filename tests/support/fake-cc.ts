import { diff } from "jsondiffpatch";
import type { Factory, Group, Machine, PeriphId, Pipe } from "../../packages/factory-model/src/index";

export type WireMessage = { type: string; reqId?: string; [key: string]: unknown };

export interface FakeCcOptions {
  factory?: Factory;
  /** Slot count of the inventory that `PeriphAdd` should create for a peripheral. */
  inventories?: Record<PeriphId, number>;
  /** Peripherals that expose tanks (no item inventory) and get a fluid group. */
  fluids?: PeriphId[];
}

export function emptyFactory(): Factory {
  return { pipes: {}, machines: {}, groups: {}, missing: {}, available: {} };
}

const clone = <T>(value: T): T => structuredClone(value);

type Handler = (staged: Factory, message: WireMessage) => void;

/** BatchRequest may only contain factory mutations, never reads or sessions. */
const BATCH_CHILD_TYPES = new Set([
  "PipeAdd", "PipeEdit", "PipeDel",
  "MachineAdd", "MachineEdit", "MachineDel",
  "GroupAdd", "GroupEdit", "GroupDel",
  "PeriphAdd", "PeriphDel",
]);

const PIPE_MODES = new Set(["natural", "spread"]);

/** Top-level keys accepted for each batch child. `type`/`reqId` are common. */
const REQUEST_KEYS: Record<string, Set<string>> = {
  PipeAdd: new Set(["type", "reqId", "pipe"]),
  PipeEdit: new Set(["type", "reqId", "pipeId", "edits"]),
  PipeDel: new Set(["type", "reqId", "pipeId"]),
  MachineAdd: new Set(["type", "reqId", "machine"]),
  MachineEdit: new Set(["type", "reqId", "machineId", "edits"]),
  MachineDel: new Set(["type", "reqId", "machineId"]),
  GroupAdd: new Set(["type", "reqId", "group", "machineId"]),
  GroupEdit: new Set(["type", "reqId", "groupId", "edits"]),
  GroupDel: new Set(["type", "reqId", "groupId"]),
  PeriphAdd: new Set(["type", "reqId", "periphId", "options"]),
  PeriphDel: new Set(["type", "reqId", "periphId"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 1 && Number.isInteger(value);
}

/** Reject unknown keys so callers cannot inject identity/relationship fields. */
function allowedKeysError(value: Record<string, unknown>, allowed: Set<string>, label: string): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${label} contains unsupported field: ${key}`;
  }
  return null;
}

/** JSON arrays are contiguous in JS unless they were built sparsely. */
function contiguousArrayError(value: unknown, label: string): string | null {
  if (!Array.isArray(value)) return `${label} must be an array`;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return `${label} must not contain holes`;
  }
  return null;
}

/** Normalized slot identity, mirroring `sigils/batchValidation.lua#slotKey`. */
function slotKey(slot: Record<string, unknown>): string {
  return `${String(slot.periphId)}#${slot.slot === undefined ? "fluid" : String(slot.slot)}`;
}

function slotListError(
  value: unknown,
  label: string,
  options: { nonEmpty?: boolean; requireSlot?: boolean } = {},
): string | null {
  const arrayError = contiguousArrayError(value, label);
  if (arrayError) return arrayError;
  const slots = value as unknown[];
  if (options.nonEmpty && slots.length === 0) return `${label} must not be empty`;

  const seen = new Set<string>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const slotLabel = `${label}[${index + 1}]`;
    if (!isRecord(slot)) return `${slotLabel} must be an object`;
    const keysError = allowedKeysError(slot, new Set(["periphId", "slot"]), slotLabel);
    if (keysError) return keysError;
    if (!isNonEmptyString(slot.periphId)) return `${slotLabel}.periphId must be a non-empty string`;
    if (slot.slot !== undefined) {
      if (!isPositiveInteger(slot.slot)) return `${slotLabel}.slot must be a positive integer`;
    } else if (options.requireSlot) {
      return `${slotLabel}.slot is required for item groups`;
    }

    const key = slotKey(slot);
    if (seen.has(key)) return `${label} duplicates slot ${key}`;
    seen.add(key);
  }
  return null;
}

function coordinatesError(value: Record<string, unknown>, label: string): string | null {
  for (const field of ["x", "y"]) {
    const candidate = value[field];
    if (candidate !== undefined && !isFiniteNumber(candidate)) {
      return `${label}.${field} must be a finite number`;
    }
  }
  return null;
}

function modeError(value: unknown, label: string): string | null {
  if (value !== undefined && !PIPE_MODES.has(value as string)) {
    return `${label} must be natural or spread`;
  }
  return null;
}

function stringArrayError(value: unknown, label: string): string | null {
  const arrayError = contiguousArrayError(value, label);
  if (arrayError) return arrayError;
  const entries = value as unknown[];
  for (let index = 0; index < entries.length; index += 1) {
    if (!isNonEmptyString(entries[index])) return `${label}[${index + 1}] must be a non-empty string`;
  }
  return null;
}

/**
 * Mirrors `sigils/batchValidation.lua`: request shape, field whitelists, nested
 * objects, enums and finite-number checks. Returns `null` when the child is
 * valid, otherwise a diagnostic message.
 */
export function batchChildError(child: unknown): string | null {
  if (!isRecord(child)) return "child must be an object";
  if (typeof child.type !== "string") return "child type must be a string";
  if (!BATCH_CHILD_TYPES.has(child.type)) return `unsupported child type: ${child.type}`;

  const prefix = `child (${child.type})`;
  const keysError = allowedKeysError(child, REQUEST_KEYS[child.type], prefix);
  if (keysError) return keysError;
  if (child.reqId !== undefined && !isNonEmptyString(child.reqId)) {
    return `${prefix}: reqId must be a non-empty string`;
  }

  switch (child.type) {
    case "PipeAdd": {
      const pipe = child.pipe;
      if (!isRecord(pipe)) return "pipe must be an object";
      const pipeKeysError = allowedKeysError(
        pipe, new Set(["id", "from", "to", "mode", "nickname", "filter"]), "pipe",
      );
      if (pipeKeysError) return pipeKeysError;
      if (!isNonEmptyString(pipe.id) || !isNonEmptyString(pipe.from) || !isNonEmptyString(pipe.to)) {
        return "pipe requires non-empty id, from and to";
      }
      if (!isOptionalString(pipe.nickname) || !isOptionalString(pipe.filter)) {
        return "pipe nickname/filter must be strings";
      }
      return modeError(pipe.mode, "pipe.mode");
    }
    case "PipeEdit": {
      if (!isNonEmptyString(child.pipeId)) return "pipeId is required";
      if (!isRecord(child.edits)) return "edits must be an object";
      const editsKeysError = allowedKeysError(child.edits, new Set(["mode", "nickname", "filter"]), "edits");
      if (editsKeysError) return editsKeysError;
      if (!isOptionalString(child.edits.nickname) || !isOptionalString(child.edits.filter)) {
        return "edits nickname/filter must be strings";
      }
      return modeError(child.edits.mode, "edits.mode");
    }
    case "PipeDel":
      return isNonEmptyString(child.pipeId) ? null : "pipeId is required";
    case "MachineAdd": {
      const machine = child.machine;
      if (!isRecord(machine)) return "machine must be an object";
      const machineKeysError = allowedKeysError(
        machine, new Set(["id", "groups", "nickname", "x", "y"]), "machine",
      );
      if (machineKeysError) return machineKeysError;
      if (!isNonEmptyString(machine.id)) return "machine.id is required";
      const groupsError = stringArrayError(machine.groups, "machine.groups");
      if (groupsError) return groupsError;
      if (!isOptionalString(machine.nickname)) return "machine.nickname must be a string";
      return coordinatesError(machine, "machine");
    }
    case "MachineEdit": {
      if (!isNonEmptyString(child.machineId)) return "machineId is required";
      if (!isRecord(child.edits)) return "edits must be an object";
      // groups / id / peripheral identity are relationship fields, not editable here.
      const editsKeysError = allowedKeysError(child.edits, new Set(["nickname", "x", "y"]), "edits");
      if (editsKeysError) return editsKeysError;
      if (!isOptionalString(child.edits.nickname)) return "edits.nickname must be a string";
      return coordinatesError(child.edits, "edits");
    }
    case "MachineDel":
      return isNonEmptyString(child.machineId) ? null : "machineId is required";
    case "GroupAdd": {
      const group = child.group;
      if (!isRecord(group)) return "group must be an object";
      const groupKeysError = allowedKeysError(
        group, new Set(["id", "slots", "nickname", "x", "y", "fluid"]), "group",
      );
      if (groupKeysError) return groupKeysError;
      if (!isNonEmptyString(group.id)) return "group.id is required";
      if (!isNonEmptyString(child.machineId)) return "machineId is required for GroupAdd";
      const fluid = group.fluid === true;
      const slotsError = slotListError(group.slots, "group.slots", { nonEmpty: true, requireSlot: !fluid });
      if (slotsError) return slotsError;
      if (!isOptionalString(group.nickname)) return "group.nickname must be a string";
      if (group.fluid !== undefined && typeof group.fluid !== "boolean") return "group.fluid must be a boolean";
      return coordinatesError(group, "group");
    }
    case "GroupEdit": {
      if (!isNonEmptyString(child.groupId)) return "groupId is required";
      if (!isRecord(child.edits)) return "edits must be an object";
      // id / owning-machine identity are not editable through GroupEdit.
      const editsKeysError = allowedKeysError(
        child.edits, new Set(["nickname", "x", "y", "fluid", "slots"]), "edits",
      );
      if (editsKeysError) return editsKeysError;
      if (!isOptionalString(child.edits.nickname)) return "edits.nickname must be a string";
      if (child.edits.fluid !== undefined && typeof child.edits.fluid !== "boolean") {
        return "edits.fluid must be a boolean";
      }
      if (child.edits.slots !== undefined) {
        const slotsError = slotListError(child.edits.slots, "edits.slots", {
          nonEmpty: true,
          requireSlot: child.edits.fluid === false,
        });
        if (slotsError) return slotsError;
      }
      return coordinatesError(child.edits, "edits");
    }
    case "GroupDel":
      return isNonEmptyString(child.groupId) ? null : "groupId is required";
    case "PeriphAdd": {
      if (!isNonEmptyString(child.periphId)) return "periphId is required";
      const options = child.options;
      if (options === undefined || options === null) return null;
      if (!isRecord(options)) return "options must be an object";
      // PeriphAdd initialises a Machine; only presentation/placement is safe.
      const optionsKeysError = allowedKeysError(options, new Set(["nickname", "x", "y"]), "options");
      if (optionsKeysError) return optionsKeysError;
      if (!isOptionalString(options.nickname)) return "options.nickname must be a string";
      return coordinatesError(options, "options");
    }
    case "PeriphDel":
      return isNonEmptyString(child.periphId) ? null : "periphId is required";
    default:
      return `unsupported child type: ${child.type}`;
  }
}

/**
 * Factory-dependent Group integrity, mirroring
 * `sigils/batchValidation.lua#validateFactoryIntegrity`.
 */
export function groupIntegrityError(child: unknown, factory: Factory): string | null {
  if (!isRecord(child)) return "child must be an object";

  if (child.type === "GroupAdd") {
    const group = child.group;
    if (!isRecord(group)) return "group must be an object";
    const machine = factory.machines[child.machineId as string];
    if (!machine) return `machine not found: ${String(child.machineId)}`;

    const slots = (group.slots as Array<Record<string, unknown>> | undefined) ?? [];
    const fluid = group.fluid === true;
    if (!fluid) {
      for (let index = 0; index < slots.length; index += 1) {
        if (slots[index].slot === undefined) {
          return `group.slots[${index + 1}].slot is required for item groups`;
        }
      }
    }
    return null;
  }

  if (child.type === "GroupEdit") {
    const edits = child.edits;
    if (!isRecord(edits) || edits.slots === undefined) return null;

    const group = factory.groups[child.groupId as string];
    if (!group) return `group not found: ${String(child.groupId)}`;

    const slots = edits.slots as Array<Record<string, unknown>>;
    const fluid = edits.fluid === undefined ? group.fluid === true : edits.fluid === true;
    if (!fluid) {
      for (let index = 0; index < slots.length; index += 1) {
        if (slots[index].slot === undefined) {
          return `edits.slots[${index + 1}].slot is required for item groups`;
        }
      }
    }
    return null;
  }

  return null;
}

/** Mirror of `BatchValidation.collectAffectedGroupIds`. */
export function collectAffectedGroupIds(requests: unknown[]): Set<string> {
  const affected = new Set<string>();
  for (const request of requests) {
    if (!isRecord(request)) continue;
    if (request.type === "GroupAdd" && isRecord(request.group) && isNonEmptyString(request.group.id)) {
      affected.add(request.group.id);
    } else if ((request.type === "GroupEdit" || request.type === "GroupDel")
      && isNonEmptyString(request.groupId)) {
      affected.add(request.groupId);
    }
  }
  return affected;
}

/** Mirror of `BatchValidation.validateSlotOwnership`, run on the staged Factory. */
export function slotOwnershipError(factory: Factory, affectedGroupIds: Set<string>): string | null {
  const machines = new Map<string, Machine>();
  for (const groupId of affectedGroupIds) {
    for (const machine of Object.values(factory.machines)) {
      if (machine.groups.includes(groupId)) machines.set(machine.id, machine);
    }
  }

  for (const machine of machines.values()) {
    const seen = new Map<string, string>();
    for (const groupId of machine.groups) {
      const group = factory.groups[groupId];
      if (!group) continue;
      for (const slot of group.slots) {
        const key = slotKey(slot as unknown as Record<string, unknown>);
        const owner = seen.get(key);
        if (owner) {
          return `slot ${key} on machine ${machine.id} is referenced by both ${owner} and ${groupId}`;
        }
        seen.set(key, groupId);
      }
    }
  }
  return null;
}

/**
 * In-memory model of SIGILS v4.3 `controller.lua` + `factory.lua`.
 *
 * Mirrors the game-side flow that matters for the editor: staged clone ->
 * ordered handler execution -> single save -> commit -> confirmation carrying
 * jsondiffpatch deltas. Batch children must be known mutation types with their
 * required fields; invalid batches are rejected before any mutation.
 */
export class FakeCc {
  factory: Factory;
  sent: WireMessage[] = [];
  /** Number of upcoming saves that should fail, to exercise the rollback path. */
  failSaves = 0;
  /** Number of save attempts, mirroring `Factory.saveFactory` calls. */
  saveCount = 0;

  private readonly inventories: Record<PeriphId, number>;
  private readonly fluids: Set<PeriphId>;

  constructor(options: FakeCcOptions = {}) {
    this.factory = clone(options.factory ?? emptyFactory());
    this.inventories = { ...(options.inventories ?? {}) };
    this.fluids = new Set(options.fluids ?? []);
  }

  get lastSent(): WireMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** `FactoryGet` is handled inline because its response carries the factory. */
  receive(message: WireMessage): void {
    if (message.type === "FactoryGet") {
      this.sent.push({
        type: "ConfirmationResponse",
        respondingTo: "FactoryGet",
        ...(message.reqId ? { reqId: message.reqId } : {}),
        ok: true,
        factory: clone(this.factory),
      });
      return;
    }

    if (message.type === "BatchRequest") {
      this.receiveBatch(message);
      return;
    }

    const handler = this.handlers[message.type];
    // v4.3 `applySingleRequest` returns silently when no handler exists.
    if (!handler) return;

    const schemaError = batchChildError(message);
    if (schemaError) {
      this.sendConfirmation(message, false, [], schemaError);
      return;
    }
    const integrityError = groupIntegrityError(message, this.factory);
    if (integrityError) {
      this.sendConfirmation(message, false, [], integrityError);
      return;
    }

    this.commit(
      message,
      staged => handler.call(this, staged, message),
      staged => slotOwnershipError(staged, collectAffectedGroupIds([message])),
    );
  }

  /** v4.3 `applyBatchRequest`: contiguous array, ordered children, one save. */
  private receiveBatch(message: WireMessage): void {
    const requests = message.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      this.sendConfirmation(message, false, [], "requests must be a non-empty array");
      return;
    }
    for (const request of requests) {
      const error = batchChildError(request);
      if (error) {
        this.sendConfirmation(message, false, [], error);
        return;
      }
    }
    const affected = collectAffectedGroupIds(requests);

    this.commit(message, staged => {
      // Ordered execution: array order is part of the protocol.
      for (const request of requests as WireMessage[]) {
        const integrityError = groupIntegrityError(request, staged);
        if (integrityError) throw new Error(integrityError);
        const handler = this.handlers[request.type];
        if (!handler) throw new Error(`unsupported batch child: ${request.type}`);
        handler.call(this, staged, request);
      }
    }, staged => slotOwnershipError(staged, affected));
  }

  private commit(
    message: WireMessage,
    run: (staged: Factory) => void,
    validate?: (staged: Factory) => string | null,
  ): void {
    const before = clone(this.factory);
    const staged = clone(this.factory);

    try {
      run(staged);
      const validationError = validate?.(staged);
      if (validationError) throw new Error(validationError);
    } catch (error) {
      this.sendConfirmation(message, false, [], error instanceof Error ? error.message : undefined);
      return;
    }

    // Validation succeeded; this mirrors the single Factory.saveFactory call.
    this.saveCount += 1;
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      this.sendConfirmation(message, false);
      return;
    }

    this.factory = staged;
    const forward = diff(before, staged);
    this.sendConfirmation(message, true, forward ? [forward] : []);
  }

  private sendConfirmation(message: WireMessage, ok: boolean, deltas: unknown[] = [], failure?: string): void {
    this.sent.push({
      type: "ConfirmationResponse",
      respondingTo: message.type,
      ...(message.reqId ? { reqId: message.reqId } : {}),
      ok,
      diff: deltas,
      ...(!ok && failure ? { message: failure } : {}),
    });
  }

  private readonly handlers: Record<string, Handler> = {
    PipeAdd: (staged, message) => {
      const pipe = message.pipe as Pipe;
      staged.pipes[pipe.id] = clone(pipe);
    },
    PipeEdit: (staged, message) => {
      const pipe = staged.pipes[message.pipeId as string];
      if (!pipe) throw new Error("pipe not found");
      Object.assign(pipe, message.edits as Partial<Pipe>);
    },
    PipeDel: (staged, message) => {
      delete staged.pipes[message.pipeId as string];
    },
    MachineAdd: (staged, message) => {
      const machine = message.machine as Machine;
      staged.machines[machine.id] = clone(machine);
    },
    MachineEdit: (staged, message) => {
      const machine = staged.machines[message.machineId as string];
      if (!machine) throw new Error("machine not found");
      Object.assign(machine, message.edits as Partial<Machine>);
    },
    MachineDel: (staged, message) => {
      delete staged.machines[message.machineId as string];
    },
    GroupAdd: (staged, message) => {
      const group = message.group as Group;
      staged.groups[group.id] = clone(group);
      if (message.machineId) {
        const machine = staged.machines[message.machineId as string];
        // v4.3 indexes machine.groups without a nil check, which raises.
        if (!machine) throw new Error("machine not found");
        machine.groups = [...machine.groups, group.id];
      }
    },
    GroupEdit: (staged, message) => {
      const group = staged.groups[message.groupId as string];
      if (!group) throw new Error("group not found");
      Object.assign(group, message.edits as Partial<Group>);
    },
    GroupDel: (staged, message) => {
      this.deleteGroup(staged, message.groupId as string);
    },
    PeriphAdd: (staged, message) => {
      const periphId = message.periphId as string;
      const { machine, groups } = this.buildMachine(periphId);
      Object.assign(machine, (message.options as Partial<Machine> | undefined) ?? {});
      delete staged.available[periphId];
      staged.machines[machine.id] = machine;
      for (const group of Object.values(groups)) staged.groups[group.id] = group;
    },
    PeriphDel: (staged, message) => {
      this.deletePeripheral(staged, message.periphId as string);
    },
  };

  /** v4.3 `groupDel`: drops the group, its pipes, and the machine when it empties. */
  private deleteGroup(staged: Factory, groupId: string): void {
    delete staged.groups[groupId];

    for (const [pipeId, pipe] of Object.entries(staged.pipes)) {
      if (pipe.from === groupId || pipe.to === groupId) delete staged.pipes[pipeId];
    }

    for (const machine of Object.values(staged.machines)) {
      if (!machine.groups.includes(groupId)) continue;
      machine.groups = machine.groups.filter(id => id !== groupId);
      if (machine.groups.length === 0) delete staged.machines[machine.id];
      // v4.3 stops after the first machine that owned the group.
      break;
    }
  }

  /** v4.3 `periphDel`: strips the peripheral's slots, deleting groups that empty. */
  private deletePeripheral(staged: Factory, periphId: string): void {
    delete staged.missing[periphId];

    for (const groupId of Object.keys(staged.groups)) {
      const group = staged.groups[groupId];
      if (!group) continue;
      const keptSlots = group.slots.filter(slot => slot.periphId !== periphId);
      if (keptSlots.length === 0) this.deleteGroup(staged, groupId);
      else if (keptSlots.length !== group.slots.length) group.slots = keptSlots;
    }
  }

  /** Mirrors `machine.lua` templates: one group per slot, or one fluid group. */
  private buildMachine(periphId: string): { machine: Machine; groups: Record<string, Group> } {
    const groups: Record<string, Group> = {};
    const machine: Machine = { id: periphId, groups: [] };

    if (this.fluids.has(periphId)) {
      const groupId = `${periphId}:fluids`;
      groups[groupId] = { id: groupId, nickname: "Fluid tank", fluid: true, slots: [{ periphId }] };
      machine.groups.push(groupId);
      return { machine, groups };
    }

    const groupId = `${periphId}:g1`;
    const size = this.inventories[periphId] ?? 1;
    groups[groupId] = {
      id: groupId,
      nickname: "Inventory",
      slots: Array.from({ length: size }, (_, index) => ({ periphId, slot: index + 1 })),
    };
    machine.groups.push(groupId);
    return { machine, groups };
  }

  /**
   * Recompute `missing` / `available` for the peripherals on the network and
   * emit `CcUpdatedFactory`, mirroring `updateWithPeriphChanges`.
   */
  syncPeripherals(currentPeriphIds: PeriphId[]): void {
    const before = clone(this.factory);
    const current = new Set(currentPeriphIds);
    const represented = new Set<PeriphId>();
    for (const group of Object.values(this.factory.groups)) {
      for (const slot of group.slots) represented.add(slot.periphId);
    }

    for (const periphId of represented) if (!current.has(periphId)) this.factory.missing[periphId] = true;
    for (const periphId of current) if (!represented.has(periphId)) this.factory.available[periphId] = true;
    for (const periphId of Object.keys(this.factory.missing)) if (current.has(periphId)) delete this.factory.missing[periphId];
    for (const periphId of Object.keys(this.factory.available)) if (!current.has(periphId)) delete this.factory.available[periphId];

    const delta = diff(before, this.factory);
    if (delta) this.sent.push({ type: "CcUpdatedFactory", diff: [delta] });
  }
}
