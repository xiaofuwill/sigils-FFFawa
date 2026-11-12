import { describe, expect, it } from "vitest";
import { EMPTY_FACTORY, validateFactoryReferences, validateFactoryShape, type Factory } from "../packages/factory-model/src/index";

const validFactory: Factory = {
  ...EMPTY_FACTORY,
  machines: { m1: { id: "m1", groups: ["g1"] } },
  groups: { g1: { id: "g1", slots: [{ periphId: "minecraft:chest_0", slot: 1 }] } },
  pipes: { p1: { id: "p1", from: "g1", to: "g1", filter: "#warehouse" } },
};

describe("Factory contract", () => {
  it("accepts the v4.3 five-map root shape", () => expect(validateFactoryShape(validFactory)).toEqual([]));
  it("rejects absent maps", () => expect(validateFactoryShape({ pipes: {} })).toContainEqual(expect.objectContaining({ path: "machines" })));
  it("checks group and pipe references", () => {
    // m1 references a group that does not exist, and the pipe targets it too.
    const broken: Factory = {
      ...validFactory,
      machines: { m1: { id: "m1", groups: ["g1", "missing"] } },
      pipes: { p1: { id: "p1", from: "g1", to: "missing" } },
    };
    expect(validateFactoryReferences(broken)).toHaveLength(2);
  });
});
