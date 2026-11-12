import { describe, expect, it } from "vitest";
import {
  EMPTY_FACTORY,
  validateFactoryReferences,
  validateFactoryShape,
  type Factory,
} from "../packages/factory-model/src/index";

/**
 * `machine.lua#addFluidTank` stores `slots = {{periphId = <id>, slot = nil}}`.
 * `slot` therefore disappears from factory.json; the editor must accept it.
 */
const fluidTankFactory: Factory = {
  machines: { "minecraft:fluid_tank_0": { id: "minecraft:fluid_tank_0", groups: ["minecraft:fluid_tank_0:fluids"] } },
  groups: {
    "minecraft:fluid_tank_0:fluids": {
      id: "minecraft:fluid_tank_0:fluids",
      nickname: "Fluid tank",
      fluid: true,
      slots: [{ periphId: "minecraft:fluid_tank_0" }],
    },
  },
  pipes: {},
  missing: {},
  available: {},
};

describe("v4.3 fluid tank groups", () => {
  it("accepts the slot shape emitted by addFluidTank", () => {
    expect(validateFactoryShape(fluidTankFactory)).toEqual([]);
    expect(validateFactoryReferences(fluidTankFactory)).toEqual([]);
  });

  it("still requires a slot number on item groups", () => {
    const factory: Factory = {
      ...EMPTY_FACTORY,
      machines: { m: { id: "m", groups: ["g"] } },
      groups: { g: { id: "g", slots: [{ periphId: "minecraft:chest_0" }] } },
    };
    expect(validateFactoryShape(factory)).toContainEqual(expect.objectContaining({ path: "groups.g.slots[0]" }));
  });

  it("rejects non-integer slot numbers", () => {
    const factory: Factory = {
      ...EMPTY_FACTORY,
      machines: { m: { id: "m", groups: ["g"] } },
      groups: { g: { id: "g", slots: [{ periphId: "minecraft:chest_0", slot: 1.5 }] } },
    };
    expect(validateFactoryShape(factory)).toContainEqual(expect.objectContaining({ path: "groups.g.slots[0]" }));
  });
});
