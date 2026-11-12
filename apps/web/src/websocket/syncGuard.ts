import { isFactoryUpdateRequestType } from "../../../../packages/protocol/src/index";

/** 请求语义分类：mutation 会修改工厂，read 只读取快照，session 管理会话。 */
export type RequestKind = "mutation" | "read" | "session";

const SESSION_REQUEST_TYPES = new Set(["SessionJoin", "SessionClose"]);
const READ_REQUEST_TYPES = new Set(["FactoryGet"]);

/**
 * 判定请求是否属于工厂写入。BatchRequest 的每个子请求都是工厂写入，
 * 因此整体按 mutation 处理（子请求的白名单校验由连接层完成）。
 */
export function classifyRequest(request: { type: string }): RequestKind {
  if (isFactoryUpdateRequestType(request.type)) return "mutation";
  if (request.type === "BatchRequest") return "mutation";
  if (READ_REQUEST_TYPES.has(request.type)) return "read";
  if (SESSION_REQUEST_TYPES.has(request.type)) return "session";
  throw new Error(`不支持的消息类型：${request.type}`);
}

export type SyncGuardSnapshot = {
  stale: boolean;
  staleReason: string;
  mutationPending: boolean;
  pendingCount: number;
};

type PendingRecord = { type: string; kind: RequestKind };

/**
 * 工厂写入门禁。只负责状态机，不依赖 React / WebSocket，便于单元测试。
 *
 * 不变量：
 * - 同时最多一个 mutation pending；
 * - stale 期间拒绝一切 mutation，只有 clearStale（全量快照校验通过后）能解除；
 * - 断线、重连、关闭提示都不会清除 stale；
 * - 超时不会自动重试。
 */
export class FactorySyncGuard {
  private staleFlag = false;
  private reason = "";
  private pending = new Map<string, PendingRecord>();

  stale(): boolean {
    return this.staleFlag;
  }

  staleReason(): string {
    return this.reason;
  }

  mutationPending(): boolean {
    for (const record of this.pending.values()) {
      if (record.kind === "mutation") return true;
    }
    return false;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** 登记请求；mutation 在 stale 或已有 mutation pending 时直接抛错。 */
  begin(reqId: string, request: { type: string }): RequestKind {
    const kind = classifyRequest(request);
    if (kind === "mutation") {
      if (this.staleFlag) {
        throw new Error(`工厂状态不可信（${this.reason || "需要重新同步"}），写入已冻结；请先点击「重新同步工厂」。`);
      }
      if (this.mutationPending()) {
        throw new Error("已有写入请求等待游戏端确认，请等待完成后再操作。");
      }
    }
    // 同一 Session / 连接代际只允许一个 FactoryGet，避免并发恢复快照。
    if (kind === "read" && request.type === "FactoryGet" && this.pendingFactoryGet()) {
      throw new Error("已有 FactoryGet 同步请求正在进行，请等待完成。");
    }
    this.pending.set(reqId, { type: request.type, kind });
    return kind;
  }

  pendingFactoryGet(): boolean {
    for (const record of this.pending.values()) {
      if (record.type === "FactoryGet") return true;
    }
    return false;
  }

  /** 正常收敛：成功或明确失败响应都通过这里结束 pending。 */
  finish(reqId: string): RequestKind | null {
    const record = this.pending.get(reqId);
    if (!record) return null;
    this.pending.delete(reqId);
    return record.kind;
  }

  /**
   * 超时收敛。mutation 超时意味着结果未知，必须进入 stale；
   * 全量快照请求超时则保持冻结（不会因为重试成功前的空档放开写入）。
   */
  noteTimeout(reqId: string): PendingRecord | null {
    const record = this.pending.get(reqId) ?? null;
    if (!record) return null;
    this.pending.delete(reqId);
    if (record.kind === "mutation") {
      this.markStale(`写入请求 ${record.type} 超时，结果未知`);
    } else if (record.kind === "read" && this.staleFlag) {
      this.markStale("全量同步请求超时，写入保持冻结");
    }
    return record;
  }

  markStale(reason: string): void {
    this.staleFlag = true;
    this.reason = reason;
  }

  /** 只允许在完整快照通过结构/引用校验并原子替换后调用。 */
  clearStale(): void {
    this.staleFlag = false;
    this.reason = "";
  }

  /**
   * 连接关闭。未确认的写入结果未知，进入 stale；已 stale 的状态原样保留，
   * 重连本身不构成恢复依据。
   */
  noteConnectionLost(): boolean {
    const hadPendingMutation = this.mutationPending();
    this.pending.clear();
    if (hadPendingMutation) {
      this.markStale("连接中断时仍有未确认的写入请求，结果未知");
    }
    return hadPendingMutation;
  }

  snapshot(): SyncGuardSnapshot {
    return {
      stale: this.staleFlag,
      staleReason: this.reason,
      mutationPending: this.mutationPending(),
      pendingCount: this.pending.size,
    };
  }
}
