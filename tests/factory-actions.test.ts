import { describe, expect, it } from "vitest";
import { sampleFactory } from "../apps/web/src/sampleFactory";
import {
  buildGroupDelete,
  buildMachineDelete,
  buildNicknameEdit,
  buildPeripheralAdd,
  buildPeripheralDelete,
  buildPipeDeleteBatch,
  canConnectGroups,
} from "../apps/web/src/factoryActions";

function ids() {
  let n = 0;
  return () => `req-${++n}`;
}

describe("M4 factory action builders", () => {
  it("builds nickname edits without changing IDs", () => {
    expect(buildNicknameEdit(sampleFactory, "machine", "machine:storage", "Depot", ids())).toEqual({
      type: "MachineEdit", reqId: "req-1", machineId: "machine:storage", edits: { nickname: "Depot" },
    });
  });

  it("deletes a group through the game-side GroupDel operation", () => {
    expect(buildGroupDelete("group:main", ids())).toEqual({
      type: "GroupDel", reqId: "req-1", groupId: "group:main",
    });
  });

  it("deletes all groups of a machine in one ordered batch", () => {
    expect(buildMachineDelete(sampleFactory, "machine:storage", ids())).toEqual({
      type: "BatchRequest", reqId: "req-3", requests: [
        { type: "GroupDel", reqId: "req-1", groupId: "group:main" },
        { type: "GroupDel", reqId: "req-2", groupId: "group:overflow" },
      ],
    });
  });

  it("adds and removes peripherals using existing protocol requests", () => {
    expect(buildPeripheralAdd("minecraft:chest_2", { x: 10, y: 20 }, ids())).toEqual({
      type: "PeriphAdd", reqId: "req-1", periphId: "minecraft:chest_2", options: { x: 10, y: 20 },
    });
    expect(buildPeripheralDelete("minecraft:chest_2", ids())).toEqual({
      type: "PeriphDel", reqId: "req-1", periphId: "minecraft:chest_2",
    });
  });

  it("deletes one pipe directly and multiple pipes in one batch", () => {
    expect(buildPipeDeleteBatch(["pipe:1"], ids())).toEqual({
      type: "PipeDel", reqId: "req-1", pipeId: "pipe:1",
    });
    expect(buildPipeDeleteBatch(["pipe:1", "pipe:2"], ids())).toEqual({
      type: "BatchRequest",
      reqId: "req-3",
      requests: [
        { type: "PipeDel", reqId: "req-1", pipeId: "pipe:1" },
        { type: "PipeDel", reqId: "req-2", pipeId: "pipe:2" },
      ],
    });
    expect(() => buildPipeDeleteBatch([], ids())).toThrow(/至少需要选择/);
  });

  it("only connects groups with matching fluid/item types", () => {
    const factory = structuredClone(sampleFactory);
    factory.groups["group:fluid"] = { id: "group:fluid", slots: [], fluid: true };
    factory.machines["machine:fluid"] = { id: "machine:fluid", groups: ["group:fluid"] };
    expect(canConnectGroups(factory, "group:main", "group:input")).toBe(true);
    expect(canConnectGroups(factory, "group:main", "group:fluid")).toBe(false);
    expect(canConnectGroups(factory, "missing", "group:fluid")).toBe(false);
  });
});
