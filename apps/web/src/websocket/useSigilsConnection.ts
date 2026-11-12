import { useCallback, useEffect, useRef, useState } from "react";
import { patch, type Delta } from "jsondiffpatch";
import type { Factory } from "../../../../packages/factory-model/src/index";
import {
  validateFactoryReferences,
  validateFactoryShape,
} from "../../../../packages/factory-model/src/index";
import { isFactoryUpdateRequestType } from "../../../../packages/protocol/src/index";
import { FactorySyncGuard, type RequestKind, type SyncGuardSnapshot } from "./syncGuard";
import {
  matchPending,
  readConfirmationEnvelope,
  validateSnapshotCoverage,
  validateSuccessPayload,
  type PendingSnapshot,
} from "./responseGuard";

export type ConnectionStatus = "offline" | "connecting" | "joining" | "loading" | "connected" | "reconnecting" | "error";

type PendingRequest = {
  type: string;
  timer: number;
  sessionCode: string;
  epoch: number;
  mutationSeq: number;
  kind: RequestKind;
};
type ConnectionOptions = {
  onFactoryUpdate?: (factory: Factory) => void;
};

const RECONNECT_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 45000;
const HEARTBEAT_TIMEOUT_MS = 60000;

/** Editor-originated messages that are not factory mutations. */
const EDITOR_MESSAGE_TYPES = new Set(["FactoryGet", "SessionJoin", "SessionClose", "BatchRequest"]);

/**
 * Reject anything the v4.3 controller would silently ignore. A batch item with an
 * unknown type still produces `ok: true`, so a typo must be caught before sending.
 */
function assertSupportedRequest(request: { type: string; [key: string]: unknown }): void {
  if (isFactoryUpdateRequestType(request.type)) return;
  if (!EDITOR_MESSAGE_TYPES.has(request.type)) throw new Error(`不支持的消息类型：${request.type}`);
  if (request.type !== "BatchRequest") return;

  const requests = request.requests;
  if (!Array.isArray(requests) || requests.length === 0) throw new Error("BatchRequest 至少需要包含一个请求。");
  for (const child of requests) {
    const type = (child as { type?: unknown } | null)?.type;
    if (!isFactoryUpdateRequestType(type)) throw new Error(`BatchRequest 包含不支持的类型：${String(type)}`);
  }
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/** 同步相关日志：包含 reqId、类型、Session / epoch，便于排查错配与迟到响应。 */
function logSync(reason: string, details: Record<string, unknown>): void {
  console.warn(`[sigils-sync] ${reason}`, details);
}

function validateAndFreezeFactory(value: unknown): Factory {
  const shape = validateFactoryShape(value);
  if (shape.length) throw new Error(`Factory 格式错误：${shape.slice(0, 3).map(v => `${v.path}: ${v.message}`).join("；")}`);
  const factory = value as Factory;
  const references = validateFactoryReferences(factory);
  if (references.length) throw new Error(`Factory 引用错误：${references.slice(0, 3).map(v => `${v.path}: ${v.message}`).join("；")}`);
  return factory;
}

function applyDiffs(current: Factory, diffs: unknown): Factory {
  if (!Array.isArray(diffs)) throw new Error("服务端返回的 diff 不是数组");
  let next = structuredClone(current);
  for (const diff of diffs) {
    // jsondiffpatch.patch mutates its left-hand object; always patch a private clone.
    next = patch(next, diff as Delta) as Factory;
    if (!next || typeof next !== "object") throw new Error("应用工厂 diff 后得到无效数据");
  }
  return validateAndFreezeFactory(next);
}

export function useSigilsConnection(options: ConnectionOptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [factory, setFactory] = useState<Factory | null>(null);
  const factoryRef = useRef<Factory | null>(null);
  const [sessionCode, setSessionCode] = useState("");
  const [endpoint, setEndpoint] = useState(import.meta.env.VITE_SIGILS_WS_URL || "ws://localhost:3000");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sync, setSync] = useState<SyncGuardSnapshot>({
    stale: false, staleReason: "", mutationPending: false, pendingCount: 0,
  });
  const [syncing, setSyncing] = useState(false);
  const guardRef = useRef(new FactorySyncGuard());
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const heartbeatTimerRef = useRef<number | undefined>(undefined);
  const heartbeatDeadlineRef = useRef<number | undefined>(undefined);
  const shouldReconnectRef = useRef(false);
  const generationRef = useRef(0);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  /** 当前会话码；用于拒绝旧 Session 的迟到响应。 */
  const sessionCodeRef = useRef("");
  /** 每条 WebSocket 连接递增；旧连接代际的响应一律拒绝。 */
  const epochRef = useRef(0);
  /** 每发出一个 mutation 递增；用于证明恢复快照覆盖了此前全部写入。 */
  const mutationSeqRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const publishSyncState = useCallback(() => {
    setSync(guardRef.current.snapshot());
    setSyncing([...pendingRef.current.values()].some(pending => pending.type === "FactoryGet"));
  }, []);

  /** 只有严格匹配并通过载荷校验的响应才能走到这里。 */
  const settlePending = useCallback((reqId: string) => {
    const pending = pendingRef.current.get(reqId);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingRef.current.delete(reqId);
    }
    guardRef.current.finish(reqId);
    publishSyncState();
  }, [publishSyncState]);

  const clearPending = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timer);
    }
    if (pendingRef.current.size) setNotice(message);
    pendingRef.current.clear();
    publishSyncState();
  }, [publishSyncState]);

  const stopTimers = useCallback(() => {
    if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current);
    if (heartbeatTimerRef.current !== undefined) window.clearInterval(heartbeatTimerRef.current);
    if (heartbeatDeadlineRef.current !== undefined) window.clearTimeout(heartbeatDeadlineRef.current);
    reconnectTimerRef.current = undefined;
    heartbeatTimerRef.current = undefined;
    heartbeatDeadlineRef.current = undefined;
  }, []);

  const sendRaw = useCallback((message: { type: string; reqId: string; [key: string]: unknown }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("当前没有可用的 WebSocket 连接");
    socket.send(JSON.stringify(message));
  }, []);

  const sendRequest = useCallback(<T extends { type: string }>(request: T) => {
    assertSupportedRequest(request as { type: string; [key: string]: unknown });
    const reqId = newRequestId();
    // 唯一写入门禁 + FactoryGet 单飞：stale / 已有 mutation / 已有 FactoryGet
    // 时直接抛错，即使 UI 的禁用状态失效也不会产生第二个请求。
    const kind = guardRef.current.begin(reqId, request);
    if (kind === "mutation") mutationSeqRef.current += 1;
    const message = { ...request, reqId };
    const timer = window.setTimeout(() => {
      pendingRef.current.delete(reqId);
      const timedOut = guardRef.current.noteTimeout(reqId);
      publishSyncState();
      const message = `${request.type} 请求超时，结果未知；请点击「重新同步工厂」确认当前状态。`;
      setNotice(message);
      if (timedOut?.kind === "mutation") setError(message);
      if (request.type === "FactoryGet" || request.type === "SessionJoin") {
        setStatus("error");
        setError(message);
      }
    }, REQUEST_TIMEOUT_MS);
    pendingRef.current.set(reqId, {
      type: request.type,
      timer,
      sessionCode: sessionCodeRef.current,
      epoch: epochRef.current,
      mutationSeq: mutationSeqRef.current,
      kind,
    });
    publishSyncState();
    try {
      sendRaw(message as { type: string; reqId: string; [key: string]: unknown });
    } catch (sendError) {
      window.clearTimeout(timer);
      pendingRef.current.delete(reqId);
      guardRef.current.finish(reqId);
      publishSyncState();
      throw sendError;
    }
    return reqId;
  }, [sendRaw, publishSyncState]);

  const applyIncomingDiff = useCallback((diffs: unknown) => {
    if (guardRef.current.stale()) {
      // stale 期间画面保留，但不接受任何增量；恢复只能靠完整快照。
      setNotice("工厂状态不可信，已忽略增量变更；请点击「重新同步工厂」。");
      return;
    }
    const current = factoryRef.current;
    if (!current) {
      guardRef.current.markStale("收到工厂变更时尚未加载初始工厂快照");
      publishSyncState();
      setError("收到工厂变更时尚未加载初始工厂快照，已忽略该变更。请点击「重新同步工厂」。");
      return;
    }
    try {
      const next = applyDiffs(current, diffs);
      factoryRef.current = next;
      setFactory(next);
      optionsRef.current.onFactoryUpdate?.(next);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "无法应用工厂变更";
      guardRef.current.markStale(`工厂变更无法应用：${detail}`);
      publishSyncState();
      setError(`${detail}；工厂状态已标记为不可信，写入已冻结。`);
    }
  }, [publishSyncState]);

  const handleMessage = useCallback((raw: unknown, socket: WebSocket) => {
    if (socket !== socketRef.current) return;
    if (raw === "pong") {
      if (heartbeatDeadlineRef.current !== undefined) window.clearTimeout(heartbeatDeadlineRef.current);
      heartbeatDeadlineRef.current = undefined;
      return;
    }
    if (typeof raw !== "string") return;

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== "string") {
        throw new Error("消息格式无效");
      }
      message = parsed as Record<string, unknown>;
    } catch (cause) {
      setError(cause instanceof Error ? `收到无效消息：${cause.message}` : "收到无效消息");
      return;
    }

    if (message.type === "ConfirmationResponse") {
      // 1) 先校验 envelope，再匹配 pending；任何一步失败都不得改变状态。
      const envelope = readConfirmationEnvelope(message);
      if (!envelope.ok) {
        logSync("忽略无效响应", { reason: envelope.reason });
        setError(`忽略无效响应：${envelope.reason}`);
        return;
      }
      const response = envelope.value;
      const pending = pendingRef.current.get(response.reqId);
      const context = {
        sessionCode: sessionCodeRef.current,
        epoch: epochRef.current,
        mutationSeq: mutationSeqRef.current,
      };
      const matched = matchPending(
        pending
          ? {
            reqId: response.reqId,
            type: pending.type,
            sessionCode: pending.sessionCode,
            epoch: pending.epoch,
            mutationSeq: pending.mutationSeq,
            kind: pending.kind,
          } satisfies PendingSnapshot
          : undefined,
        response,
        context,
      );
      if (!matched.ok) {
        logSync("拒绝响应", {
          reqId: response.reqId,
          respondingTo: response.respondingTo,
          reason: matched.reason,
          sessionCode: context.sessionCode,
          epoch: context.epoch,
        });
        if (!pending) setNotice(`忽略未匹配响应：${matched.reason}`);
        else setError(matched.reason);
        return;
      }
      const record = matched.value;

      // 2) 明确失败响应：匹配通过后才是确定的失败结果，可以收敛 pending。
      if (!response.ok) {
        settlePending(record.reqId);
        const detail = `${String(response.message || "请求失败")}${response.error ? ` (${String(response.error)})` : ""}`;
        if (record.type === "SessionJoin") {
          shouldReconnectRef.current = false;
          setStatus("error");
          setError(`加入会话失败：${detail}`);
          socket.close(4009, "Session join failed");
          return;
        }
        if (record.type === "FactoryGet") {
          guardRef.current.markStale(`工厂快照请求失败：${detail}`);
          publishSyncState();
          setStatus("error");
          setError(`工厂快照请求失败：${detail}；写入保持冻结。`);
          return;
        }
        setNotice(`${record.type}：${detail}`);
        return;
      }

      // 3) 成功响应先做 payload 校验；FactoryGet 还要做完整结构/引用校验。
      const payload = validateSuccessPayload(record.type, response);
      if (!payload.ok) {
        logSync("拒绝响应载荷", { reqId: record.reqId, type: record.type, reason: payload.reason });
        setError(`响应载荷无效：${payload.reason}`);
        return;
      }

      let snapshotFactory: Factory | undefined;
      if (payload.value.kind === "factory") {
        try {
          snapshotFactory = validateAndFreezeFactory(payload.value.factory);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : "工厂数据校验失败";
          logSync("快照校验失败", { reqId: record.reqId, reason: detail });
          setError(`${detail}；快照未应用，写入状态保持不变。`);
          return;
        }
      }

      // 4) 全部校验通过后才收敛 pending。
      settlePending(record.reqId);

      if (record.type === "SessionJoin") {
        setStatus("loading");
        setError("");
        try {
          sendRequest({ type: "FactoryGet" });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "无法请求工厂数据");
        }
        return;
      }

      if (record.type === "FactoryGet") {
        // 5) 同步屏障：快照必须覆盖发出快照前的全部 mutation。
        const coverage = validateSnapshotCoverage(record.mutationSeq, mutationSeqRef.current);
        if (!coverage.ok) {
          logSync("快照未覆盖后续写入", {
            reqId: record.reqId,
            snapshotSeq: record.mutationSeq,
            currentSeq: mutationSeqRef.current,
          });
          setNotice(`${coverage.reason}；请再次点击「重新同步工厂」。`);
          return;
        }
        if (!snapshotFactory) {
          setError("工厂快照缺失；写入状态保持不变。");
          return;
        }
        const wasStale = guardRef.current.stale();
        factoryRef.current = snapshotFactory;
        setFactory(snapshotFactory);
        optionsRef.current.onFactoryUpdate?.(snapshotFactory);
        // 只有完整校验 + 屏障覆盖都通过后，才解除 stale。
        guardRef.current.clearStale();
        publishSyncState();
        setStatus("connected");
        setError("");
        setNotice(wasStale ? "已重新同步工厂，写入已恢复。" : "已同步游戏端工厂数据");
        return;
      }

      // 工厂写请求：diff 已通过数组校验；stale 期间只收敛 pending，不应用增量。
      if (payload.value.kind === "diff") {
        if (guardRef.current.stale()) {
          setNotice("工厂状态不可信，已忽略该增量；请重新同步工厂。");
        } else {
          applyIncomingDiff(payload.value.diff);
        }
      }
      return;
    }

    if (message.type === "CcUpdatedFactory") {
      applyIncomingDiff(message.diff);
      return;
    }
    if (message.type === "IdleTimeout") {
      shouldReconnectRef.current = false;
      setStatus("offline");
      setError(`游戏端因空闲关闭会话：${String(message.message || "Idle timeout")}`);
      socket.close();
      return;
    }
    if (message.type === "SessionClose") {
      shouldReconnectRef.current = false;
      setStatus("offline");
      setError("游戏端已主动关闭编辑会话。");
      socket.close();
    }
  }, [applyIncomingDiff, sendRequest, publishSyncState, settlePending]);

  const openSocket = useCallback((generation: number, code: string, isReconnect = false) => {
    if (generation !== generationRef.current || !shouldReconnectRef.current) return;
    // 每条新连接递增代际；旧连接的迟到响应即使混入也不会被匹配。
    epochRef.current += 1;
    setStatus(isReconnect ? "reconnecting" : "connecting");
    setError("");
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpoint);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "无法创建 WebSocket");
      return;
    }
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (socket !== socketRef.current) return;
      setStatus("joining");
      setError("");
      heartbeatTimerRef.current = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (heartbeatDeadlineRef.current !== undefined) {
          socket.close(4008, "Heartbeat timeout");
          return;
        }
        socket.send("ping");
        heartbeatDeadlineRef.current = window.setTimeout(() => {
          socket.close(4008, "Heartbeat timeout");
        }, HEARTBEAT_TIMEOUT_MS);
      }, HEARTBEAT_INTERVAL_MS);
      try {
        sendRequest({ type: "SessionJoin", sessionId: code });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "发送 SessionJoin 失败");
        socket.close();
      }
    });
    socket.addEventListener("message", event => handleMessage(event.data, socket));
    socket.addEventListener("error", () => {
      if (socket === socketRef.current) setError("WebSocket 连接发生错误；将尝试重新连接。");
    });
    socket.addEventListener("close", () => {
      if (socket !== socketRef.current) return;
      stopTimers();
      socketRef.current = null;
      // 断线不解除 stale；只有 pending 写入才会新增 stale。
      guardRef.current.noteConnectionLost();
      clearPending("连接中断，未确认的请求不会自动重发；重新连接后会重新读取工厂快照。");
      if (shouldReconnectRef.current) {
        setStatus("reconnecting");
        reconnectTimerRef.current = window.setTimeout(() => openSocket(generation, code, true), RECONNECT_DELAY_MS);
      } else {
        setStatus("offline");
      }
    });
  }, [endpoint, sendRaw, sendRequest, handleMessage, stopTimers, clearPending]);

  const connect = useCallback((code: string) => {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(normalized)) {
      setError("Session Code 必须是 SIGILS 生成的四位大写英文字母。");
      setStatus("error");
      return;
    }
    if (!/^wss?:\/\//i.test(endpoint)) {
      setError("服务器地址必须以 ws:// 或 wss:// 开头。");
      setStatus("error");
      return;
    }
    if (socketRef.current) socketRef.current.close(1000, "Switch session");
    stopTimers();
    generationRef.current += 1;
    shouldReconnectRef.current = true;
    // 切换会话：旧请求全部失效，不能等 close 事件（可能与新连接竞态）。
    guardRef.current.noteConnectionLost();
    clearPending("已切换会话，上一会话未确认的请求不会重发。");
    sessionCodeRef.current = normalized;
    setSessionCode(normalized);
    factoryRef.current = null;
    setFactory(null);
    setError("");
    setNotice("");
    // Pass the normalized code explicitly; React state updates are asynchronous.
    window.setTimeout(() => openSocket(generationRef.current, normalized), 0);
  }, [endpoint, openSocket, stopTimers, clearPending]);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    generationRef.current += 1;
    sessionCodeRef.current = "";
    stopTimers();
    guardRef.current.noteConnectionLost();
    clearPending("已主动断开连接。");
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Editor disconnected");
    setStatus("offline");
  }, [stopTimers, clearPending]);

  useEffect(() => () => {
    shouldReconnectRef.current = false;
    generationRef.current += 1;
    stopTimers();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Component unmounted");
    for (const pending of pendingRef.current.values()) window.clearTimeout(pending.timer);
    pendingRef.current.clear();
  }, [stopTimers]);

  return {
    status, factory, sessionCode, endpoint, setEndpoint, error, notice,
    pendingCount: sync.pendingCount, stale: sync.stale, staleReason: sync.staleReason,
    mutationPending: sync.mutationPending, syncing,
    connect, disconnect, sendRequest,
  };
}
