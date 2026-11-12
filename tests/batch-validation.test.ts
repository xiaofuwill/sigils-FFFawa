import { describe, expect, it } from "vitest";
import type { Factory } from "../packages/factory-model/src/index";
import { batchChildError, emptyFactory, FakeCc, type WireMessage } from "./support/fake-cc";

/**
 * Deep BatchRequest field validation, mirroring `sigils/batchValidation.lua`.
 *
 * These tests only prove the TypeScript model matches the Lua contract. They do
 * not stand in for a real CC:Tweaked runtime check.
 */

const chest = (slot: number) => ({ periphId: "minecraft:chest_0", slot });

/** JSON cannot produce these, but the validator must still reject holes. */
function sparseSlots(): Array<{ periphId: string }> {
  const slots: Array<{ periphId: string }> = [{ periphId: "c1" }];
  slots[2] = { periphId: "c2" };
  return slots;
}

function sparseGroups(): string[] {
  const groups: string[] = ["g1"];
  groups[2] = "g3";
  return groups;
}

function fixture(): Factory {
  return {
    machines: {
      "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1"], x: 10, y: 20 },
    },
    groups: {
      "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", nickname: "Inventory", slots: [chest(1), chest(2)] },
    },
    pipes: {
      "pipe:1": { id: "pipe:1", from: "minecraft:chest_0:g1", to: "minecraft:chest_0:g1", filter: "" },
    },
    missing: {},
    available: {},
  };
}

function sendBatch(cc: FakeCc, requests: unknown[]): void {
  cc.receive({ type: "BatchRequest", reqId: "batch-1", requests } as unknown as WireMessage);
}

describe("batchChildError accepts legal mutation shapes", () => {
  const validChildren: Array<[string, unknown]> = [
    ["PipeAdd", { type: "PipeAdd", pipe: { id: "p1", from: "g1", to: "g2", filter: "", mode: "natural" } }],
    ["PipeEdit", { type: "PipeEdit", pipeId: "p1", edits: { nickname: "", filter: "ores", mode: "spread" } }],
    ["PipeDel", { type: "PipeDel", pipeId: "p1" }],
    ["MachineAdd", { type: "MachineAdd", machine: { id: "m1", groups: ["g1"], nickname: "Smelter", x: 0, y: -1.5 } }],
    ["MachineEdit", { type: "MachineEdit", machineId: "m1", edits: { nickname: "Smelter", x: 1, y: 2 } }],
    ["MachineDel", { type: "MachineDel", machineId: "m1" }],
    ["GroupAdd", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }], fluid: false } }],
    ["GroupEdit", { type: "GroupEdit", groupId: "g1", edits: { x: 1, y: 2, fluid: true, slots: [{ periphId: "c1" }] } }],
    ["GroupDel", { type: "GroupDel", groupId: "g1" }],
    ["PeriphAdd", { type: "PeriphAdd", periphId: "c1", options: { nickname: "Storage", x: 1, y: 2 } }],
    ["PeriphDel", { type: "PeriphDel", periphId: "c1" }],
  ];

  for (const [label, child] of validChildren) {
    it(`accepts ${label}`, () => {
      expect(batchChildError(child)).toBeNull();
    });
  }

  it("accepts PeriphAdd without options", () => {
    expect(batchChildError({ type: "PeriphAdd", periphId: "c1" })).toBeNull();
  });
});

describe("batchChildError rejects unknown or misplaced fields", () => {
  const rejected: Array<[string, unknown]> = [
    ["unknown child type", { type: "GroupMerge", groupId: "g1" }],
    ["read in batch", { type: "FactoryGet", reqId: "x" }],
    ["child without type", { pipeId: "p1" }],
    ["non-object child", "nope"],
    ["unknown top-level key", { type: "PipeDel", pipeId: "p1", extra: true }],
    ["empty reqId", { type: "PipeDel", pipeId: "p1", reqId: "" }],
    ["PipeAdd unknown field", { type: "PipeAdd", pipe: { id: "p1", from: "g1", to: "g2", groups: [] } }],
    ["PipeAdd bad mode", { type: "PipeAdd", pipe: { id: "p1", from: "g1", to: "g2", mode: "turbo" } }],
    ["PipeEdit id injection", { type: "PipeEdit", pipeId: "p1", edits: { id: "p2" } }],
    ["PipeEdit from injection", { type: "PipeEdit", pipeId: "p1", edits: { from: "g9" } }],
    ["PipeEdit to injection", { type: "PipeEdit", pipeId: "p1", edits: { to: "g9" } }],
    ["MachineAdd unknown field", { type: "MachineAdd", machine: { id: "m1", groups: [], fluid: true } }],
    ["MachineAdd sparse groups", { type: "MachineAdd", machine: { id: "m1", groups: sparseGroups() } }],
    ["MachineAdd non-string group", { type: "MachineAdd", machine: { id: "m1", groups: ["g1", 5] } }],
    ["MachineEdit id injection", { type: "MachineEdit", machineId: "m1", edits: { id: "m2" } }],
    ["MachineEdit groups injection", { type: "MachineEdit", machineId: "m1", edits: { groups: ["g2"] } }],
    ["MachineEdit NaN x", { type: "MachineEdit", machineId: "m1", edits: { x: Number.NaN } }],
    ["MachineEdit infinite y", { type: "MachineEdit", machineId: "m1", edits: { y: Number.POSITIVE_INFINITY } }],
    ["GroupAdd unknown field", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }], machine: "m1" } }],
    ["GroupAdd empty id", { type: "GroupAdd", machineId: "m1", group: { id: "", slots: [{ periphId: "c1", slot: 1 }] } }],
    ["GroupAdd missing machineId", { type: "GroupAdd", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }] } }],
    ["GroupAdd empty machineId", { type: "GroupAdd", machineId: "", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }] } }],
    ["GroupAdd numeric machineId", { type: "GroupAdd", machineId: 5, group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }] } }],
    ["GroupAdd empty slots", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [] } }],
    ["GroupAdd item slot missing number", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1" }] } }],
    ["GroupAdd duplicate slot", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }, { periphId: "c1", slot: 1 }] } }],
    ["GroupAdd sparse slots", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: sparseSlots() } }],
    ["GroupAdd slot unknown field", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1, id: "x" }] } }],
    ["GroupAdd empty periphId", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "", slot: 1 }] } }],
    ["GroupAdd zero slot", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 0 }] } }],
    ["GroupAdd fractional slot", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1.5 }] } }],
    ["GroupAdd non-boolean fluid", { type: "GroupAdd", machineId: "m1", group: { id: "g1", slots: [{ periphId: "c1", slot: 1 }], fluid: "yes" } }],
    ["GroupEdit id injection", { type: "GroupEdit", groupId: "g1", edits: { id: "g2" } }],
    ["GroupEdit ownership injection", { type: "GroupEdit", groupId: "g1", edits: { machineId: "m1" } }],
    ["GroupEdit empty slots", { type: "GroupEdit", groupId: "g1", edits: { slots: [] } }],
    ["GroupEdit item slot missing number", { type: "GroupEdit", groupId: "g1", edits: { fluid: false, slots: [{ periphId: "c1" }] } }],
    ["GroupEdit duplicate slot", { type: "GroupEdit", groupId: "g1", edits: { slots: [{ periphId: "c1", slot: 1 }, { periphId: "c1", slot: 1 }] } }],
    ["GroupEdit sparse slots", { type: "GroupEdit", groupId: "g1", edits: { slots: sparseSlots() } }],
    ["GroupEdit negative slot", { type: "GroupEdit", groupId: "g1", edits: { slots: [{ periphId: "c1", slot: -1 }] } }],
    ["GroupEdit non-boolean fluid", { type: "GroupEdit", groupId: "g1", edits: { fluid: 1 } }],
    ["GroupEdit NaN x", { type: "GroupEdit", groupId: "g1", edits: { x: Number.NaN } }],
    ["PeriphAdd options non-object", { type: "PeriphAdd", periphId: "c1", options: "x" }],
    ["PeriphAdd id injection", { type: "PeriphAdd", periphId: "c1", options: { id: "m2" } }],
    ["PeriphAdd groups injection", { type: "PeriphAdd", periphId: "c1", options: { groups: ["g1"] } }],
    ["PeriphAdd identity injection", { type: "PeriphAdd", periphId: "c1", options: { periphId: "c2" } }],
    ["PeriphAdd numeric nickname", { type: "PeriphAdd", periphId: "c1", options: { nickname: 5 } }],
    ["PeriphAdd infinite x", { type: "PeriphAdd", periphId: "c1", options: { x: Number.POSITIVE_INFINITY } }],
    ["PipeDel missing id", { type: "PipeDel" }],
    ["MachineDel empty id", { type: "MachineDel", machineId: "" }],
    ["GroupDel numeric id", { type: "GroupDel", groupId: 7 }],
    ["PeriphDel non-string id", { type: "PeriphDel", periphId: {} }],
  ];

  for (const [label, child] of rejected) {
    it(`rejects ${label}`, () => {
      expect(batchChildError(child)).toMatch(/unsupported|required|requires|must|type|array|holes|duplicates/);
    });
  }
});

describe("FakeCc rejects invalid batches before execution", () => {
  it("executes a fully valid batch and saves once", () => {
    const cc = new FakeCc({ factory: fixture() });
    sendBatch(cc, [
      { type: "PipeDel", reqId: "c1", pipeId: "pipe:1" },
      { type: "GroupEdit", reqId: "c2", groupId: "minecraft:chest_0:g1", edits: { nickname: "Main" } },
    ]);

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
    expect(cc.factory.pipes["pipe:1"]).toBeUndefined();
    expect(cc.factory.groups["minecraft:chest_0:g1"].nickname).toBe("Main");
  });

  it("rejects a deep field error before any child runs", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    sendBatch(cc, [
      { type: "PipeDel", reqId: "c1", pipeId: "pipe:1" },
      { type: "PipeEdit", reqId: "c2", pipeId: "pipe:1", edits: { id: "pipe:9" } },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("unsupported field: id");
    expect(cc.saveCount).toBe(0);
    expect(cc.sent.filter(message => message.ok === true)).toHaveLength(0);
    expect(cc.factory).toEqual(before);
  });

  it("rejects relationship-field injection in MachineEdit", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    sendBatch(cc, [
      { type: "MachineEdit", reqId: "c1", machineId: "minecraft:chest_0", edits: { groups: ["g9"] } },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("rejects sparse GroupEdit slots", () => {
    const cc = new FakeCc({ factory: fixture() });
    const sparse = [{ periphId: "minecraft:chest_0", slot: 1 }] as Array<{ periphId: string; slot?: number }>;
    sparse[3] = { periphId: "minecraft:chest_0", slot: 2 };
    const before = structuredClone(cc.factory);

    sendBatch(cc, [
      { type: "GroupEdit", reqId: "c1", groupId: "minecraft:chest_0:g1", edits: { slots: sparse } },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("holes");
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("rejects PeriphAdd options that override identity or groups", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    sendBatch(cc, [
      { type: "PeriphAdd", reqId: "c1", periphId: "c9", options: { id: "m9", groups: ["g9"] } },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("rejects NaN coordinates", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    sendBatch(cc, [
      { type: "MachineEdit", reqId: "c1", machineId: "minecraft:chest_0", edits: { x: Number.NaN } },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("rejects empty and non-array request lists", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    sendBatch(cc, []);
    expect(cc.lastSent?.ok).toBe(false);
    sendBatch(cc, "nope" as unknown as unknown[]);
    expect(cc.lastSent?.ok).toBe(false);

    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("accepts PeriphAdd placement options", () => {
    const cc = new FakeCc({ factory: emptyFactory(), inventories: { c1: 1 } });
    sendBatch(cc, [
      { type: "PeriphAdd", reqId: "c1", periphId: "c1", options: { nickname: "Storage", x: 4, y: 8 } },
    ]);

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
    expect(cc.factory.machines.c1).toMatchObject({ id: "c1", nickname: "Storage", x: 4, y: 8 });
  });
});

describe("Group integrity matrix", () => {
  const send = (cc: FakeCc, request: object): void => {
    cc.receive(request as unknown as WireMessage);
  };

  it("G-05: GroupAdd to an existing Machine links both sides", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, {
      type: "GroupAdd", reqId: "g-5", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [chest(3)] },
    });

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
    expect(cc.factory.groups["minecraft:chest_0:g2"]).toBeDefined();
    expect(cc.factory.machines["minecraft:chest_0"].groups).toEqual([
      "minecraft:chest_0:g1", "minecraft:chest_0:g2",
    ]);
  });

  it("G-04: GroupAdd to an unknown Machine is rejected before mutation", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);
    send(cc, {
      type: "GroupAdd", reqId: "g-4", machineId: "missing",
      group: { id: "missing:g2", slots: [chest(1)] },
    });

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("machine not found");
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("G-07/G-08: empty slots are rejected for GroupAdd and GroupEdit", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    send(cc, { type: "GroupAdd", reqId: "g-7", machineId: "minecraft:chest_0", group: { id: "g2", slots: [] } });
    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("must not be empty");

    send(cc, { type: "GroupEdit", reqId: "g-8", groupId: "minecraft:chest_0:g1", edits: { slots: [] } });
    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("must not be empty");

    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("G-09: a slot already owned by another group is rejected", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);
    send(cc, {
      type: "GroupAdd", reqId: "g-9", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [chest(1)] },
    });

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("referenced by both");
    expect(cc.saveCount).toBe(0);
    expect(cc.factory).toEqual(before);
  });

  it("G-10/G-11: same peripheral with another slot and another peripheral with the same number are accepted", () => {
    const cc = new FakeCc({ factory: fixture() });
    sendBatch(cc, [
      {
        type: "GroupAdd", reqId: "g-10", machineId: "minecraft:chest_0",
        group: { id: "minecraft:chest_0:g2", slots: [chest(3), { periphId: "minecraft:chest_1", slot: 1 }] },
      },
    ]);

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
  });

  it("G-12: a fluid group without slot numbers is accepted", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, {
      type: "GroupAdd", reqId: "g-12", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:fluids", fluid: true, slots: [{ periphId: "minecraft:tank_0" }] },
    });

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
  });

  it("G-13: an item group slot without a number is rejected", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, {
      type: "GroupAdd", reqId: "g-13", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [{ periphId: "minecraft:chest_0" }] },
    });

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("slot is required for item groups");
    expect(cc.saveCount).toBe(0);
  });

  it("G-14/G-15/G-16/G-17: an invalid later child rejects the whole batch", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);
    sendBatch(cc, [
      { type: "GroupEdit", reqId: "c1", groupId: "minecraft:chest_0:g1", edits: { nickname: "Renamed" } },
      {
        type: "GroupAdd", reqId: "c2", machineId: "minecraft:chest_0",
        group: { id: "minecraft:chest_0:g2", slots: [chest(1)] },
      },
    ]);

    expect(cc.lastSent?.ok).toBe(false);
    expect(String(cc.lastSent?.message)).toContain("referenced by both");
    expect(cc.saveCount).toBe(0);
    expect(cc.sent.filter(message => message.ok === true)).toHaveLength(0);
    expect(cc.factory).toEqual(before);
  });

  it("split-like batch allows temporary overlap when the final state is clean", () => {
    const cc = new FakeCc({ factory: fixture() });
    sendBatch(cc, [
      {
        type: "GroupAdd", reqId: "c1", machineId: "minecraft:chest_0",
        group: { id: "minecraft:chest_0:g2", slots: [chest(2)] },
      },
      {
        type: "GroupEdit", reqId: "c2", groupId: "minecraft:chest_0:g1",
        edits: { slots: [chest(1)] },
      },
    ]);

    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
    expect(cc.factory.groups["minecraft:chest_0:g1"].slots).toEqual([chest(1)]);
    expect(cc.factory.groups["minecraft:chest_0:g2"].slots).toEqual([chest(2)]);
  });

  it("G-18/G-19: single and batch entry report the same Group error", () => {
    const malformedAdd = {
      type: "GroupAdd", reqId: "g-18", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [] },
    };
    const malformedEdit = {
      type: "GroupEdit", reqId: "g-19", groupId: "minecraft:chest_0:g1", edits: { slots: [] },
    };

    for (const malformed of [malformedAdd, malformedEdit]) {
      const single = new FakeCc({ factory: fixture() });
      send(single, malformed);
      const batch = new FakeCc({ factory: fixture() });
      sendBatch(batch, [malformed]);

      expect(single.lastSent?.ok).toBe(false);
      expect(batch.lastSent?.ok).toBe(false);
      expect(batch.lastSent?.message).toBe(single.lastSent?.message);
      expect(single.saveCount).toBe(0);
      expect(batch.saveCount).toBe(0);
    }
  });

  it("a valid request after a rejected one still works", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, {
      type: "GroupAdd", reqId: "bad", machineId: "missing",
      group: { id: "missing:g", slots: [chest(1)] },
    });
    expect(cc.lastSent?.ok).toBe(false);

    send(cc, {
      type: "GroupAdd", reqId: "good", machineId: "minecraft:chest_0",
      group: { id: "minecraft:chest_0:g2", slots: [chest(3)] },
    });
    expect(cc.lastSent?.ok).toBe(true);
    expect(cc.saveCount).toBe(1);
  });
});
