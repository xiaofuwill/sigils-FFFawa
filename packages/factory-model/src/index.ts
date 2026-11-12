/**
 * Wire-compatible model copied from the public SIGILS server type contract.
 * Do not add editor-only or runtime-only fields to Factory without a protocol
 * version negotiation: CC:Tweaked persists this exact shape as factory.json.
 */
export type PipeId = string;
export type PeriphId = string;
export type GroupId = string;
export type MachineId = string;

export type PipeMode = "natural" | "spread";

export interface Pipe {
  id: PipeId;
  from: GroupId;
  to: GroupId;
  mode?: PipeMode;
  nickname?: string;
  filter?: string;
}

/**
 * A slot on a peripheral. Fluid tank groups created by `machine.lua#addFluidTank`
 * carry `slot = nil`, which disappears from factory.json, so `slot` is optional.
 */
export interface Slot {
  periphId: PeriphId;
  slot?: number;
}

export interface Group {
  id: GroupId;
  slots: Slot[];
  nickname?: string;
  x?: number;
  y?: number;
  fluid?: boolean;
}

export interface Machine {
  id: MachineId;
  groups: GroupId[];
  nickname?: string;
  x?: number;
  y?: number;
}

/** Lua-style ID -> boolean maps, not arrays. */
export type PeriphMap = Record<PeriphId, boolean>;
export type PipeMap = Record<PipeId, Pipe>;
export type GroupMap = Record<GroupId, Group>;
export type MachineMap = Record<MachineId, Machine>;

/** Exact persisted / WebSocket factory root shape used by SIGILS v4.3. */
export interface Factory {
  pipes: PipeMap;
  machines: MachineMap;
  groups: GroupMap;
  missing: PeriphMap;
  available: PeriphMap;
}

export const EMPTY_FACTORY: Factory = {
  pipes: {},
  machines: {},
  groups: {},
  missing: {},
  available: {},
};

export type FactoryMapName = keyof Factory;

export interface FactoryValidationIssue {
  path: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural validation only. Referential integrity is checked separately. */
export function validateFactoryShape(value: unknown): FactoryValidationIssue[] {
  const issues: FactoryValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: "$", message: "Factory must be an object" }];

  for (const key of ["pipes", "machines", "groups", "missing", "available"] as const) {
    if (!isRecord(value[key])) issues.push({ path: key, message: `Expected an object map for ${key}` });
  }
  if (issues.length) return issues;

  const pipes = value.pipes as Record<string, unknown>;
  for (const [id, raw] of Object.entries(pipes)) {
    const path = `pipes.${id}`;
    if (!isRecord(raw)) { issues.push({ path, message: "Pipe must be an object" }); continue; }
    if (raw.id !== id) issues.push({ path: `${path}.id`, message: "Pipe map key must equal pipe.id" });
    if (typeof raw.from !== "string") issues.push({ path: `${path}.from`, message: "Expected group ID string" });
    if (typeof raw.to !== "string") issues.push({ path: `${path}.to`, message: "Expected group ID string" });
    if (raw.mode !== undefined && raw.mode !== "natural" && raw.mode !== "spread") issues.push({ path: `${path}.mode`, message: "Unsupported pipe mode" });
    if (raw.nickname !== undefined && typeof raw.nickname !== "string") issues.push({ path: `${path}.nickname`, message: "Expected string" });
    if (raw.filter !== undefined && typeof raw.filter !== "string") issues.push({ path: `${path}.filter`, message: "Expected string" });
  }

  const groups = value.groups as Record<string, unknown>;
  for (const [id, raw] of Object.entries(groups)) {
    const path = `groups.${id}`;
    if (!isRecord(raw)) { issues.push({ path, message: "Group must be an object" }); continue; }
    if (raw.id !== id) issues.push({ path: `${path}.id`, message: "Group map key must equal group.id" });
    if (!Array.isArray(raw.slots)) issues.push({ path: `${path}.slots`, message: "Expected slot array" });
    else {
      const fluidGroup = raw.fluid === true;
      raw.slots.forEach((slot, index) => {
        const slotPath = `${path}.slots[${index}]`;
        if (!isRecord(slot) || typeof slot.periphId !== "string") {
          issues.push({ path: slotPath, message: "Slot requires a string periphId" });
          return;
        }
        // Fluid tank groups hold one peripheral-level slot without a slot number.
        if (slot.slot === undefined) {
          if (!fluidGroup) issues.push({ path: slotPath, message: "Item group slot requires an integer slot number" });
          return;
        }
        if (!Number.isInteger(slot.slot)) issues.push({ path: slotPath, message: "Slot number must be an integer" });
      });
    }
    for (const field of ["x", "y"] as const) if (raw[field] !== undefined && typeof raw[field] !== "number") issues.push({ path: `${path}.${field}`, message: "Expected number" });
    if (raw.fluid !== undefined && typeof raw.fluid !== "boolean") issues.push({ path: `${path}.fluid`, message: "Expected boolean" });
    if (raw.nickname !== undefined && typeof raw.nickname !== "string") issues.push({ path: `${path}.nickname`, message: "Expected string" });
  }

  const machines = value.machines as Record<string, unknown>;
  for (const [id, raw] of Object.entries(machines)) {
    const path = `machines.${id}`;
    if (!isRecord(raw)) { issues.push({ path, message: "Machine must be an object" }); continue; }
    if (raw.id !== id) issues.push({ path: `${path}.id`, message: "Machine map key must equal machine.id" });
    if (!Array.isArray(raw.groups) || !raw.groups.every((v) => typeof v === "string")) issues.push({ path: `${path}.groups`, message: "Expected group ID array" });
    for (const field of ["x", "y"] as const) if (raw[field] !== undefined && typeof raw[field] !== "number") issues.push({ path: `${path}.${field}`, message: "Expected number" });
    if (raw.nickname !== undefined && typeof raw.nickname !== "string") issues.push({ path: `${path}.nickname`, message: "Expected string" });
  }

  for (const key of ["missing", "available"] as const) {
    for (const [id, flag] of Object.entries(value[key] as Record<string, unknown>)) {
      if (typeof flag !== "boolean") issues.push({ path: `${key}.${id}`, message: "Expected boolean" });
    }
  }
  return issues;
}

/** Cross-reference validation; does not mutate or repair the input. */
export function validateFactoryReferences(factory: Factory): FactoryValidationIssue[] {
  const issues: FactoryValidationIssue[] = [];
  const parentByGroup = new Map<string, string>();

  for (const [machineId, machine] of Object.entries(factory.machines)) {
    for (const groupId of machine.groups) {
      if (!factory.groups[groupId]) issues.push({ path: `machines.${machineId}.groups`, message: `References missing group ${groupId}` });
      const previous = parentByGroup.get(groupId);
      if (parentByGroup.has(groupId)) issues.push({ path: `machines.${machineId}.groups`, message: `Group ${groupId} is also owned by machine ${previous}` });
      else parentByGroup.set(groupId, machineId);
    }
  }

  for (const groupId of Object.keys(factory.groups)) {
    if (!parentByGroup.has(groupId)) issues.push({ path: `groups.${groupId}`, message: "Group is not owned by any machine" });
  }

  for (const [pipeId, pipe] of Object.entries(factory.pipes)) {
    if (!factory.groups[pipe.from]) issues.push({ path: `pipes.${pipeId}.from`, message: `References missing group ${pipe.from}` });
    if (!factory.groups[pipe.to]) issues.push({ path: `pipes.${pipeId}.to`, message: `References missing group ${pipe.to}` });
  }
  return issues;
}
