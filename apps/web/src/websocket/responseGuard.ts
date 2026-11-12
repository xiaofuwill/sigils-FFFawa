import type { RequestKind } from "./syncGuard";

/**
 * 请求 / 响应严格匹配与载荷校验（纯函数）。
 *
 * 规范：只有 envelope、reqId、respondingTo、Session、connection epoch 和 payload
 * 全部校验通过后，调用方才能清理 pending、调用 guard.finish、应用 Factory/diff
 * 或改变 stale 状态。
 */

export interface PendingSnapshot {
  reqId: string;
  /** 原始请求类型（BatchRequest 必须是 "BatchRequest"，不能是子请求类型）。 */
  type: string;
  sessionCode: string;
  epoch: number;
  /** 请求发出时的 mutation 序号；用于判断快照是否覆盖后续写入。 */
  mutationSeq: number;
  kind: RequestKind;
}

export interface ResponseContext {
  sessionCode: string;
  epoch: number;
  mutationSeq: number;
}

export interface ConfirmationEnvelope {
  type: "ConfirmationResponse";
  reqId: string;
  respondingTo: string;
  ok: boolean;
  [key: string]: unknown;
}

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ValidatedPayload =
  | { kind: "factory"; factory: unknown }
  | { kind: "diff"; diff: unknown[] }
  | { kind: "none" };

function ok<T>(value: T): Check<T> {
  return { ok: true, value };
}

function fail<T>(reason: string): Check<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验 ConfirmationResponse 的外层结构；失败时不产生任何状态变化。 */
export function readConfirmationEnvelope(message: unknown): Check<ConfirmationEnvelope> {
  if (!isRecord(message)) return fail("响应不是对象");
  if (message.type !== "ConfirmationResponse") return fail("响应类型不是 ConfirmationResponse");
  if (typeof message.reqId !== "string" || message.reqId.length === 0) return fail("响应缺少 reqId");
  if (typeof message.respondingTo !== "string" || message.respondingTo.length === 0) return fail("响应缺少 respondingTo");
  if (typeof message.ok !== "boolean") return fail("响应缺少 ok 布尔值");
  return ok(message as ConfirmationEnvelope);
}

/**
 * 将响应与 pending 记录严格匹配：
 * reqId 必须对应 pending，Session、connection epoch、respondingTo 必须一致。
 */
export function matchPending(
  pending: PendingSnapshot | undefined,
  response: ConfirmationEnvelope,
  context: ResponseContext,
): Check<PendingSnapshot> {
  if (!pending) return fail(`未知 reqId：${response.reqId}（可能已超时、重复或不属于当前会话）`);
  if (pending.epoch !== context.epoch) {
    return fail(`响应属于旧连接代际（请求 ${pending.epoch} / 当前 ${context.epoch}）`);
  }
  if (pending.sessionCode !== context.sessionCode) {
    return fail(`响应属于旧会话（请求 ${pending.sessionCode} / 当前 ${context.sessionCode || "无"}）`);
  }
  if (response.respondingTo !== pending.type) {
    return fail(`respondingTo 不匹配：期望 ${pending.type}，实际 ${response.respondingTo}`);
  }
  return ok(pending);
}

/**
 * 按原始请求类型校验成功响应载荷。
 * FactoryGet 只检查 factory 是对象；结构与引用校验由调用方用 factory-model 完成。
 */
export function validateSuccessPayload(type: string, response: ConfirmationEnvelope): Check<ValidatedPayload> {
  if (type === "FactoryGet") {
    if (!isRecord(response.factory)) return fail("FactoryGet 成功响应缺少 factory 对象");
    return ok({ kind: "factory", factory: response.factory });
  }
  if (type === "SessionJoin" || type === "SessionClose") return ok({ kind: "none" });
  if (!Array.isArray(response.diff)) return fail(`${type} 成功响应缺少 diff 数组`);
  return ok({ kind: "diff", diff: response.diff });
}

/**
 * 快照覆盖校验：FactoryGet 发出时的 mutation 序号必须等于当前序号，
 * 否则说明之后又发出过写入，该快照不能作为同步屏障。
 */
export function validateSnapshotCoverage(snapshotSeq: number, currentSeq: number): Check<null> {
  if (snapshotSeq !== currentSeq) {
    return fail(`快照请求早于后续写入（快照 seq=${snapshotSeq}，当前 seq=${currentSeq}），不能解除冻结`);
  }
  return ok(null);
}

/**
 * CC 端屏障证明：WebSocket 消息按到达顺序 `os.queueEvent`，controller 单协程按
 * FIFO `os.pullEvent` 逐条处理，mutation 在同一事件内完成后才 `saveFactory`，
 * 因此晚于 mutation 发出的 FactoryGet 快照必然包含该 mutation 的结果。
 *
 * 该结论依赖：单编辑器、relay 保序转发、controller 不并发处理事件。
 * 这个常量用于在 UI / 日志中显式标注屏障来源，避免被误解为“前端 generation 屏障”。
 */
export const CC_FIFO_BARRIER = "cc-fifo-event-queue";
