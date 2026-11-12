import type { Factory, Group, GroupId, Machine, MachineId, PeriphId, Pipe, PipeId } from "../../factory-model/src/index";

export const FACTORY_UPDATE_REQUEST_TYPES = [
  "PipeAdd", "PipeEdit", "PipeDel", "MachineAdd", "MachineEdit", "MachineDel",
  "GroupAdd", "GroupEdit", "GroupDel", "PeriphAdd", "PeriphDel",
] as const;
export type FactoryUpdateRequestType = typeof FACTORY_UPDATE_REQUEST_TYPES[number];

/** Guards request types before they are written to the wire. */
export function isFactoryUpdateRequestType(value: unknown): value is FactoryUpdateRequestType {
  return typeof value === "string" && (FACTORY_UPDATE_REQUEST_TYPES as readonly string[]).includes(value);
}
export type MessageType =
  | "BatchRequest" | "ConfirmationResponse" | "IdleTimeout"
  | "SessionCreate" | "SessionJoin" | "SessionRejoin" | "SessionClose"
  | "FactoryGet" | "FactoryGetResponse" | "CcUpdatedFactory"
  | FactoryUpdateRequestType;

export interface Message { type: MessageType }
export interface Request extends Message { reqId: string }
/** v4.3 batches only dispatch factory-update handlers; other message types are ignored. */
export interface BatchRequest extends Request { type: "BatchRequest"; requests: FactoryUpdateRequest[] }
export interface ConfirmationResponse extends Message {
  type: "ConfirmationResponse";
  respondingTo: MessageType;
  reqId?: string;
  ok: boolean;
  error?: ErrorType;
  message?: string;
  ccReconnectToken?: string;
}
export interface IdleTimeout extends Message { type: "IdleTimeout"; message: string }
export interface SessionCreateRequest extends Request { type: "SessionCreate"; sessionId: string }
export interface SessionJoinRequest extends Request { type: "SessionJoin"; sessionId: string }
export interface SessionRejoinRequest extends Request { type: "SessionRejoin"; sessionId: string; ccReconnectToken: string }
export interface SessionCloseRequest extends Request { type: "SessionClose" }
export interface FactoryGetRequest extends Request { type: "FactoryGet" }
export interface FactoryGetResponse extends ConfirmationResponse {
  type: "ConfirmationResponse"; respondingTo: "FactoryGet"; reqId: string; ok: true; factory: Factory;
}
export interface FactoryUpdateResponse extends ConfirmationResponse {
  type: "ConfirmationResponse";
  respondingTo: FactoryUpdateRequestType;
  reqId: string;
  ok: true;
  diff: unknown[];
}
export interface CcUpdatedFactory extends Message { type: "CcUpdatedFactory"; diff: unknown[] }

export interface PipeAddRequest extends Request { type: "PipeAdd"; pipe: Pipe }
export interface PipeEditRequest extends Request { type: "PipeEdit"; pipeId: PipeId; edits: Partial<Pipe> }
export interface PipeDelRequest extends Request { type: "PipeDel"; pipeId: PipeId }
export interface MachineAddRequest extends Request { type: "MachineAdd"; machine: Machine }
export interface MachineEditRequest extends Request { type: "MachineEdit"; machineId: MachineId; edits: Partial<Machine> }
export interface MachineDelRequest extends Request { type: "MachineDel"; machineId: MachineId }
export interface GroupAddRequest extends Request { type: "GroupAdd"; group: Group; machineId: MachineId }
export interface GroupEditRequest extends Request { type: "GroupEdit"; groupId: GroupId; edits: Partial<Group> }
export interface GroupDelRequest extends Request { type: "GroupDel"; groupId: GroupId }
export interface PeriphAddRequest extends Request { type: "PeriphAdd"; periphId: PeriphId; options?: Partial<Machine> }
export interface PeriphDelRequest extends Request { type: "PeriphDel"; periphId: PeriphId }

export type ErrorType = "UnknownError" | "PeerNotConnected" | "SessionIdNotExist" | "SessionHasEditor" | "SessionIdTaken" | "BadReconnectToken";
export type FactoryUpdateRequest =
  | PipeAddRequest | PipeEditRequest | PipeDelRequest
  | MachineAddRequest | MachineEditRequest | MachineDelRequest
  | GroupAddRequest | GroupEditRequest | GroupDelRequest
  | PeriphAddRequest | PeriphDelRequest;
export type EditorRequest = BatchRequest | SessionJoinRequest | SessionCloseRequest | FactoryGetRequest | FactoryUpdateRequest;

/** Runtime guard for the common message envelope. Detailed payload validation follows by type. */
export function isMessageEnvelope(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === "string";
}

export function hasRequestId(value: unknown): value is { type: string; reqId: string } {
  return isMessageEnvelope(value) && typeof (value as Record<string, unknown>).reqId === "string";
}
