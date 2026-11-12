import { describe, expect, it } from "vitest";
import type { Factory, Slot } from "../packages/factory-model/src/index";
import {
  buildGroupCreate,
  buildGroupSplit,
  buildSlotTransfer,
  buildSlotUpdate,
  findGroupOwner,
  getMachineSlots,
  getOrphanedSlots,
  slotKey,
  suggestGroupId,
} from "../apps/web/src/groupActions";

function ids() {
  let n = 0;
  return () => `req-${++n}`;
}

function chest(slot: number): Slot {
  return { periphId: "minecraft:chest_0", slot };
}

const factory: Factory = {
  machines: {
    "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1"] },
    "minecraft:tank_0": { id: "minecraft:tank_0", groups: ["minecraft:tank_0:fluids"] },
  },
  groups: {
    "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", nickname: "Inventory", slots: [chest(1), chest(2), chest(3)] },
    "minecraft:tank_0:fluids": { id: "minecraft:tank_0:fluids", fluid: true, slots: [{ periphId: "minecraft:tank_0" }] },
  },
  pipes: {},
  missing: {},
  available: {},
};

describe("v4.3 group / slot helpers", () => {
  it("suggests the next free upstream-style group id", () => {
    expect(suggestGroupId(factory, "minecraft:chest_0")).toBe("minecraft:chest_0:g2");
  });

  it("lists machine slots once and resolves the owning machine", () => {
    expect(getMachineSlots(factory, "minecraft:chest_0").map(slot => slot.slot)).toEqual([1, 2, 3]);
    expect(findGroupOwner(factory, "minecraft:chest_0:g1")).toBe("minecraft:chest_0");
    expect(findGroupOwner(factory, "unknown")).toBeUndefined();
  });

  it("creates a group only from slots that no group owns yet", () => {
    expect(() => buildGroupCreate(factory, "minecraft:chest_0", [chest(1)], "Taken", ids())).toThrow(/已属于/);

    const request = buildGroupCreate(factory, "minecraft:chest_0", [chest(4)], undefined, ids());
    expect(request).toEqual({
      type: "GroupAdd",
      reqId: "req-1",
      machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [chest(4)], nickname: "Slot 2" },
    });
  });

  it("rejects group creation for a peripheral outside the machine", () => {
    expect(() => buildGroupCreate(factory, "minecraft:chest_0", [{ periphId: "minecraft:barrel_9", slot: 1 }], undefined, ids())).toThrow(/不属于该 Machine/);
    expect(() => buildGroupCreate(factory, "minecraft:chest_0", [], undefined, ids())).toThrow(/至少需要选择/);
    expect(() => buildGroupCreate(factory, "missing", [chest(1)], undefined, ids())).toThrow(/Machine 不存在/);
  });

  it("splits slots into a new group in one ordered batch", () => {
    expect(buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(2), chest(3)], "Out", ids())).toEqual({
      type: "BatchRequest",
      reqId: "req-1",
      requests: [
        { type: "GroupAdd", reqId: "req-2", machineId: "minecraft:chest_0", group: { id: "minecraft:chest_0:g2", slots: [chest(2), chest(3)], nickname: "Out" } },
        { type: "GroupEdit", reqId: "req-3", groupId: "minecraft:chest_0:g1", edits: { slots: [chest(1)] } },
      ],
    });
  });

  it("refuses destructive or invalid splits", () => {
    expect(() => buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(1), chest(2), chest(3)], undefined, ids())).toThrow(/全部槽位/);
    expect(() => buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(9)], undefined, ids())).toThrow(/不在 Group/);
    expect(() => buildGroupSplit(factory, "minecraft:tank_0:fluids", [{ periphId: "minecraft:tank_0" }], undefined, ids())).toThrow(/流体/);
  });

  it("updates a group slot list without stealing slots from siblings", () => {
    const updated = buildSlotUpdate(factory, "minecraft:chest_0:g1", [chest(1), chest(4)], ids());
    expect(updated).toEqual({
      type: "GroupEdit",
      reqId: "req-1",
      groupId: "minecraft:chest_0:g1",
      edits: { slots: [chest(1), chest(4)] },
    });
  });

  it("rejects slot updates that empty a group or cross machines", () => {
    expect(() => buildSlotUpdate(factory, "minecraft:chest_0:g1", [], ids())).toThrow(/至少需要选择/);
    expect(() => buildSlotUpdate(factory, "minecraft:tank_0:fluids", [{ periphId: "minecraft:tank_0" }], ids())).toThrow(/流体/);
    expect(() => buildSlotUpdate(factory, "minecraft:chest_0:g1", [{ periphId: "minecraft:barrel_9", slot: 1 }], ids())).toThrow(/不属于该 Machine/);
  });

  it("moves slots between groups of the same machine in one batch", () => {
    const split: Factory = structuredClone(factory);
    split.groups["minecraft:chest_0:g1"]!.slots = [chest(1), chest(2)];
    split.groups["minecraft:chest_0:g2"] = { id: "minecraft:chest_0:g2", slots: [chest(3)] };
    split.machines["minecraft:chest_0"]!.groups.push("minecraft:chest_0:g2");

    expect(buildSlotTransfer(split, "minecraft:chest_0:g1", "minecraft:chest_0:g2", [chest(2)], ids())).toEqual({
      type: "BatchRequest",
      reqId: "req-1",
      requests: [
        { type: "GroupEdit", reqId: "req-2", groupId: "minecraft:chest_0:g1", edits: { slots: [chest(1)] } },
        { type: "GroupEdit", reqId: "req-3", groupId: "minecraft:chest_0:g2", edits: { slots: [chest(2), chest(3)] } },
      ],
    });
  });

  it("refuses cross-machine or group-emptying transfers", () => {
    expect(() => buildSlotTransfer(factory, "minecraft:chest_0:g1", "minecraft:tank_0:fluids", [chest(1)], ids())).toThrow(/流体/);
    expect(() => buildSlotTransfer(factory, "minecraft:chest_0:g1", "minecraft:chest_0:g1", [chest(1), chest(2), chest(3)], ids())).toThrow(/全部槽位/);
    expect(() => buildSlotTransfer(factory, "minecraft:chest_0:g1", "unknown", [chest(1)], ids())).toThrow(/Group 不存在/);
  });

  it("rejects duplicate slots instead of silently collapsing them", () => {
    expect(() => buildSlotUpdate(factory, "minecraft:chest_0:g1", [chest(1), chest(1)], ids())).toThrow(/重复/);
    expect(() => buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(2), chest(2)], undefined, ids())).toThrow(/重复/);
    expect(() => buildGroupCreate(factory, "minecraft:chest_0", [chest(4), chest(4)], undefined, ids())).toThrow(/重复/);

    const withSibling: Factory = structuredClone(factory);
    withSibling.groups["minecraft:chest_0:g2"] = { id: "minecraft:chest_0:g2", slots: [chest(4)] };
    withSibling.machines["minecraft:chest_0"]!.groups.push("minecraft:chest_0:g2");
    expect(() => buildSlotTransfer(withSibling, "minecraft:chest_0:g1", "minecraft:chest_0:g2", [chest(2), chest(2)], ids())).toThrow(/重复/);
  });

  it("names the owning group when a slot is already claimed", () => {
    const split: Factory = structuredClone(factory);
    split.groups["minecraft:chest_0:g1"]!.slots = [chest(1)];
    split.groups["minecraft:chest_0:g2"] = { id: "minecraft:chest_0:g2", slots: [chest(2)] };
    split.machines["minecraft:chest_0"]!.groups.push("minecraft:chest_0:g2");

    expect(() => buildSlotUpdate(split, "minecraft:chest_0:g1", [chest(2)], ids())).toThrow(/minecraft:chest_0:g2/);
  });

  it("keeps fluid slots distinguishable from numbered item slots", () => {
    expect(slotKey({ periphId: "minecraft:tank_0" })).toBe("minecraft:tank_0#fluid");
    expect(slotKey({ periphId: "minecraft:tank_0", slot: undefined })).toBe("minecraft:tank_0#fluid");
    expect(slotKey(chest(1))).toBe("minecraft:chest_0#1");
  });

  it("returns no slots for a machine that has no groups yet", () => {
    const empty: Factory = {
      machines: { "minecraft:barrel_0": { id: "minecraft:barrel_0", groups: [] } },
      groups: {},
      pipes: {},
      missing: {},
      available: {},
    };
    expect(getMachineSlots(empty, "minecraft:barrel_0")).toEqual([]);
    expect(() => buildGroupSplit(empty, "minecraft:barrel_0:g1", [chest(1)], undefined, ids())).toThrow(/Group 不存在/);
  });

  it("reports the slots that only the deleted groups reference", () => {
    const shared: Factory = {
      machines: { m: { id: "m", groups: ["g1", "g2"] } },
      groups: {
        g1: { id: "g1", slots: [chest(1), chest(2)] },
        g2: { id: "g2", slots: [chest(2), chest(3)] },
      },
      pipes: {},
      missing: {},
      available: {},
    };

    expect(getOrphanedSlots(shared, ["g1"]).map(slotKey)).toEqual(["minecraft:chest_0#1"]);
    expect(getOrphanedSlots(shared, ["g1", "g2"]).map(slotKey)).toEqual(["minecraft:chest_0#1", "minecraft:chest_0#2", "minecraft:chest_0#3"]);
    expect(getOrphanedSlots(shared, ["unknown"])).toEqual([]);
  });

  it("keeps fluid slots recoverable without inventing a slot number", () => {
    const fluid: Factory = {
      machines: { t: { id: "t", groups: ["t:fluids"] } },
      groups: { "t:fluids": { id: "t:fluids", fluid: true, slots: [{ periphId: "minecraft:tank_0" }] } },
      pipes: {},
      missing: {},
      available: {},
    };
    const orphaned = getOrphanedSlots(fluid, ["t:fluids"]);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.slot).toBeUndefined();
    expect(slotKey(orphaned[0]!)).toBe("minecraft:tank_0#fluid");
  });
});
