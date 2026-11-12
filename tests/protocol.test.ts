import { describe, expect, it } from "vitest";
import { FACTORY_UPDATE_REQUEST_TYPES, hasRequestId, isFactoryUpdateRequestType, isMessageEnvelope } from "../packages/protocol/src/index";

describe("wire protocol contract", () => {
  it("retains the original factory mutation message names", () => {
    expect(FACTORY_UPDATE_REQUEST_TYPES).toEqual([
      "PipeAdd", "PipeEdit", "PipeDel", "MachineAdd", "MachineEdit", "MachineDel",
      "GroupAdd", "GroupEdit", "GroupDel", "PeriphAdd", "PeriphDel",
    ]);
  });
  it("recognizes message envelopes without accepting malformed values", () => {
    expect(isMessageEnvelope({ type: "FactoryGet" })).toBe(true);
    expect(isMessageEnvelope(null)).toBe(false);
    expect(hasRequestId({ type: "PipeDel", reqId: "abc" })).toBe(true);
    expect(hasRequestId({ type: "PipeDel", reqId: 4 })).toBe(false);
  });
  it("rejects factory-update types the v4.3 controller would silently ignore", () => {
    expect(isFactoryUpdateRequestType("GroupEdit")).toBe(true);
    expect(isFactoryUpdateRequestType("GroupMerge")).toBe(false);
    expect(isFactoryUpdateRequestType("")).toBe(false);
    expect(isFactoryUpdateRequestType(42)).toBe(false);
  });
});
