import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export type SessionId = string;
export type PeerRole = "CC" | "editor";

/** v4.3 Utils.randomString(4) emits uppercase ASCII letters only. */
export function isSigilsSessionCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{4}$/.test(value);
}
export interface RelaySession {
  id: SessionId;
  ccReconnectToken: string;
  computerCraft?: WebSocket;
  editor?: WebSocket;
  idleTimer?: ReturnType<typeof setTimeout>;
  outboxTimer?: ReturnType<typeof setTimeout>;
  editorOutbox: Record<string, unknown>[];
}

export interface SessionManagerOptions {
  idleTimeoutMs: number;
  outboxTimeoutMs: number;
  onIdle?: (session: RelaySession) => void;
  onOutboxTimeout?: (session: RelaySession, queued: Record<string, unknown>[]) => void;
}

/** In-memory session registry. The CC computer remains authoritative for Factory data. */
export class SessionManager {
  readonly sessions = new Map<SessionId, RelaySession>();

  constructor(private readonly options: SessionManagerOptions) {}

  create(sessionId: SessionId, computerCraft: WebSocket): RelaySession | undefined {
    if (this.sessions.has(sessionId)) return undefined;
    const session: RelaySession = {
      id: sessionId,
      ccReconnectToken: randomUUID(),
      computerCraft,
      editorOutbox: [],
    };
    this.sessions.set(sessionId, session);
    this.touch(session);
    return session;
  }

  join(sessionId: SessionId, editor: WebSocket): RelaySession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || isOpen(session.editor)) return undefined;
    session.editor = editor;
    this.touch(session);
    return session;
  }

  rejoin(sessionId: SessionId, token: string, computerCraft: WebSocket): RelaySession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.ccReconnectToken !== token) return undefined;
    const previous = session.computerCraft;
    session.computerCraft = computerCraft;
    if (previous && previous !== computerCraft && isOpen(previous)) previous.close(4001, "Replaced by reconnect");
    if (session.outboxTimer) clearTimeout(session.outboxTimer);
    delete session.outboxTimer;
    this.touch(session);
    return session;
  }

  flushOutbox(session: RelaySession): void {
    if (!isOpen(session.computerCraft)) return;
    // FIFO is intentional: dependent BatchRequest/edit operations must retain order.
    while (session.editorOutbox.length > 0) {
      const next = session.editorOutbox[0];
      if (!next || !sendJson(session.computerCraft, next)) break;
      session.editorOutbox.shift();
    }
  }

  queueForComputer(session: RelaySession, message: Record<string, unknown>): void {
    session.editorOutbox.push(message);
    if (session.outboxTimer) return;
    session.outboxTimer = setTimeout(() => {
      delete session.outboxTimer;
      const queued = session.editorOutbox.splice(0);
      this.options.onOutboxTimeout?.(session, queued);
    }, this.options.outboxTimeoutMs);
    session.outboxTimer.unref?.();
  }

  touch(session: RelaySession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.options.onIdle?.(session), this.options.idleTimeoutMs);
    session.idleTimer.unref?.();
  }

  remove(session: RelaySession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.outboxTimer) clearTimeout(session.outboxTimer);
    this.sessions.delete(session.id);
  }
}

export function isOpen(socket: WebSocket | undefined): socket is WebSocket {
  return !!socket && socket.readyState === 1;
}

export function sendJson(socket: WebSocket | undefined, value: unknown): boolean {
  if (!isOpen(socket)) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
