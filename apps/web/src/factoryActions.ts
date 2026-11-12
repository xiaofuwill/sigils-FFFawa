import type { Factory, Group, Machine } from "../../../packages/factory-model/src/index";
import type {
  EditorRequest, GroupDelRequest, GroupEditRequest, MachineEditRequest,
  PeriphAddRequest, PeriphDelRequest,
} from "../../../packages/protocol/src/index";

export type IdFactory = () => string;
const randomId: IdFactory = () => crypto.randomUUID();

export function buildNicknameEdit(factory: Factory, kind: "machine" | "group", id: string, nickname: string, idFactory: IdFactory = randomId): MachineEditRequest | GroupEditRequest {
  const reqId = idFactory();
  if (kind === "machine") {
    if (!factory.machines[id]) throw new Error(`Machine 不存在：${id}`);
    return { type: "MachineEdit", reqId, machineId: id, edits: { nickname } };
  }
  if (!factory.groups[id]) throw new Error(`Group 不存在：${id}`);
  return { type: "GroupEdit", reqId, groupId: id, edits: { nickname } };
}

export function buildGroupDelete(groupId: string, idFactory: IdFactory = randomId): GroupDelRequest {
  return { type: "GroupDel", reqId: idFactory(), groupId };
}

/** GroupDel removes the owning machine when its final group is deleted. */
export function buildMachineDelete(factory: Factory, machineId: string, idFactory: IdFactory = randomId): EditorRequest {
  const machine = factory.machines[machineId];
  if (!machine) throw new Error(`Machine 不存在：${machineId}`);
  if (machine.groups.length === 0) throw new Error("Machine 没有 Group，无法通过兼容的级联删除流程安全删除。");
  const requests = machine.groups.map(groupId => buildGroupDelete(groupId, idFactory));
  const [onlyRequest] = requests;
  if (requests.length === 1 && onlyRequest) return onlyRequest;
  return { type: "BatchRequest", reqId: idFactory(), requests };
}

export function buildPeripheralAdd(periphId: string, position: { x: number; y: number }, idFactory: IdFactory = randomId): PeriphAddRequest {
  return { type: "PeriphAdd", reqId: idFactory(), periphId, options: position };
}

export function buildPeripheralDelete(periphId: string, idFactory: IdFactory = randomId): PeriphDelRequest {
  return { type: "PeriphDel", reqId: idFactory(), periphId };
}

/**
 * 删除一条或多条管道。多条时使用一个 BatchRequest，只占一个 mutation 名额，
 * 与单飞写入门禁兼容；CC 会按顺序执行子请求。
 */
export function buildPipeDeleteBatch(pipeIds: string[], idFactory: IdFactory = randomId): EditorRequest {
  if (!pipeIds.length) throw new Error("至少需要选择一条管道。");
  const [onlyPipeId] = pipeIds;
  if (pipeIds.length === 1 && onlyPipeId) return { type: "PipeDel", reqId: idFactory(), pipeId: onlyPipeId };
  const requests = pipeIds.map(pipeId => ({ type: "PipeDel" as const, reqId: idFactory(), pipeId }));
  return {
    type: "BatchRequest",
    reqId: idFactory(),
    requests,
  };
}

export function canConnectGroups(factory: Factory, sourceId: string, targetId: string): boolean {
  const source: Group | undefined = factory.groups[sourceId];
  const target: Group | undefined = factory.groups[targetId];
  return Boolean(source && target && Boolean(source.fluid) === Boolean(target.fluid));
}

export function getMachine(factory: Factory, id: string): Machine | undefined { return factory.machines[id]; }
