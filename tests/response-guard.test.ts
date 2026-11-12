import { describe, expect, it } from "vitest";
import {
  matchPending,
  readConfirmationEnvelope,
  validateSnapshotCoverage,
  validateSuccessPayload,
  type PendingSnapshot,
} from "../apps/web/src/websocket/responseGuard";

const context = { sessionCode: "ABCD", epoch: 3, mutationSeq: 5 };

function pending(overrides: Partial<PendingSnapshot> = {}): PendingSnapshot {
  return {
    reqId: "req-1",
    type: "GroupEdit",
    sessionCode: "ABCD",
    epoch: 3,
    mutationSeq: 5,
    kind: "mutation",
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    type: "ConfirmationResponse",
    reqId: "req-1",
    respondingTo: "GroupEdit",
    ok: true,
    diff: [{ groups: {} }],
    ...overrides,
  };
}

describe("ConfirmationResponse 严格匹配（R01–R10）", () => {
  it("R01 正确 reqId + respondingTo + payload 才能通过", () => {
    const envelope = readConfirmationEnvelope(response());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;

    const matched = matchPending(pending(), envelope.value, context);
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;

    const payload = validateSuccessPayload(matched.value.type, envelope.value);
    expect(payload).toEqual({ ok: true, value: { kind: "diff", diff: [{ groups: {} }] } });
  });

  it("R02 respondingTo 与 pending 类型不一致时拒绝", () => {
    const envelope = readConfirmationEnvelope(response({ respondingTo: "MachineEdit" }));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending(), envelope.value, context)).toEqual({
      ok: false,
      reason: "respondingTo 不匹配：期望 GroupEdit，实际 MachineEdit",
    });
  });

  it("R03 未知 reqId 被忽略", () => {
    const envelope = readConfirmationEnvelope(response({ reqId: "unknown" }));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(undefined, envelope.value, context).ok).toBe(false);
  });

  it("R04/R05 payload 缺字段或类型错误时拒绝", () => {
    const noFactory = readConfirmationEnvelope({ type: "ConfirmationResponse", reqId: "f-1", respondingTo: "FactoryGet", ok: true });
    expect(noFactory.ok).toBe(true);
    if (!noFactory.ok) return;
    expect(validateSuccessPayload("FactoryGet", noFactory.value)).toEqual({
      ok: false, reason: "FactoryGet 成功响应缺少 factory 对象",
    });

    const noDiff = readConfirmationEnvelope(response({ diff: undefined }));
    expect(noDiff.ok).toBe(true);
    if (!noDiff.ok) return;
    expect(validateSuccessPayload("GroupEdit", noDiff.value)).toEqual({
      ok: false, reason: "GroupEdit 成功响应缺少 diff 数组",
    });
  });

  it("R06 重复响应：第一次完成后 reqId 不再存在，第二次被拒绝", () => {
    const envelope = readConfirmationEnvelope(response());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending(), envelope.value, context).ok).toBe(true);
    expect(matchPending(undefined, envelope.value, context).ok).toBe(false);
  });

  it("R07 旧 Session 响应被拒绝", () => {
    const envelope = readConfirmationEnvelope(response());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending({ sessionCode: "WXYZ" }), envelope.value, context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("旧会话"),
    });
  });

  it("R08 旧连接代际响应被拒绝", () => {
    const envelope = readConfirmationEnvelope(response());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending({ epoch: 2 }), envelope.value, context)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("旧连接代际"),
    });
  });

  it("R09 BatchRequest 被其他响应类型应答时拒绝", () => {
    const envelope = readConfirmationEnvelope(response({ respondingTo: "PipeDel" }));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending({ type: "BatchRequest", kind: "mutation" }), envelope.value, context).ok).toBe(false);
  });

  it("R10 子请求响应不能冒充 BatchRequest 完成响应", () => {
    const envelope = readConfirmationEnvelope(response({ respondingTo: "GroupEdit", reqId: "batch-1" }));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(matchPending(pending({ reqId: "batch-1", type: "BatchRequest" }), envelope.value, context)).toEqual({
      ok: false,
      reason: "respondingTo 不匹配：期望 BatchRequest，实际 GroupEdit",
    });
  });

  it("envelope 缺 reqId / respondingTo / ok 时直接判无效", () => {
    expect(readConfirmationEnvelope({ type: "ConfirmationResponse", respondingTo: "GroupEdit", ok: true })).toEqual({
      ok: false, reason: "响应缺少 reqId",
    });
    expect(readConfirmationEnvelope({ type: "ConfirmationResponse", reqId: "r", ok: true })).toEqual({
      ok: false, reason: "响应缺少 respondingTo",
    });
    expect(readConfirmationEnvelope({ type: "ConfirmationResponse", reqId: "r", respondingTo: "GroupEdit" })).toEqual({
      ok: false, reason: "响应缺少 ok 布尔值",
    });
    expect(readConfirmationEnvelope(null)).toEqual({ ok: false, reason: "响应不是对象" });
  });
});

describe("快照覆盖（S04 / S06）", () => {
  it("S04 快照 seq 与当前一致时允许作为屏障", () => {
    expect(validateSnapshotCoverage(5, 5)).toEqual({ ok: true, value: null });
  });

  it("S06 快照发出后又有写入时不能解除 stale", () => {
    expect(validateSnapshotCoverage(5, 6)).toEqual({
      ok: false,
      reason: "快照请求早于后续写入（快照 seq=5，当前 seq=6），不能解除冻结",
    });
  });

  it("SessionJoin / SessionClose 不要求 diff", () => {
    const envelope = readConfirmationEnvelope({ type: "ConfirmationResponse", reqId: "s-1", respondingTo: "SessionJoin", ok: true });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(validateSuccessPayload("SessionJoin", envelope.value)).toEqual({ ok: true, value: { kind: "none" } });
  });

  it("FactoryGet 通过时的 payload 只做对象级校验", () => {
    const envelope = readConfirmationEnvelope({
      type: "ConfirmationResponse", reqId: "f-1", respondingTo: "FactoryGet", ok: true,
      factory: { machines: {}, groups: {}, pipes: {}, missing: {}, available: {} },
    });
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(validateSuccessPayload("FactoryGet", envelope.value)).toEqual({
      ok: true,
      value: { kind: "factory", factory: { machines: {}, groups: {}, pipes: {}, missing: {}, available: {} } },
    });
  });
});
