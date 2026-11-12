import type { Factory } from "../../../packages/factory-model/src/index";

/** Offline fixture only; live sessions load their Factory via FactoryGet. */
export const sampleFactory: Factory = {
  machines: {
    "machine:storage": { id: "machine:storage", nickname: "Storage", groups: ["group:main", "group:overflow"], x: 80, y: 100 },
    "machine:processing": { id: "machine:processing", nickname: "Processing", groups: ["group:input", "group:output"], x: 520, y: 220 },
  },
  groups: {
    "group:main": { id: "group:main", nickname: "Main Inventory", slots: [{ periphId: "minecraft:chest_0", slot: 1 }, { periphId: "minecraft:chest_0", slot: 2 }, { periphId: "minecraft:chest_0", slot: 3 }, { periphId: "minecraft:chest_0", slot: 4 }], x: 24, y: 76 },
    "group:overflow": { id: "group:overflow", nickname: "Overflow", slots: [{ periphId: "minecraft:chest_1", slot: 1 }], x: 24, y: 170 },
    "group:input": { id: "group:input", nickname: "Input", slots: [{ periphId: "create:packager_0", slot: 1 }], x: 24, y: 76 },
    "group:output": { id: "group:output", nickname: "Output", slots: [{ periphId: "create:packager_1", slot: 1 }], x: 24, y: 170 },
  },
  pipes: {
    "pipe:main-input": { id: "pipe:main-input", from: "group:main", to: "group:input", mode: "natural", filter: "#warehouse" },
    "pipe:output-overflow": { id: "pipe:output-overflow", from: "group:output", to: "group:overflow", mode: "spread" },
  },
  missing: {},
  available: {},
};
