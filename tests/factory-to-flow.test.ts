import { describe, expect, it } from "vitest";
import type { Factory } from "../packages/factory-model/src/index";
import { factoryToFlow, groupDisplayName, groupNodeSize, periphColor, slotChipLabel } from "../apps/web/src/factoryToFlow";

function factoryWithMissing(): Factory {
  return {
    machines: {
      "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1"] },
      "minecraft:chest_9": { id: "minecraft:chest_9", groups: ["minecraft:chest_9:g1"] },
    },
    groups: {
      "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", slots: [{ periphId: "minecraft:chest_0", slot: 1 }] },
      "minecraft:chest_9:g1": { id: "minecraft:chest_9:g1", slots: [{ periphId: "minecraft:chest_9", slot: 1 }] },
    },
    pipes: {},
    missing: { "minecraft:chest_9": true },
    available: {},
  };
}

describe("factoryToFlow node rendering data", () => {
  it("flags nodes whose peripherals are missing", () => {
    const { nodes } = factoryToFlow(factoryWithMissing());
    const byId = new Map(nodes.map(node => [node.id, node]));

    expect(byId.get("minecraft:chest_9:g1")?.data.missing).toBe(true);
    expect(byId.get("minecraft:chest_9")?.data.missing).toBe(true);
    expect(byId.get("minecraft:chest_0:g1")?.data.missing).toBe(false);
    expect(byId.get("minecraft:chest_0")?.data.missing).toBe(false);
  });

  it("exposes slots and a collapse state on group nodes", () => {
    const expanded = factoryToFlow(factoryWithMissing());
    const collapsed = factoryToFlow(factoryWithMissing(), { collapsedGroups: new Set(["minecraft:chest_0:g1"]) });

    const expandedGroup = expanded.nodes.find(node => node.id === "minecraft:chest_0:g1");
    const collapsedGroup = collapsed.nodes.find(node => node.id === "minecraft:chest_0:g1");
    expect(expandedGroup?.data.slots).toHaveLength(1);
    expect(expandedGroup?.data.collapsed).toBe(false);
    expect(collapsedGroup?.data.collapsed).toBe(true);
  });

  it("keeps collapsed groups shorter than expanded ones", () => {
    const expanded = groupNodeSize(9, false);
    const collapsed = groupNodeSize(9, true);
    expect(collapsed.height).toBeLessThan(expanded.height);
    expect(expanded.width).toBe(9 * 26 + 8 * 2 + 16);
  });

  it("gives each peripheral a stable colour", () => {
    expect(periphColor("minecraft:chest_0")).toBe(periphColor("minecraft:chest_0"));
    expect(periphColor("minecraft:chest_0")).toMatch(/^hsl\(\d+, 60%, 38%\)$/);
    expect(periphColor("minecraft:chest_0")).not.toBe(periphColor("minecraft:chest_1"));
  });

  it("translates the default CC container names without rewriting them", () => {
    const inventory = groupDisplayName({ id: "minecraft:chest_0:g1", slots: [], nickname: "Inventory" });
    const fluid = groupDisplayName({ id: "minecraft:tank_0:fluids", slots: [], nickname: "Fluid tank", fluid: true });
    const custom = groupDisplayName({ id: "custom", slots: [], nickname: "Main" });

    expect(inventory).toBe("物品槽");
    expect(fluid).toBe("液体槽");
    expect(custom).toBe("Main");
  });

  it("numbers fluid slots the same way as item slots", () => {
    expect(slotChipLabel({ slot: 7 }, 0)).toBe("7");
    expect(slotChipLabel({}, 0)).toBe("1");
    expect(slotChipLabel({}, 4)).toBe("5");
  });

  it("sizes a machine to fit its group grid", () => {
    const { nodes } = factoryToFlow(factoryWithMissing());
    const machine = nodes.find(node => node.id === "minecraft:chest_0");
    expect(machine?.style?.width).toBeGreaterThanOrEqual(240);
    expect(machine?.style?.height).toBeGreaterThanOrEqual(150);
  });

  it("titles machines with the raw peripheral id and keeps the nickname separate", () => {
    const withNickname: Factory = {
      ...factoryWithMissing(),
      machines: {
        ...factoryWithMissing().machines,
        "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1"], nickname: "Storage" },
      },
    };
    const machine = factoryToFlow(withNickname).nodes.find(node => node.id === "minecraft:chest_0");
    expect(machine?.data.label).toBe("minecraft:chest_0");
    expect(machine?.data.nickname).toBe("Storage");
  });

  it("labels pipes with nickname, filter or mode", () => {
    const base = factoryWithMissing();
    const factory: Factory = {
      ...base,
      pipes: {
        titled: { id: "titled", from: "minecraft:chest_0:g1", to: "minecraft:chest_9:g1", nickname: "Main feed", filter: "#ore" },
        filtered: { id: "filtered", from: "minecraft:chest_0:g1", to: "minecraft:chest_9:g1", filter: "#ore" },
        moded: { id: "moded", from: "minecraft:chest_0:g1", to: "minecraft:chest_9:g1", mode: "spread" },
      },
    };
    const edges = factoryToFlow(factory).edges;
    const labelOf = (id: string) => edges.find(edge => edge.id === id)?.label;
    expect(labelOf("titled")).toBe("Main feed (#ore)");
    expect(labelOf("filtered")).toBe("#ore");
    expect(labelOf("moded")).toBe("spread");
  });

  it("exposes the owning machine and drop-target state for container interactions", () => {
    const multiSlot: Factory = {
      ...factoryWithMissing(),
      groups: {
        ...factoryWithMissing().groups,
        "minecraft:chest_0:g1": {
          id: "minecraft:chest_0:g1",
          slots: [{ periphId: "minecraft:chest_0", slot: 1 }, { periphId: "minecraft:chest_0", slot: 2 }],
        },
      },
    };

    const readOnly = factoryToFlow(multiSlot);
    const writable = factoryToFlow(multiSlot, { canWrite: true, dropTargetId: "minecraft:chest_0:g1" });
    const readOnlyGroup = readOnly.nodes.find(node => node.id === "minecraft:chest_0:g1");
    const writableGroup = writable.nodes.find(node => node.id === "minecraft:chest_0:g1");

    expect(readOnlyGroup?.data.machineId).toBe("minecraft:chest_0");
    expect(readOnlyGroup?.data.canDragSlots).toBe(false);
    expect(writableGroup?.data.canDragSlots).toBe(true);
    expect(writableGroup?.data.dropTarget).toBe(true);
  });

  it("does not offer slot drags for single-slot or fluid containers", () => {
    const single = factoryToFlow(factoryWithMissing(), { canWrite: true });
    const singleGroup = single.nodes.find(node => node.id === "minecraft:chest_0:g1");
    expect(singleGroup?.data.canDragSlots).toBe(false);

    const fluid: Factory = {
      ...factoryWithMissing(),
      groups: {
        ...factoryWithMissing().groups,
        "minecraft:chest_0:g1": {
          id: "minecraft:chest_0:g1",
          fluid: true,
          slots: [{ periphId: "minecraft:chest_0" }, { periphId: "minecraft:chest_0" }],
        },
      },
    };
    const fluidGroup = factoryToFlow(fluid, { canWrite: true }).nodes.find(node => node.id === "minecraft:chest_0:g1");
    expect(fluidGroup?.data.canDragSlots).toBe(false);
  });
});
