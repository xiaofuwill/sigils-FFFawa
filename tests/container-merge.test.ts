import { describe, expect, it } from "vitest";
import type { Factory, Slot } from "../packages/factory-model/src/index";
import {
  buildGroupMerge,
  buildGroupSplit,
  canMergeGroups,
  findReleasedPeriphs,
  getFactoryPeriphIds,
} from "../apps/web/src/groupActions";

function ids() {
  let n = 0;
  return () => `req-${++n}`;
}

function chest(slot: number): Slot {
  return { periphId: "minecraft:chest_0", slot };
}

/** Two item containers and one fluid container on chest_0, plus a second machine. */
const factory: Factory = {
  machines: {
    "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1", "minecraft:chest_0:g2"] },
    "minecraft:chest_1": { id: "minecraft:chest_1", groups: ["minecraft:chest_1:g1"] },
    "minecraft:tank_0": { id: "minecraft:tank_0", groups: ["minecraft:tank_0:fluids"] },
  },
  groups: {
    "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", nickname: "Main", slots: [chest(1), chest(2), chest(3)] },
    "minecraft:chest_0:g2": { id: "minecraft:chest_0:g2", nickname: "Overflow", slots: [chest(4), chest(5)] },
    "minecraft:chest_1:g1": { id: "minecraft:chest_1:g1", slots: [{ periphId: "minecraft:chest_1", slot: 1 }] },
    "minecraft:tank_0:fluids": { id: "minecraft:tank_0:fluids", fluid: true, slots: [{ periphId: "minecraft:tank_0" }] },
  },
  pipes: {},
  missing: {},
  available: {},
};

describe("container merge rules (upstream combineGroups)", () => {
  it("allows merging two item containers of the same machine", () => {
    expect(canMergeGroups(factory, "minecraft:chest_0:g1", "minecraft:chest_0:g2")).toEqual({ ok: true });
  });

  it("rejects self-merge, cross-machine merge, fluid/item mixing and unknown containers", () => {
    expect(canMergeGroups(factory, "minecraft:chest_0:g1", "minecraft:chest_0:g1")).toEqual({
      ok: false, reason: "不能把容器合并到自身。",
    });
    expect(canMergeGroups(factory, "minecraft:chest_0:g1", "minecraft:chest_1:g1")).toEqual({
      ok: false, reason: "只能在同一个机器框内合并容器。",
    });
    expect(canMergeGroups(factory, "minecraft:chest_0:g1", "minecraft:tank_0:fluids")).toEqual({
      ok: false, reason: "只能在同一个机器框内合并容器。",
    });
    expect(canMergeGroups(factory, "unknown", "minecraft:chest_0:g2")).toEqual({
      ok: false, reason: "容器不存在：unknown",
    });
  });

  it("rejects mixing item and fluid containers inside one machine", () => {
    const mixed: Factory = {
      ...factory,
      machines: {
        ...factory.machines,
        "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1", "minecraft:chest_0:fluid"] },
      },
      groups: {
        ...factory.groups,
        "minecraft:chest_0:fluid": { id: "minecraft:chest_0:fluid", fluid: true, slots: [{ periphId: "minecraft:chest_0" }] },
      },
    };
    expect(canMergeGroups(mixed, "minecraft:chest_0:g1", "minecraft:chest_0:fluid")).toEqual({
      ok: false, reason: "物品容器与液体容器不能合并。",
    });
  });

  it("rejects inconsistent data where a slot appears in both containers", () => {
    const duplicated: Factory = {
      ...factory,
      groups: {
        ...factory.groups,
        "minecraft:chest_0:g2": { id: "minecraft:chest_0:g2", slots: [chest(3), chest(5)] },
      },
    };
    expect(canMergeGroups(duplicated, "minecraft:chest_0:g1", "minecraft:chest_0:g2")).toEqual({
      ok: false, reason: "槽位 minecraft:chest_0#3 同时存在于两个容器中，数据不一致。",
    });
  });

  it("merges into the target and deletes the source in one batch", () => {
    expect(buildGroupMerge(factory, "minecraft:chest_0:g1", "minecraft:chest_0:g2", ids())).toEqual({
      type: "BatchRequest",
      reqId: "req-1",
      requests: [
        {
          type: "GroupEdit",
          reqId: "req-2",
          groupId: "minecraft:chest_0:g2",
          edits: { slots: [chest(1), chest(2), chest(3), chest(4), chest(5)] },
        },
        { type: "GroupDel", reqId: "req-3", groupId: "minecraft:chest_0:g1" },
      ],
    });
  });

  it("refuses to build a merge that breaks the rules", () => {
    expect(() => buildGroupMerge(factory, "minecraft:chest_0:g1", "minecraft:chest_1:g1", ids())).toThrow(/同一个机器框/);
    expect(() => buildGroupMerge(factory, "minecraft:chest_0:g2", "minecraft:chest_0:g2", ids())).toThrow(/自身/);
    expect(() => buildGroupMerge(factory, "minecraft:chest_0:g1", "minecraft:tank_0:fluids", ids())).toThrow(/同一个机器框/);
    expect(() => buildGroupMerge(factory, "missing", "minecraft:chest_0:g2", ids())).toThrow(/容器不存在/);
  });
});

describe("slot drag split", () => {
  it("keeps the source nickname and stores the drop position relative to the machine", () => {
    expect(buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(2)], "Main", ids(), { x: 48, y: 96 })).toEqual({
      type: "BatchRequest",
      reqId: "req-1",
      requests: [
        {
          type: "GroupAdd",
          reqId: "req-2",
          machineId: "minecraft:chest_0",
          group: {
            id: "minecraft:chest_0:g3",
            slots: [chest(2)],
            nickname: "Main",
            x: 48,
            y: 96,
          },
        },
        {
          type: "GroupEdit",
          reqId: "req-3",
          groupId: "minecraft:chest_0:g1",
          edits: { slots: [chest(1), chest(3)] },
        },
      ],
    });
  });

  it("omits x/y when no drop position is supplied", () => {
    const request = buildGroupSplit(factory, "minecraft:chest_0:g1", [chest(2)], undefined, ids());
    const add = request.requests[0];
    expect(add.type).toBe("GroupAdd");
    if (add.type !== "GroupAdd") throw new Error("expected GroupAdd");
    expect(add.group).not.toHaveProperty("x");
    expect(add.group).not.toHaveProperty("y");
  });

  it("rejects dragging the only slot out of a container", () => {
    expect(() => buildGroupSplit(factory, "minecraft:chest_1:g1", [{ periphId: "minecraft:chest_1", slot: 1 }], undefined, ids()))
      .toThrow(/全部槽位/);
  });

  it("rejects slot drags for fluid containers", () => {
    expect(() => buildGroupSplit(factory, "minecraft:tank_0:fluids", [{ periphId: "minecraft:tank_0" }], undefined, ids()))
      .toThrow(/流体/);
  });
});

describe("released peripherals after deleting a container", () => {
  it("reports a peripheral whose container was deleted and is not missing", () => {
    const previous = getFactoryPeriphIds(factory);
    const after: Factory = {
      ...factory,
      machines: {
        ...factory.machines,
        "minecraft:chest_1": { id: "minecraft:chest_1", groups: [] },
      },
      groups: {
        "minecraft:chest_0:g1": factory.groups["minecraft:chest_0:g1"],
        "minecraft:chest_0:g2": factory.groups["minecraft:chest_0:g2"],
      },
    };
    // tank_0 and chest_1 containers were deleted; both peripherals are offered.
    expect(findReleasedPeriphs(previous, after).sort()).toEqual(["minecraft:chest_1", "minecraft:tank_0"]);
  });

  it("does not release missing, available or still-referenced peripherals", () => {
    const previous = getFactoryPeriphIds(factory);
    const after: Factory = {
      ...factory,
      groups: {
        "minecraft:chest_0:g1": factory.groups["minecraft:chest_0:g1"],
        "minecraft:tank_0:fluids": factory.groups["minecraft:tank_0:fluids"],
        "minecraft:chest_1:g1": factory.groups["minecraft:chest_1:g1"],
      },
      missing: { "minecraft:chest_1": true },
      available: { "minecraft:tank_0": true },
    };
    expect(findReleasedPeriphs(previous, after)).toEqual([]);
  });
});
