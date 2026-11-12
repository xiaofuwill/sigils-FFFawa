import { afterEach, describe, expect, it, vi } from "vitest";
import { patch, type Delta } from "jsondiffpatch";
import type { WebSocket } from "ws";
import type { Factory } from "../packages/factory-model/src/index";
import { SessionManager } from "../apps/server/src/session-manager.js";
import {
  buildMachineDelete,
  buildNicknameEdit,
  buildPeripheralAdd,
  buildPeripheralDelete,
  buildPipeDeleteBatch,
} from "../apps/web/src/factoryActions";
import { buildGroupMerge, buildGroupSplit, buildSlotUpdate } from "../apps/web/src/groupActions";
import { FakeCc, emptyFactory, type WireMessage } from "./support/fake-cc";

/**
 * Protocol simulation against a model of SIGILS v4.3 `controller.lua`.
 *
 * This exercises message semantics only. It is not a substitute for a real
 * CC:Tweaked session; in-game validation is still outstanding.
 */

const chest = (slot: number) => ({ periphId: "minecraft:chest_0", slot });

function fixture(): Factory {
  return {
    machines: {
      "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1"], x: 10, y: 20 },
      "minecraft:chest_1": { id: "minecraft:chest_1", groups: ["minecraft:chest_1:g1"], x: 80, y: 20 },
    },
    groups: {
      "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", nickname: "Inventory", slots: [chest(1), chest(2)] },
      "minecraft:chest_1:g1": { id: "minecraft:chest_1:g1", nickname: "Inventory", slots: [{ periphId: "minecraft:chest_1", slot: 1 }] },
    },
    pipes: {
      "pipe:1": { id: "pipe:1", from: "minecraft:chest_0:g1", to: "minecraft:chest_1:g1", filter: "#warehouse" },
    },
    missing: {},
    available: { "minecraft:chest_9": true },
  };
}

/** Apply a ConfirmationResponse `diff` the way the browser does. */
function applyDiff(factory: Factory, diffs: unknown): Factory {
  let next = structuredClone(factory);
  for (const delta of Array.isArray(diffs) ? diffs : []) next = patch(next, delta as Delta) as Factory;
  return next;
}

function send(cc: FakeCc, request: object): void {
  cc.receive(request as unknown as WireMessage);
}

function responseOf(cc: FakeCc): WireMessage {
  const last = cc.lastSent;
  if (!last) throw new Error("fake CC sent no message");
  return last;
}

function socket() {
  const sent: string[] = [];
  const value = {
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
  } as unknown as WebSocket;
  return { value, sent };
}

const managers: SessionManager[] = [];

function newManager(overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const manager = new SessionManager({ idleTimeoutMs: 60_000, outboxTimeoutMs: 10_000, ...overrides });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    for (const session of manager.sessions.values()) manager.remove(session);
  }
  vi.useRealTimers();
});

describe("session handshake (relay)", () => {
  it("SessionCreate keeps the CC code and issues a reconnect token", () => {
    const manager = newManager();
    const session = manager.create("ABCD", socket().value);

    expect(session?.id).toBe("ABCD");
    expect(session?.ccReconnectToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // A second SessionCreate with the same code maps to SessionIdTaken upstream.
    expect(manager.create("ABCD", socket().value)).toBeUndefined();
  });

  it("SessionJoin accepts one editor and reports SessionHasEditor for a second", () => {
    const manager = newManager();
    manager.create("ABCD", socket().value);
    expect(manager.join("ABCD", socket().value)).toBeTruthy();
    expect(manager.join("ABCD", socket().value)).toBeUndefined();
    expect(manager.join("ZZZZ", socket().value)).toBeUndefined();
  });
});

describe("factory messages against the v4.3 controller model", () => {
  it("FactoryGet returns a ConfirmationResponse carrying the whole factory", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, { type: "FactoryGet", reqId: "r1" });

    const response = responseOf(cc);
    expect(response).toMatchObject({ type: "ConfirmationResponse", respondingTo: "FactoryGet", ok: true, reqId: "r1" });
    expect(response.factory).toEqual(fixture());
  });

  it("MachineEdit applies a nickname diff that the browser can patch", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();

    send(cc, buildNicknameEdit(cc.factory, "machine", "minecraft:chest_0", "Depot", () => "req-1"));

    const response = responseOf(cc);
    expect(response.ok).toBe(true);
    expect(applyDiff(client, response.diff).machines["minecraft:chest_0"]?.nickname).toBe("Depot");
    expect(applyDiff(client, response.diff)).toEqual(cc.factory);
  });

  it("GroupEdit replaces the slot list without touching other groups", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();

    send(cc, buildSlotUpdate(cc.factory, "minecraft:chest_0:g1", [chest(1)], () => "req-1"));

    const next = applyDiff(client, responseOf(cc).diff);
    expect(next.groups["minecraft:chest_0:g1"]?.slots).toEqual([chest(1)]);
    expect(next.groups["minecraft:chest_1:g1"]?.slots).toEqual([{ periphId: "minecraft:chest_1", slot: 1 }]);
    expect(next).toEqual(cc.factory);
  });

  it("GroupDel cascades to pipes and removes the emptied machine", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();
    const request = buildMachineDelete(cc.factory, "minecraft:chest_1", () => "req");

    send(cc, request);

    expect(responseOf(cc).ok).toBe(true);
    expect(cc.factory.machines["minecraft:chest_1"]).toBeUndefined();
    expect(cc.factory.groups["minecraft:chest_1:g1"]).toBeUndefined();
    expect(cc.factory.pipes["pipe:1"]).toBeUndefined();
    expect(applyDiff(client, responseOf(cc).diff)).toEqual(cc.factory);
  });

  it("BatchRequest executes in array order inside one save", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();

    send(cc, {
      type: "BatchRequest",
      reqId: "batch-1",
      requests: [
        { type: "GroupEdit", reqId: "b-1", groupId: "minecraft:chest_0:g1", edits: { nickname: "Main" } },
        { type: "GroupEdit", reqId: "b-2", groupId: "minecraft:chest_0:g1", edits: { slots: [chest(2), chest(1)] } },
      ],
    });

    expect(responseOf(cc).ok).toBe(true);
    expect(cc.factory.groups["minecraft:chest_0:g1"]).toMatchObject({ nickname: "Main", slots: [chest(2), chest(1)] });
    expect(applyDiff(client, responseOf(cc).diff)).toEqual(cc.factory);
  });

  it("BatchRequest rejects unknown child types before any mutation", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    send(cc, {
      type: "BatchRequest",
      reqId: "batch-2",
      requests: [{ type: "GroupMerge", reqId: "x-1", groupId: "minecraft:chest_0:g1" }],
    });

    const response = responseOf(cc);
    expect(response.ok).toBe(false);
    expect(cc.factory).toEqual(before);
  });

  it("BatchRequest rejects children with missing required fields", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    send(cc, {
      type: "BatchRequest",
      reqId: "batch-3",
      requests: [{ type: "PipeDel", reqId: "x-2" }],
    });

    const response = responseOf(cc);
    expect(response.ok).toBe(false);
    expect(cc.factory).toEqual(before);
  });

  it("PeriphAdd creates a machine with its groups and clears the available flag", () => {
    const cc = new FakeCc({ factory: fixture(), inventories: { "minecraft:chest_9": 3 } });

    send(cc, buildPeripheralAdd("minecraft:chest_9", { x: 200, y: 40 }, () => "req-1"));

    expect(cc.factory.available["minecraft:chest_9"]).toBeUndefined();
    expect(cc.factory.machines["minecraft:chest_9"]).toMatchObject({ x: 200, y: 40 });
    expect(cc.factory.groups["minecraft:chest_9:g1"]?.slots).toHaveLength(3);
  });

  it("PeriphDel removes slots and deletes groups that become empty", () => {
    const cc = new FakeCc({ factory: fixture() });
    cc.factory.missing["minecraft:chest_1"] = true;
    const client = structuredClone(cc.factory);

    send(cc, buildPeripheralDelete("minecraft:chest_1", () => "req-1"));

    expect(cc.factory.missing["minecraft:chest_1"]).toBeUndefined();
    expect(cc.factory.machines["minecraft:chest_1"]).toBeUndefined();
    expect(cc.factory.pipes["pipe:1"]).toBeUndefined();
    expect(applyDiff(client, responseOf(cc).diff)).toEqual(cc.factory);
  });

  it("CcUpdatedFactory diffs patch the browser copy", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();

    cc.syncPeripherals(["minecraft:chest_0"]);

    const update = responseOf(cc);
    expect(update.type).toBe("CcUpdatedFactory");
    expect(cc.factory.missing["minecraft:chest_1"]).toBe(true);
    expect(applyDiff(client, update.diff)).toEqual(cc.factory);
  });

  it("a split runs as one ordered batch with a single save", () => {
    const cc = new FakeCc({ factory: fixture() });
    const client = fixture();
    const request = buildGroupSplit(cc.factory, "minecraft:chest_0:g1", [chest(2)], "Overflow", () => "req", { x: 24, y: 40 });

    send(cc, request);

    expect(cc.factory.machines["minecraft:chest_0"]?.groups).toHaveLength(2);
    expect(cc.factory.groups["minecraft:chest_0:g2"]?.slots).toEqual([chest(2)]);
    expect(cc.factory.groups["minecraft:chest_0:g2"]?.x).toBe(24);
    expect(cc.factory.groups["minecraft:chest_0:g2"]?.y).toBe(40);
    expect(applyDiff(client, responseOf(cc).diff)).toEqual(cc.factory);
  });

  it("a container merge keeps slot identity, drops the source container and its pipes", () => {
    const source: Factory = {
      machines: {
        "minecraft:chest_0": { id: "minecraft:chest_0", groups: ["minecraft:chest_0:g1", "minecraft:chest_0:g2"] },
      },
      groups: {
        "minecraft:chest_0:g1": { id: "minecraft:chest_0:g1", nickname: "Main", slots: [chest(1), chest(2)] },
        "minecraft:chest_0:g2": { id: "minecraft:chest_0:g2", nickname: "Overflow", slots: [chest(3)] },
      },
      pipes: {
        "pipe:1": { id: "pipe:1", from: "minecraft:chest_0:g1", to: "minecraft:chest_0:g2", filter: "" },
      },
      missing: {},
      available: {},
    };
    const cc = new FakeCc({ factory: source });
    const client = structuredClone(source);

    send(cc, buildGroupMerge(cc.factory, "minecraft:chest_0:g1", "minecraft:chest_0:g2", () => "req"));

    expect(cc.factory.groups["minecraft:chest_0:g1"]).toBeUndefined();
    expect(cc.factory.groups["minecraft:chest_0:g2"]?.slots).toEqual([chest(1), chest(2), chest(3)]);
    expect(cc.factory.machines["minecraft:chest_0"]?.groups).toEqual(["minecraft:chest_0:g2"]);
    expect(cc.factory.pipes["pipe:1"]).toBeUndefined();
    expect(applyDiff(client, responseOf(cc).diff)).toEqual(cc.factory);
  });

  it("a multi-pipe delete batch removes all pipes in one request", () => {
    const cc = new FakeCc({ factory: fixture() });
    cc.factory.pipes["pipe:2"] = { id: "pipe:2", from: "minecraft:chest_1:g1", to: "minecraft:chest_0:g1" };
    const before = structuredClone(cc.factory);

    send(cc, buildPipeDeleteBatch(["pipe:1", "pipe:2"], () => "req"));

    expect(cc.factory.pipes).toEqual({});
    expect(applyDiff(before, responseOf(cc).diff)).toEqual(cc.factory);
  });
});

describe("failure and reconnect handling", () => {
  it("a failed save leaves the factory untouched and reports ok:false", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);
    cc.failSaves = 1;

    send(cc, buildNicknameEdit(cc.factory, "machine", "minecraft:chest_0", "Depot", () => "req-1"));

    expect(responseOf(cc)).toMatchObject({ ok: false, respondingTo: "MachineEdit", diff: [] });
    expect(cc.factory).toEqual(before);
  });

  it("unknown single request types produce no response at all", () => {
    const cc = new FakeCc({ factory: fixture() });
    send(cc, { type: "GroupMerge", reqId: "x-1" });
    expect(cc.sent).toHaveLength(0);
  });

  it("GroupAdd with an unknown machine fails like the Lua nil index", () => {
    const cc = new FakeCc({ factory: fixture() });
    const before = structuredClone(cc.factory);

    send(cc, { type: "GroupAdd", reqId: "g-1", machineId: "nope", group: { id: "g", slots: [chest(1)] } });

    expect(responseOf(cc).ok).toBe(false);
    expect(cc.factory).toEqual(before);
  });

  it("SessionRejoin requires the token and flushes queued editor requests in order", () => {
    const manager = newManager();
    const cc = socket();
    const session = manager.create("WXYZ", cc.value)!;
    manager.queueForComputer(session, { type: "FactoryGet", reqId: "1" });
    manager.queueForComputer(session, { type: "PipeDel", reqId: "2" });

    expect(manager.rejoin("WXYZ", "wrong", socket().value)).toBeUndefined();

    const revived = socket();
    expect(manager.rejoin("WXYZ", session.ccReconnectToken, revived.value)).toBe(session);
    manager.flushOutbox(session);
    expect(revived.sent.map(raw => JSON.parse(raw).reqId)).toEqual(["1", "2"]);
  });

  it("unconfirmed editor requests are dropped on timeout instead of being retried", () => {
    vi.useFakeTimers();
    const onOutboxTimeout = vi.fn();
    const manager = newManager({ outboxTimeoutMs: 50, onOutboxTimeout });
    const session = manager.create("QWER", socket().value)!;

    manager.queueForComputer(session, { type: "GroupEdit", reqId: "pending-1" });
    vi.advanceTimersByTime(50);

    expect(onOutboxTimeout).toHaveBeenCalledWith(session, [{ type: "GroupEdit", reqId: "pending-1" }]);
    expect(session.editorOutbox).toHaveLength(0);
  });

  it("the relay never stores factory state", () => {
    const manager = newManager();
    const session = manager.create("MNOP", socket().value)!;
    expect(Object.keys(session)).not.toContain("factory");
    expect(emptyFactory()).toEqual({ pipes: {}, machines: {}, groups: {}, missing: {}, available: {} });
  });
});

