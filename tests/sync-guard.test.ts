import { describe, expect, it } from "vitest";
import { FactorySyncGuard, classifyRequest } from "../apps/web/src/websocket/syncGuard";

/** 覆盖任务书 W5 的 10 条写入安全要求（纯状态机层）。 */
describe("FactorySyncGuard", () => {
  it("W5-1 pending mutation 时所有画布写入入口都不能产生第二个 mutation", () => {
    // 模拟画布上的不同入口：连线、边删除、Delete 键、拖动位置、属性面板。
    const entries = [
      { type: "PipeAdd" },
      { type: "PipeDel" },
      { type: "GroupDel" },
      { type: "MachineEdit" },
      { type: "GroupEdit" },
      { type: "BatchRequest", requests: [{ type: "GroupEdit" }] },
    ];
    const guard = new FactorySyncGuard();
    guard.begin("req-0", { type: "GroupEdit" });
    expect(guard.mutationPending()).toBe(true);

    for (const [index, request] of entries.entries()) {
      expect(() => guard.begin(`req-${index + 1}`, request)).toThrow(/已有写入请求等待游戏端确认/);
    }
    expect(guard.pendingCount()).toBe(1);
  });

  it("W5-2 只读与会话请求不被写入门禁误拦", () => {
    const guard = new FactorySyncGuard();
    guard.begin("mutation", { type: "GroupEdit" });
    expect(guard.begin("snapshot", { type: "FactoryGet" })).toBe("read");
    expect(guard.begin("join", { type: "SessionJoin" })).toBe("session");
    expect(guard.mutationPending()).toBe(true);

    expect(classifyRequest({ type: "GroupEdit" })).toBe("mutation");
    expect(classifyRequest({ type: "BatchRequest" })).toBe("mutation");
    expect(classifyRequest({ type: "FactoryGet" })).toBe("read");
    expect(classifyRequest({ type: "SessionClose" })).toBe("session");
    expect(() => classifyRequest({ type: "Unknown" })).toThrow(/不支持的消息类型/);
  });

  it("W5-3 mutation 超时后进入 stale，所有写入入口拒绝请求", () => {
    const guard = new FactorySyncGuard();
    guard.begin("req-1", { type: "GroupEdit" });
    expect(guard.noteTimeout("req-1")?.kind).toBe("mutation");
    expect(guard.stale()).toBe(true);
    expect(guard.staleReason()).toMatch(/超时/);

    for (const request of [{ type: "PipeAdd" }, { type: "GroupDel" }, { type: "BatchRequest" }]) {
      expect(() => guard.begin("req-2", request)).toThrow(/写入已冻结/);
    }
    expect(classifyRequest({ type: "FactoryGet" })).toBe("read");
    expect(guard.begin("snapshot", { type: "FactoryGet" })).toBe("read");
  });

  it("W5-4 超时后的迟到响应不能解除 stale", () => {
    const guard = new FactorySyncGuard();
    guard.begin("req-1", { type: "PipeAdd" });
    guard.noteTimeout("req-1");
    // 迟到响应到达时 pending 已收敛，finish 不应命中，也不能清除 stale。
    expect(guard.finish("req-1")).toBeNull();
    expect(guard.stale()).toBe(true);
    expect(() => guard.begin("req-2", { type: "PipeAdd" })).toThrow(/写入已冻结/);
  });

  it("W5-5 diff 应用失败后进入 stale", () => {
    const guard = new FactorySyncGuard();
    guard.markStale("工厂变更无法应用：应用工厂 diff 后得到无效数据");
    expect(guard.stale()).toBe(true);
    expect(guard.staleReason()).toMatch(/无法应用/);
    expect(() => guard.begin("req-1", { type: "GroupEdit" })).toThrow(/写入已冻结/);
  });

  it("W5-6 diff 引用校验失败后进入 stale", () => {
    const guard = new FactorySyncGuard();
    guard.markStale("工厂变更无法应用：Factory 引用错误：pipes.x.from: 引用了不存在的分组");
    expect(guard.stale()).toBe(true);
    expect(guard.staleReason()).toMatch(/引用错误/);
    expect(guard.mutationPending()).toBe(false);
  });

  it("W5-7 全量同步失败后持续 stale", () => {
    const guard = new FactorySyncGuard();
    guard.begin("snapshot", { type: "FactoryGet" });
    guard.noteTimeout("snapshot");
    guard.markStale("工厂快照请求失败：UnknownError");
    expect(guard.stale()).toBe(true);
    expect(guard.staleReason()).toMatch(/快照请求失败/);
    expect(() => guard.begin("req-1", { type: "MachineEdit" })).toThrow(/写入已冻结/);
  });

  it("W5-8 全量同步完整校验通过后才恢复写入", () => {
    const guard = new FactorySyncGuard();
    guard.begin("req-1", { type: "PipeDel" });
    guard.noteTimeout("req-1");
    expect(guard.stale()).toBe(true);

    // 快照校验期间仍然冻结。
    expect(() => guard.begin("req-2", { type: "PipeDel" })).toThrow(/写入已冻结/);

    guard.clearStale();
    expect(guard.stale()).toBe(false);
    expect(guard.staleReason()).toBe("");
    expect(guard.begin("req-2", { type: "PipeDel" })).toBe("mutation");
    expect(guard.mutationPending()).toBe(true);
  });

  it("W5-9 断线/重连不会清除 stale", () => {
    const guard = new FactorySyncGuard();
    guard.markStale("工厂变更无法应用：服务端返回的 diff 不是数组");
    guard.noteConnectionLost();
    expect(guard.stale()).toBe(true);

    // 重连只允许会话/只读请求，不解除 stale。
    guard.begin("join", { type: "SessionJoin" });
    guard.finish("join");
    guard.begin("snapshot", { type: "FactoryGet" });
    guard.finish("snapshot");
    expect(guard.stale()).toBe(true);
    expect(() => guard.begin("req-1", { type: "GroupEdit" })).toThrow(/写入已冻结/);

    // 断线时仍有未确认写入，也会进入 stale。
    const second = new FactorySyncGuard();
    second.begin("req-1", { type: "GroupEdit" });
    expect(second.noteConnectionLost()).toBe(true);
    expect(second.stale()).toBe(true);
    expect(second.pendingCount()).toBe(0);
  });

  it("W5-10 超时的 mutation 不会被自动重试", () => {
    const guard = new FactorySyncGuard();
    guard.begin("req-1", { type: "GroupEdit" });
    guard.noteTimeout("req-1");
    // 超时后没有留下任何 pending 记录，也不存在自动重发路径。
    expect(guard.pendingCount()).toBe(0);
    expect(guard.snapshot()).toEqual({
      stale: true,
      staleReason: expect.stringMatching(/超时/),
      mutationPending: false,
      pendingCount: 0,
    });
    expect(guard.noteTimeout("req-1")).toBeNull();
  });

  it("明确失败响应正常收敛，不会误标 stale", () => {
    const guard = new FactorySyncGuard();
    guard.begin("req-1", { type: "GroupEdit" });
    expect(guard.finish("req-1")).toBe("mutation");
    expect(guard.stale()).toBe(false);
    expect(guard.begin("req-2", { type: "GroupEdit" })).toBe("mutation");
  });

  it("F01/F02 同一 Session 的 FactoryGet 只能有一个在途", () => {
    const guard = new FactorySyncGuard();
    expect(guard.begin("sync-1", { type: "FactoryGet" })).toBe("read");
    expect(guard.pendingFactoryGet()).toBe(true);
    expect(() => guard.begin("sync-2", { type: "FactoryGet" })).toThrow(/已有 FactoryGet/);
    guard.finish("sync-1");
    expect(guard.pendingFactoryGet()).toBe(false);
    expect(guard.begin("sync-3", { type: "FactoryGet" })).toBe("read");
  });

  it("F03 FactoryGet 超时后释放单飞名额，不自动重试", () => {
    const guard = new FactorySyncGuard();
    guard.begin("sync-1", { type: "FactoryGet" });
    expect(guard.noteTimeout("sync-1")?.kind).toBe("read");
    expect(guard.pendingFactoryGet()).toBe(false);
    expect(guard.stale()).toBe(false);
    expect(guard.begin("sync-2", { type: "FactoryGet" })).toBe("read");
  });
});
