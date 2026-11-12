import type { Factory, Group, MachineId, PeriphId, Slot } from "../../../packages/factory-model/src/index";
import type { BatchRequest, GroupAddRequest, GroupEditRequest } from "../../../packages/protocol/src/index";
import type { IdFactory } from "./factoryActions";

const randomId: IdFactory = () => crypto.randomUUID();

/**
 * Group / Slot operations built only from the existing v4.3 messages.
 *
 * `factory.lua#groupAdd` inserts the supplied group verbatim and `groupEdit`
 * assigns every supplied key without validation, so this module repeats the
 * checks the game side does not perform: ID collisions, slot ownership,
 * duplicate slots and Item/Fluid mixing.
 */

export function slotKey(slot: Slot): string {
  return `${slot.periphId}#${slot.slot ?? "fluid"}`;
}

/** Slot order used by the upstream editor when it rewrites a slot list. */
export function sortSlots(slots: Slot[]): Slot[] {
  return [...slots].sort((left, right) => {
    const leftSlot = left.slot ?? 0;
    const rightSlot = right.slot ?? 0;
    if (leftSlot !== rightSlot) return leftSlot - rightSlot;
    if (left.periphId === right.periphId) return 0;
    return left.periphId > right.periphId ? 1 : -1;
  });
}

/** All slots currently referenced by the machine's groups, deduplicated. */
export function getMachineSlots(factory: Factory, machineId: MachineId): Slot[] {
  const machine = requireMachine(factory, machineId);
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (const groupId of machine.groups) {
    const group = factory.groups[groupId];
    if (!group) continue;
    for (const slot of group.slots) {
      const key = slotKey(slot);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ ...slot });
    }
  }
  return slots;
}

/** Slots of one peripheral that the machine already knows about. */
export function getMachinePeripheralSlots(factory: Factory, machineId: MachineId, periphId: PeriphId): Slot[] {
  return getMachineSlots(factory, machineId).filter(slot => slot.periphId === periphId);
}

/** Slot keys owned by any group of the machine other than `exceptGroupId`. */
export function getAssignedSlotKeys(factory: Factory, machineId: MachineId, exceptGroupId?: string): Set<string> {
  const machine = requireMachine(factory, machineId);
  const assigned = new Set<string>();
  for (const groupId of machine.groups) {
    if (groupId === exceptGroupId) continue;
    const group = factory.groups[groupId];
    if (!group) continue;
    for (const slot of group.slots) assigned.add(slotKey(slot));
  }
  return assigned;
}

/** Machine that owns the group, or undefined for an orphan record. */
export function findGroupOwner(factory: Factory, groupId: string): MachineId | undefined {
  for (const [machineId, machine] of Object.entries(factory.machines)) {
    if (machine.groups.includes(groupId)) return machineId;
  }
  return undefined;
}

/** Every peripheral currently referenced by a group slot. */
export function getFactoryPeriphIds(factory: Factory): Set<PeriphId> {
  const periphIds = new Set<PeriphId>();
  for (const group of Object.values(factory.groups)) {
    for (const slot of group.slots) periphIds.add(slot.periphId);
  }
  return periphIds;
}

/**
 * Peripherals that used to be part of a container but are no longer referenced
 * by any group, and are not known to be missing. They are safe to offer again in
 * the "available peripherals" card; re-adding them sends `PeriphAdd`, which CC
 * validates against the real peripheral list.
 */
export function findReleasedPeriphs(previous: ReadonlySet<PeriphId>, factory: Factory): PeriphId[] {
  const current = getFactoryPeriphIds(factory);
  const released: PeriphId[] = [];
  for (const periphId of previous) {
    if (current.has(periphId)) continue;
    if (factory.missing[periphId] || factory.available[periphId]) continue;
    released.push(periphId);
  }
  return released;
}

/**
 * Slots that exist only inside `groupIds`.
 *
 * Slots live as group references, so deleting a group removes its slots from the
 * Factory. This returns the ones no other group still references, letting the
 * caller warn about them and keep them for an in-session restore.
 */
export function getOrphanedSlots(factory: Factory, groupIds: string[]): Slot[] {
  const removed = new Set(groupIds);
  const remaining = new Set<string>();
  for (const [groupId, group] of Object.entries(factory.groups)) {
    if (removed.has(groupId)) continue;
    for (const slot of group.slots) remaining.add(slotKey(slot));
  }

  const seen = new Set<string>();
  const orphaned: Slot[] = [];
  for (const groupId of groupIds) {
    const group = factory.groups[groupId];
    if (!group) continue;
    for (const slot of group.slots) {
      const key = slotKey(slot);
      if (remaining.has(key) || seen.has(key)) continue;
      seen.add(key);
      orphaned.push({ ...slot });
    }
  }
  return sortSlots(orphaned);
}

/**
 * Suggest the next free `${periphId}:g${n}` id.
 * `machine.lua` uses that pattern, and a colliding id would silently replace an
 * existing group because `groupAdd` does not check for duplicates.
 */
export function suggestGroupId(factory: Factory, periphId: PeriphId): string {
  let index = 1;
  while (factory.groups[`${periphId}:g${index}`]) index += 1;
  return `${periphId}:g${index}`;
}

/**
 * Create a group from slots that no group of the machine references yet.
 *
 * Not reachable from the UI: the Factory snapshot carries no inventory capacity,
 * so the editor cannot enumerate slots that exist but are unreferenced. It stays
 * as the single, validated construction path for when a capacity API exists.
 */
export function buildGroupCreate(
  factory: Factory,
  machineId: MachineId,
  slots: Slot[],
  nickname: string | undefined,
  idFactory: IdFactory = randomId,
): GroupAddRequest {
  requireMachine(factory, machineId);
  const normalized = normalizeSlots(slots);
  const assigned = getAssignedSlotKeys(factory, machineId);

  for (const slot of normalized) {
    const key = slotKey(slot);
    const owner = findSlotOwner(factory, machineId, key);
    if (assigned.has(key)) throw new Error(`槽位 ${key} 已属于分组 ${owner?.id ?? "(未知)"}；请改用拆分操作。`);
  }

  const periphIds = new Set(getMachineSlots(factory, machineId).map(slot => slot.periphId));
  for (const slot of normalized) {
    if (!periphIds.has(slot.periphId)) throw new Error(`外设 ${slot.periphId} 不属于该 Machine。`);
  }

  const groupId = suggestGroupId(factory, normalized[0].periphId);
  const group: Group = {
    id: groupId,
    slots: normalized,
    nickname: nickname?.trim() ? nickname.trim() : `Slot ${groupId.slice(groupId.lastIndexOf(":g") + 2)}`,
  };
  return { type: "GroupAdd", reqId: idFactory(), group, machineId };
}

/**
 * Split slots off an existing group into a new group of the same machine.
 * Sent as one ordered `BatchRequest`: the controller executes the children in
 * array order and saves once. Rollback on failure is not guaranteed.
 * `position` is relative to the owning machine node, matching the nested
 * React Flow layout used by the canvas.
 */
export function buildGroupSplit(
  factory: Factory,
  sourceGroupId: string,
  slots: Slot[],
  nickname: string | undefined,
  idFactory: IdFactory = randomId,
  position?: { x: number; y: number },
): BatchRequest {
  const source = requireGroup(factory, sourceGroupId);
  if (source.fluid === true) throw new Error("流体 Group 不能拆分。");
  const machineId = findGroupOwner(factory, sourceGroupId);
  if (!machineId) throw new Error(`Group ${sourceGroupId} 不属于任何 Machine，无法安全拆分。`);

  const moving = normalizeSlots(slots);
  const sourceKeys = new Set(source.slots.map(slotKey));
  for (const slot of moving) {
    if (!sourceKeys.has(slotKey(slot))) throw new Error(`槽位 ${slotKey(slot)} 不在 Group ${sourceGroupId} 中。`);
  }
  if (moving.length === source.slots.length) throw new Error("不能把 Group 的全部槽位拆出；请改用 Group 合并或删除。");

  const groupId = suggestGroupId(factory, moving[0].periphId);
  const movingKeys = new Set(moving.map(slotKey));
  const remaining = sortSlots(source.slots.filter(slot => !movingKeys.has(slotKey(slot))));

  const group: Group = {
    id: groupId,
    slots: moving,
    ...(nickname?.trim() ? { nickname: nickname.trim() } : {}),
    ...(position ? { x: position.x, y: position.y } : {}),
  };

  return {
    type: "BatchRequest",
    reqId: idFactory(),
    requests: [
      { type: "GroupAdd", reqId: idFactory(), group, machineId },
      { type: "GroupEdit", reqId: idFactory(), groupId: sourceGroupId, edits: { slots: remaining } },
    ],
  };
}

export type GroupMergeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Container merge rules taken from the upstream editor
 * (`client/src/CombineHandlers.ts#combineGroups`):
 * - both containers must live in the same Machine;
 * - Item containers only merge with Item containers, Fluid with Fluid;
 * - the target keeps its identity and nickname, the source is deleted;
 * - every slot keeps its `(periphId, slot)` identity.
 */
export function canMergeGroups(factory: Factory, sourceId: string, targetId: string): GroupMergeCheck {
  if (sourceId === targetId) return { ok: false, reason: "不能把容器合并到自身。" };
  const source = factory.groups[sourceId];
  if (!source) return { ok: false, reason: `容器不存在：${sourceId}` };
  const target = factory.groups[targetId];
  if (!target) return { ok: false, reason: `容器不存在：${targetId}` };

  const sourceMachine = findGroupOwner(factory, sourceId);
  const targetMachine = findGroupOwner(factory, targetId);
  if (!sourceMachine || !targetMachine || sourceMachine !== targetMachine) {
    return { ok: false, reason: "只能在同一个机器框内合并容器。" };
  }
  if (Boolean(source.fluid) !== Boolean(target.fluid)) {
    return { ok: false, reason: "物品容器与液体容器不能合并。" };
  }
  if (source.slots.length === 0) return { ok: false, reason: "源容器没有槽位，无法合并。" };

  const targetKeys = new Set(target.slots.map(slotKey));
  for (const slot of source.slots) {
    const key = slotKey(slot);
    if (targetKeys.has(key)) return { ok: false, reason: `槽位 ${key} 同时存在于两个容器中，数据不一致。` };
  }
  return { ok: true };
}

/**
 * Merge a whole source container into a target container.
 *
 * This is the upstream `combineGroups` operation: one `GroupEdit` that replaces
 * the target slot list, followed by `GroupDel` for the source. Both travel in a
 * single ordered `BatchRequest`: the controller executes children in array order
 * and saves once after the batch. This is non-transactional — rollback after an
 * execution failure is not guaranteed, and success is only acknowledged after
 * the save step reports success. `GroupDel` also cascades the source container's
 * Pipes, matching upstream behaviour.
 */
export function buildGroupMerge(
  factory: Factory,
  sourceId: string,
  targetId: string,
  idFactory: IdFactory = randomId,
): BatchRequest {
  const check = canMergeGroups(factory, sourceId, targetId);
  if (!check.ok) throw new Error(check.reason);

  const source = requireGroup(factory, sourceId);
  const target = requireGroup(factory, targetId);
  const merged = sortSlots([
    ...target.slots.map(slot => ({ ...slot })),
    ...source.slots.map(slot => ({ ...slot })),
  ]);

  return {
    type: "BatchRequest",
    reqId: idFactory(),
    requests: [
      { type: "GroupEdit", reqId: idFactory(), groupId: targetId, edits: { slots: merged } },
      { type: "GroupDel", reqId: idFactory(), groupId: sourceId },
    ],
  };
}

/**
 * Replace a group's slot list. Slot numbers stay inside the owning machine, and
 * an empty list is rejected because the game side deletes empty groups during
 * peripheral cleanup.
 */
export function buildSlotUpdate(
  factory: Factory,
  groupId: string,
  slots: Slot[],
  idFactory: IdFactory = randomId,
): GroupEditRequest {
  const group = requireGroup(factory, groupId);
  if (group.fluid === true) throw new Error("流体 Group 的槽位由游戏端维护，不能手工编辑。");
  const machineId = findGroupOwner(factory, groupId);
  if (!machineId) throw new Error(`Group ${groupId} 不属于任何 Machine，无法安全编辑槽位。`);

  const normalized = normalizeSlots(slots);
  const assignedElsewhere = getAssignedSlotKeys(factory, machineId, groupId);
  const machinePeriphs = new Set(getMachineSlots(factory, machineId).map(slot => slot.periphId));

  for (const slot of normalized) {
    if (!machinePeriphs.has(slot.periphId)) throw new Error(`外设 ${slot.periphId} 不属于该 Machine，不能跨 Machine 移动槽位。`);
    const key = slotKey(slot);
    const owner = findSlotOwner(factory, machineId, key);
    if (assignedElsewhere.has(key)) throw new Error(`槽位 ${key} 已属于分组 ${owner?.id ?? "(未知)"}；同一槽位不能同时归两个分组。`);
  }

  return { type: "GroupEdit", reqId: idFactory(), groupId, edits: { slots: normalized } };
}

/** Move slots between two groups of the same machine in one ordered batch. */
export function buildSlotTransfer(
  factory: Factory,
  fromGroupId: string,
  toGroupId: string,
  slots: Slot[],
  idFactory: IdFactory = randomId,
): BatchRequest {
  const from = requireGroup(factory, fromGroupId);
  const to = requireGroup(factory, toGroupId);
  if (from.fluid === true || to.fluid === true) throw new Error("流体 Group 不能参与槽位移动。");

  const machineId = findGroupOwner(factory, fromGroupId);
  if (!machineId) throw new Error(`Group ${fromGroupId} 不属于任何 Machine。`);
  if (findGroupOwner(factory, toGroupId) !== machineId) throw new Error("只能在同一个 Machine 的 Group 之间移动槽位。");

  const moving = normalizeSlots(slots);
  const fromKeys = new Set(from.slots.map(slotKey));
  for (const slot of moving) {
    if (!fromKeys.has(slotKey(slot))) throw new Error(`槽位 ${slotKey(slot)} 不在 Group ${fromGroupId} 中。`);
  }
  if (moving.length === from.slots.length) throw new Error("移动全部槽位会留下空 Group；请改用 Group 删除。");

  const movingKeys = new Set(moving.map(slotKey));
  const targetKeys = new Set(to.slots.map(slotKey));
  for (const key of movingKeys) {
    if (targetKeys.has(key)) throw new Error(`目标 Group 已包含槽位 ${key}。`);
  }

  return {
    type: "BatchRequest",
    reqId: idFactory(),
    requests: [
      { type: "GroupEdit", reqId: idFactory(), groupId: fromGroupId, edits: { slots: sortSlots(from.slots.filter(slot => !movingKeys.has(slotKey(slot)))) } },
      { type: "GroupEdit", reqId: idFactory(), groupId: toGroupId, edits: { slots: sortSlots([...to.slots.map(slot => ({ ...slot })), ...moving]) } },
    ],
  };
}

function requireMachine(factory: Factory, machineId: MachineId) {
  const machine = factory.machines[machineId];
  if (!machine) throw new Error(`Machine 不存在：${machineId}`);
  return machine;
}

function requireGroup(factory: Factory, groupId: string): Group {
  const group = factory.groups[groupId];
  if (!group) throw new Error(`Group 不存在：${groupId}`);
  return group;
}

/** Group of the machine that already references this slot, if any. */
function findSlotOwner(factory: Factory, machineId: MachineId, key: string): Group | undefined {
  const machine = factory.machines[machineId];
  if (!machine) return undefined;
  for (const groupId of machine.groups) {
    const group = factory.groups[groupId];
    if (!group) continue;
    if (group.slots.some(slot => slotKey(slot) === key)) return group;
  }
  return undefined;
}

function normalizeSlots(slots: Slot[]): [Slot, ...Slot[]] {
  if (!slots.length) throw new Error("至少需要选择一个槽位。");
  const seen = new Set<string>();
  const normalized: Slot[] = [];
  for (const slot of slots) {
    if (typeof slot.periphId !== "string" || !slot.periphId) throw new Error("槽位缺少有效的 periphId。");
    const slotNumber = slot.slot;
    if (slotNumber === undefined || !Number.isInteger(slotNumber) || slotNumber < 1) {
      throw new Error(`槽位号必须是正整数：${slotKey(slot)}`);
    }
    const key = slotKey(slot);
    // Duplicates are rejected rather than silently collapsed: guessing which
    // entry the user meant would hide a mistake in the persisted slot list.
    if (seen.has(key)) throw new Error(`槽位 ${key} 重复出现；请先修正槽位列表。`);
    seen.add(key);
    normalized.push({ periphId: slot.periphId, slot: slotNumber });
  }
  const sorted = sortSlots(normalized);
  const [first] = sorted;
  if (!first) throw new Error("至少需要选择一个槽位。");
  return [first, ...sorted.slice(1)];
}

