import { afterEach, describe, expect, it, vi } from "vitest";
import { isSigilsSessionCode, SessionManager } from "../src/session-manager.js";
import type { WebSocket } from "ws";

function socket() {
  const sent: string[] = [];
  const value = {
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
  } as unknown as WebSocket;
  return { value, sent };
}

describe("SIGILS v4.3 session code format", () => {
  it("accepts exactly four uppercase ASCII letters", () => {
    expect(isSigilsSessionCode("ABCD")).toBe(true);
    expect(isSigilsSessionCode("abcD")).toBe(false);
    expect(isSigilsSessionCode("AB12")).toBe(false);
    expect(isSigilsSessionCode("ABC")).toBe(false);
  });
});

describe("SessionManager", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) {
      for (const session of manager.sessions.values()) manager.remove(session);
    }
    vi.useRealTimers();
  });

  it("creates unique sessions and preserves the supplied four-character code", () => {
    const manager = new SessionManager({ idleTimeoutMs: 60_000, outboxTimeoutMs: 10_000 });
    managers.push(manager);
    const cc = socket();
    const created = manager.create("ABZX", cc.value);
    expect(created?.id).toBe("ABZX");
    expect(created?.ccReconnectToken).toBeTruthy();
    expect(manager.create("ABZX", socket().value)).toBeUndefined();
  });

  it("allows one editor and rejects a second active editor", () => {
    const manager = new SessionManager({ idleTimeoutMs: 60_000, outboxTimeoutMs: 10_000 });
    managers.push(manager);
    manager.create("1234", socket().value);
    expect(manager.join("1234", socket().value)).toBeTruthy();
    expect(manager.join("1234", socket().value)).toBeUndefined();
  });

  it("reconnects only with the token and flushes queued requests in FIFO order", () => {
    const manager = new SessionManager({ idleTimeoutMs: 60_000, outboxTimeoutMs: 10_000 });
    managers.push(manager);
    const cc = socket();
    const session = manager.create("ZYXW", cc.value)!;
    manager.queueForComputer(session, { type: "PipeEdit", reqId: "1" });
    manager.queueForComputer(session, { type: "PipeDel", reqId: "2" });
    expect(manager.rejoin("ZYXW", "wrong", socket().value)).toBeUndefined();
    const nextCc = socket();
    expect(manager.rejoin("ZYXW", session.ccReconnectToken, nextCc.value)).toBe(session);
    manager.flushOutbox(session);
    expect(nextCc.sent.map(s => JSON.parse(s).reqId)).toEqual(["1", "2"]);
  });

  it("expires queued requests through the configured timeout callback", () => {
    vi.useFakeTimers();
    const onOutboxTimeout = vi.fn();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, outboxTimeoutMs: 50, onOutboxTimeout });
    managers.push(manager);
    const session = manager.create("QWER", socket().value)!;
    manager.queueForComputer(session, { type: "FactoryGet", reqId: "r1" });
    vi.advanceTimersByTime(50);
    expect(onOutboxTimeout).toHaveBeenCalledWith(session, [{ type: "FactoryGet", reqId: "r1" }]);
    expect(session.editorOutbox).toHaveLength(0);
  });
});
