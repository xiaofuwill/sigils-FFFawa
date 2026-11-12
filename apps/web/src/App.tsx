import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "reactflow";
import { validateFactoryReferences, validateFactoryShape, type Factory } from "../../../packages/factory-model/src/index";
import { FILTER_EXAMPLES } from "../../../packages/filter-syntax/src/index";
import { factoryToFlow, groupDisplayName, periphColor, slotChipLabel, SLOT_SIZE, type GroupNodeData, type MachineNodeData } from "./factoryToFlow";
import { sampleFactory } from "./sampleFactory";
import { useSigilsConnection } from "./websocket/useSigilsConnection";
import {
  buildGroupDelete, buildMachineDelete, buildNicknameEdit,
  buildPeripheralAdd, buildPeripheralDelete, buildPipeDeleteBatch, canConnectGroups,
} from "./factoryActions";
import {
  buildGroupSplit, canMergeGroups, buildGroupMerge,
  findGroupOwner, findReleasedPeriphs, getFactoryPeriphIds, slotKey,
} from "./groupActions";

function MachineNode({ data }: { data: MachineNodeData }) {
  return <div className={`machine-node${data.missing ? " is-missing" : ""}`}>
    <div className="machine-title" title={data.label}>{data.label}</div>
    {data.nickname && <div className="machine-meta">别名 · {data.nickname}</div>}
    <div className="machine-meta">外设机器 · {data.groupCount} 个容器</div>
    {data.missing && <div className="node-missing">外设缺失</div>}
  </div>;
}
function GroupNode({ id, data }: NodeProps<GroupNodeData>) {
  return <div className={`group-node${data.fluid ? " is-fluid" : ""}${data.missing ? " is-missing" : ""}${data.dropTarget ? " is-drop-target" : ""}`}>
    <Handle type="target" position={Position.Left} />
    <div className="group-head">
      <span className="group-title" title={data.label}>{data.label}</span>
      <button className="group-fold nodrag" onClick={event => { event.stopPropagation(); data.onToggle?.(); }} title={data.collapsed ? "展开槽位" : "收起槽位"}>
        {data.collapsed ? "▸" : "▾"}
      </button>
    </div>
    {data.dropTarget && <div className="drop-hint">松开以合并到此容器</div>}
    {data.collapsed
      ? <div className="group-meta">{data.fluid ? "液体" : "物品"} · {data.slots.length} 个槽位</div>
      : data.slots.length
        ? <div
          className="group-slots"
          style={{ gridTemplateColumns: `repeat(${Math.min(9, Math.max(1, data.slots.length))}, ${SLOT_SIZE}px)` }}
        >{data.slots.map((slot, index) => (
          <span
            key={`${slot.periphId}#${slot.slot ?? "fluid"}-${index}`}
            className={`group-slot${data.canDragSlots ? " slot-draggable nodrag" : ""}`}
            style={{ backgroundColor: periphColor(slot.periphId) }}
            title={`${slot.periphId} #${slotChipLabel(slot, index)}${data.canDragSlots ? "（拖到机器框空白处可拆成新容器）" : ""}`}
            draggable={data.canDragSlots === true}
            onDragStart={data.canDragSlots
              ? event => {
                event.stopPropagation();
                event.dataTransfer.setData("application/sigils-slot", JSON.stringify({
                  machineId: data.machineId,
                  groupId: id,
                  slot: { periphId: slot.periphId, slot: slot.slot },
                }));
                event.dataTransfer.effectAllowed = "move";
              }
              : undefined}
          >
            {slotChipLabel(slot, index)}
          </span>
        ))}</div>
        : <div className="group-meta">无槽位</div>}
    {data.missing && <div className="node-missing">外设缺失</div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { machine: MachineNode, group: GroupNode };
/** Custom MIME type so slot drags cannot be confused with browser file drags. */
const SLOT_DRAG_TYPE = "application/sigils-slot";

const statusLabels: Record<string, string> = {
  offline: "离线画布", connecting: "正在连接…", joining: "正在加入会话…",
  loading: "正在载入工厂数据…", connected: "在线 · 已连接", reconnecting: "正在重连…", error: "连接出错",
};

function Editor() {
  const [localFactory, setLocalFactory] = useState<Factory>(sampleFactory);
  const [jsonError, setJsonError] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [selectedPipeId, setSelectedPipeId] = useState("");
  const [edgeFilter, setEdgeFilter] = useState("");
  const [pipeNicknameDraft, setPipeNicknameDraft] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [groupMachineId, setGroupMachineId] = useState("");
  const [groupSourceId, setGroupSourceId] = useState("");
  const [groupNicknameDraft, setGroupNicknameDraft] = useState("");
  const [groupSlotKeys, setGroupSlotKeys] = useState<string[]>([]);
  const [showPanels, setShowPanels] = useState(() => window.innerWidth >= 1100);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  /** Peripherals freed by deleting a container; offered again in 可用外设. */
  const [releasedPeriphs, setReleasedPeriphs] = useState<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const knownPeriphsRef = useRef<Set<string>>(new Set());
  const connection = useSigilsConnection();
  const { getIntersectingNodes, screenToFlowPosition } = useReactFlow();
  const activeFactory = connection.factory ?? localFactory;
  const isLive = connection.status === "connected";
  // 已经有一个写入在等待确认，或工厂状态不可信时，一律不允许再写。
  const waiting = connection.mutationPending;
  const canWrite = isLive && !connection.mutationPending && !connection.stale;
  // 快照请求是只读的，即使进入 error / stale 也要允许用户主动重新同步。
  const canResync = ["connected", "error", "loading"].includes(connection.status);
  const flow = useMemo(() => factoryToFlow(activeFactory, {
    collapsedGroups: new Set(collapsedGroups),
    onToggleGroup: groupId => setCollapsedGroups(previous => previous.includes(groupId) ? previous.filter(id => id !== groupId) : [...previous, groupId]),
    dropTargetId,
    canWrite,
  }), [activeFactory, collapsedGroups, dropTargetId, canWrite]);
  const [nodes, setNodes] = useState<Node[]>(flow.nodes);
  const [edges, setEdges] = useState<Edge[]>(flow.edges);

  const selectedPipe = selectedPipeId ? activeFactory.pipes[selectedPipeId] : undefined;
  const selectedNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : "";
  const selectedMachine = selectedNodeId ? activeFactory.machines[selectedNodeId] : undefined;
  const selectedGroup = selectedNodeId ? activeFactory.groups[selectedNodeId] : undefined;
  const selectedNodeKind = selectedMachine ? "machine" : selectedGroup ? "group" : undefined;
  const selectedNodeLabel = selectedMachine
    ? selectedMachine.id
    : selectedGroup ? groupDisplayName(selectedGroup) : "";
  const selectedMachinePeriphs = selectedMachine
    ? [...new Set(selectedMachine.groups.flatMap(groupId => activeFactory.groups[groupId]?.slots.map(slot => slot.periphId) ?? []))]
    : [];

  // React Flow nodes are rebuilt whenever the Factory changes, which drops the
  // selection flags. Keep the local drag positions and re-apply the selection so
  // the inspector panel survives well after the mouse button is released.
  useEffect(() => {
    setNodes(current => {
      const positions = new Map(current.map(node => [node.id, node.position]));
      return flow.nodes.map(node => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
        selected: node.id === selectedNodeId,
      }));
    });
    setEdges(flow.edges.map(edge => ({ ...edge, selected: edge.id === selectedPipeId })));
    if (selectedPipeId && !activeFactory.pipes[selectedPipeId]) setSelectedPipeId("");
  }, [flow, activeFactory, selectedNodeId, selectedPipeId]);

  useEffect(() => {
    setNicknameDraft(selectedMachine?.nickname ?? selectedGroup?.nickname ?? "");
  }, [selectedNodeId, selectedMachine?.nickname, selectedGroup?.nickname]);

  const createMachine = groupMachineId ? activeFactory.machines[groupMachineId] : undefined;
  const createSource = groupSourceId ? activeFactory.groups[groupSourceId] : undefined;
  // The Factory snapshot carries no inventory capacity, so only slots that an
  // existing group already references can be confirmed. There is deliberately no
  // "unassigned slots" source until CC exposes a capacity API.
  const createCandidates = createSource ? createSource.slots : [];

  /**
   * Peripherals referenced by a container that no longer exists are offered
   * again in 可用外设. The detection runs on authoritative Factory updates only,
   * so a rejected delete never releases anything.
   */
  useEffect(() => {
    if (!isLive) {
      knownPeriphsRef.current = new Set();
      setReleasedPeriphs([]);
      return;
    }
    const current = getFactoryPeriphIds(activeFactory);
    const released = findReleasedPeriphs(knownPeriphsRef.current, activeFactory);
    knownPeriphsRef.current = current;
    setReleasedPeriphs(previous => [
      ...new Set([...previous.filter(periphId => !current.has(periphId)), ...released]),
    ]);
  }, [activeFactory, isLive, connection.sessionCode]);

  const availablePeriphs = useMemo(() => {
    const represented = getFactoryPeriphIds(activeFactory);
    const ids = new Set<string>([...Object.keys(activeFactory.available), ...releasedPeriphs]);
    return [...ids].filter(periphId => !represented.has(periphId) && !activeFactory.missing[periphId]);
  }, [activeFactory, releasedPeriphs]);

  function toggleKey(key: string, current: string[], update: (next: string[]) => void) {
    update(current.includes(key) ? current.filter(value => value !== key) : [...current, key]);
  }

  function splitGroup() {
    if (!canWrite || !createSource) return;
    const slots = createCandidates.filter(slot => groupSlotKeys.includes(slotKey(slot)));
    try {
      connection.sendRequest(buildGroupSplit(activeFactory, createSource.id, slots, groupNicknameDraft));
      setGroupSlotKeys([]);
      setGroupNicknameDraft("");
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "拆分分组失败");
    }
  }

  function resyncFactory() {
    if (!canResync || connection.syncing) return;
    try {
      connection.sendRequest({ type: "FactoryGet" });
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "重新同步失败");
    }
  }

  function saveSelectedNickname() {
    if (!canWrite || !selectedNodeKind || !selectedNodeId) return;
    try {
      connection.sendRequest(buildNicknameEdit(activeFactory, selectedNodeKind, selectedNodeId, nicknameDraft.trim()));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "名称更新失败");
    }
  }

  function pipesTouching(groupIds: string[]): number {
    const ids = new Set(groupIds);
    return Object.values(activeFactory.pipes).filter(pipe => ids.has(pipe.from) || ids.has(pipe.to)).length;
  }

  function deleteSelectedNode() {
    if (!canWrite || !selectedNodeKind || !selectedNodeId) return;
    const label = selectedNodeLabel || selectedNodeId;
    const removedGroups = selectedNodeKind === "machine"
      ? (activeFactory.machines[selectedNodeId]?.groups ?? [])
      : [selectedNodeId];
    const machineId = selectedNodeKind === "machine" ? selectedNodeId : findGroupOwner(activeFactory, selectedNodeId) ?? "";

    let prompt: string;
    if (selectedNodeKind === "machine") {
      prompt = `删除机器「${label}」：会级联删除 ${removedGroups.length} 个容器、${pipesTouching(removedGroups)} 条关联管道。删除后不再被其他容器使用的外设会回到「可用外设」区。继续？`;
    } else {
      const owner = machineId ? activeFactory.machines[machineId] : undefined;
      const removesMachine = owner ? owner.groups.length === 1 : false;
      prompt = `删除容器「${label}」：会级联删除 ${pipesTouching([selectedNodeId])} 条关联管道${removesMachine ? `，并删除机器「${owner?.nickname || owner?.id}」` : ""}。删除后不再被其他容器使用的外设会回到「可用外设」区。继续？`;
    }

    if (!window.confirm(prompt)) return;
    try {
      const request = selectedNodeKind === "machine"
        ? buildMachineDelete(activeFactory, selectedNodeId)
        : buildGroupDelete(selectedNodeId);
      connection.sendRequest(request);
      setSelectedNodeIds([]);
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "删除请求失败");
    }
  }

  function addAvailablePeripheral(periphId: string, index: number) {
    if (!canWrite) return;
    try {
      connection.sendRequest(buildPeripheralAdd(periphId, { x: 40 + (index % 3) * 60, y: 80 + Math.floor(index / 3) * 60 }));
      setReleasedPeriphs(previous => previous.filter(id => id !== periphId));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "添加外设失败");
    }
  }

  function removeMissingPeripheral(periphId: string) {
    if (!canWrite) return;
    const affected = Object.values(activeFactory.groups).filter(group => group.slots.some(slot => slot.periphId === periphId));
    const slotCount = affected.reduce((total, group) => total + group.slots.filter(slot => slot.periphId === periphId).length, 0);
    const emptied = affected.filter(group => group.slots.every(slot => slot.periphId === periphId)).map(group => group.id);
    const prompt = `移除外设「${periphId}」：会清除 ${slotCount} 个槽位${emptied.length ? `，并删除 ${emptied.length} 个分组、${pipesTouching(emptied)} 条关联管道` : ""}。继续？`;
    if (!window.confirm(prompt)) return;
    try {
      connection.sendRequest(buildPeripheralDelete(periphId));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "移除外设失败");
    }
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(activeFactory, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "factory.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importConfig(file?: File) {
    if (!file) return;
    if (isLive) { setJsonError("实时连接期间禁止本地导入覆盖画布；请先断开连接。"); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
      const shapeIssues = validateFactoryShape(parsed);
      if (shapeIssues.length) throw new Error(shapeIssues.slice(0, 3).map(issue => `${issue.path}: ${issue.message}`).join("; "));
      const candidate = parsed as Factory;
      const referenceIssues = validateFactoryReferences(candidate);
      if (referenceIssues.length) throw new Error(referenceIssues.slice(0, 3).map(issue => `${issue.path}: ${issue.message}`).join("; "));
      setLocalFactory(candidate);
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "Invalid factory JSON");
    }
  }

  function connectNodes(connectionLine: Connection) {
    if (!canWrite || !connectionLine.source || !connectionLine.target) return;
    if (!activeFactory.groups[connectionLine.source] || !activeFactory.groups[connectionLine.target]) {
      setJsonError("Pipe 只能连接两个 Group，不能连接 Machine。");
      return;
    }
    if (!canConnectGroups(activeFactory, connectionLine.source, connectionLine.target)) {
      setJsonError("不能连接 Item Group 与 Fluid Group；两端类型必须一致。");
      return;
    }
    try {
      connection.sendRequest({
        type: "PipeAdd",
        pipe: { id: crypto.randomUUID(), from: connectionLine.source, to: connectionLine.target, filter: "" },
      });
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "PipeAdd 发送失败");
    }
  }

  function deleteEdges(deleted: Edge[]) {
    if (!canWrite || deleted.length === 0) return;
    try {
      connection.sendRequest(buildPipeDeleteBatch(deleted.map(edge => edge.id)));
      if (selectedPipeId && deleted.some(edge => edge.id === selectedPipeId)) {
        setSelectedPipeId("");
        setEdgeFilter("");
        setPipeNicknameDraft("");
      }
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "PipeDel 发送失败");
    }
  }

  function persistNodePosition(node: Node) {
    if (!canWrite) return;
    try {
      if (node.type === "machine") {
        connection.sendRequest({ type: "MachineEdit", machineId: node.id, edits: { x: node.position.x, y: node.position.y } });
      } else if (node.type === "group") {
        connection.sendRequest({ type: "GroupEdit", groupId: node.id, edits: { x: node.position.x, y: node.position.y } });
      }
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "位置更新发送失败");
    }
  }

  /**
   * Container merge follows the upstream editor: the dragged object is the whole
   * container frame, and the source frame is deleted after its slots move into
   * the target frame. Both edits travel in one BatchRequest.
   */
  function mergeContainerInto(sourceId: string, targetId: string): boolean {
    if (!canWrite) return false;
    const check = canMergeGroups(activeFactory, sourceId, targetId);
    if (!check.ok) {
      setJsonError(check.reason);
      return false;
    }
    const source = activeFactory.groups[sourceId];
    const target = activeFactory.groups[targetId];
    if (!source || !target) return false;
    const pipeCount = Object.values(activeFactory.pipes)
      .filter(pipe => pipe.from === sourceId || pipe.to === sourceId).length;
    const prompt = `将容器「${groupDisplayName(source)}」合并到「${groupDisplayName(target)}」：${source.slots.length} 个槽位会并入目标容器，源容器会被删除${pipeCount ? `，其关联的 ${pipeCount} 条管道也会被删除` : ""}。继续？`;
    if (!window.confirm(prompt)) return false;
    try {
      connection.sendRequest(buildGroupMerge(activeFactory, sourceId, targetId));
      setJsonError("");
      return true;
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "容器合并失败");
      return false;
    }
  }

  function handleNodeDrag(event: ReactMouseEvent, node: Node) {
    if (!canWrite || node.type !== "group") {
      if (dropTargetId) setDropTargetId(null);
      return;
    }
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const hits = getIntersectingNodes({ x: point.x, y: point.y, width: 1, height: 1 });
    const target = hits.find(candidate =>
      candidate.type === "group"
      && candidate.id !== node.id
      && canMergeGroups(activeFactory, node.id, candidate.id).ok);
    setDropTargetId(target?.id ?? null);
  }

  function handleNodeDragStop(_: ReactMouseEvent, node: Node) {
    const targetId = dropTargetId;
    setDropTargetId(null);
    if (node.type === "group" && targetId && node.id !== targetId && mergeContainerInto(node.id, targetId)) return;
    persistNodePosition(node);
  }

  /**
   * Slot drag follows the upstream editor: dropping a slot onto its own machine
   * frame splits that single slot into a new container of the same machine.
   * Dropping outside that machine frame is rejected before anything is sent.
   */
  function handleSlotDrop(event: ReactDragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData(SLOT_DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    if (!canWrite) return;

    let payload: { machineId?: unknown; groupId?: unknown; slot?: { periphId?: unknown; slot?: unknown } };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      setJsonError("槽位拖动数据无效。");
      return;
    }
    const { machineId, groupId, slot } = payload;
    if (typeof machineId !== "string" || typeof groupId !== "string" || !slot) return;
    if (typeof slot.periphId !== "string" || typeof slot.slot !== "number") {
      setJsonError("槽位拖动数据无效。");
      return;
    }

    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const hits = getIntersectingNodes({ x: point.x, y: point.y, width: 1, height: 1 });
    const machineNode = hits.find(node => node.type === "machine" && node.id === machineId);
    if (!machineNode) {
      setJsonError("槽位只能拖回同一个机器框内，不能跨机器移动。");
      return;
    }

    const source = activeFactory.groups[groupId];
    const position = {
      x: Math.max(8, point.x - machineNode.position.x),
      y: Math.max(8, point.y - machineNode.position.y),
    };
    try {
      connection.sendRequest(buildGroupSplit(
        activeFactory,
        groupId,
        [{ periphId: slot.periphId, slot: slot.slot }],
        source?.nickname,
        undefined,
        position,
      ));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "槽位拖动失败");
    }
  }

  function handleCanvasDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes(SLOT_DRAG_TYPE)) event.preventDefault();
  }

  function saveSelectedPipeFilter() {
    if (!canWrite || !selectedPipe) return;
    try {
      connection.sendRequest({
        type: "PipeEdit",
        pipeId: selectedPipe.id,
        edits: { nickname: pipeNicknameDraft.trim(), filter: edgeFilter },
      });
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "PipeEdit 发送失败");
    }
  }

  function deleteSelectedPipe() {
    if (!canWrite || !selectedPipe) return;
    try {
      connection.sendRequest({ type: "PipeDel", pipeId: selectedPipe.id });
      setSelectedPipeId("");
      setEdgeFilter("");
      setPipeNicknameDraft("");
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "PipeDel 发送失败");
    }
  }

  const busy = ["connecting", "joining", "loading", "reconnecting"].includes(connection.status);

  return <div className="canvas-app">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange[]) => setNodes(current => applyNodeChanges(changes, current))}
      onConnect={connectNodes}
      onEdgesDelete={deleteEdges}
      onNodeDrag={handleNodeDrag}
      onNodeDragStop={handleNodeDragStop}
      onDrop={handleSlotDrop}
      onDragOver={handleCanvasDragOver}
      onNodeClick={(_, node) => { setSelectedNodeIds([node.id]); setSelectedPipeId(""); }}
      onEdgeClick={(_, edge) => { setSelectedPipeId(edge.id); setSelectedNodeIds([]); setEdgeFilter(activeFactory.pipes[edge.id]?.filter ?? ""); setPipeNicknameDraft(activeFactory.pipes[edge.id]?.nickname ?? ""); }}
      onPaneClick={() => { setSelectedNodeIds([]); setSelectedPipeId(""); }}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      nodesDraggable={!isLive || canWrite}
      nodesConnectable={canWrite}
      edgesUpdatable={false}
      deleteKeyCode={canWrite ? ["Delete", "Backspace"] : null}
    >
      <Background gap={22} size={1} />
      <MiniMap pannable zoomable />
      <Controls />

      <Panel position="top-left" className="float-panel">
        {showPanels && <div className="float-col">
          <section className="float-card">
            <div className="brand">SIGILS <span>独立编辑器</span></div>
            <div className="status-row"><span className={`status-dot ${isLive ? "online" : ""}`} />{statusLabels[connection.status]}</div>
            <label className="field-label">服务端地址</label>
            <input className="filter-input" value={connection.endpoint} onChange={e => connection.setEndpoint(e.target.value)} disabled={connection.status !== "offline" && connection.status !== "error"} spellCheck={false} />
            <label className="field-label">会话码</label>
            <div className="connect-row">
              <input className="filter-input session-input" value={sessionInput} onChange={e => setSessionInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))} placeholder="ABCD" maxLength={4} disabled={isLive || busy} />
              <button onClick={() => connection.connect(sessionInput)} disabled={isLive || busy || sessionInput.length !== 4}>连接</button>
            </div>
            {(isLive || busy) && <button className="wide-button secondary-button" onClick={connection.disconnect}>断开连接</button>}
            {canResync && <button className="wide-button secondary-button" onClick={resyncFactory} disabled={connection.syncing}>{connection.syncing ? "正在同步工厂…" : "重新同步工厂"}</button>}
            {connection.error && <p className="error">{connection.error}</p>}
            {connection.notice && <p className="notice">{connection.notice}</p>}
            <div className="top-actions">
              <label className="file-button">导入<input type="file" accept="application/json,.json" disabled={isLive} onChange={e => void importConfig(e.target.files?.[0])} /></label>
              <button onClick={exportConfig}>导出</button>
            </div>
            <p className="muted">游戏端按 E 生成四位会话码；断开或重启后浏览器会自动重连并重新拉取快照。</p>
          </section>

          <details className="float-card" open>
            <summary>缺失外设</summary>
            {Object.keys(activeFactory.missing).length ? <div className="peripheral-list">{Object.keys(activeFactory.missing).map(periphId => <div className="peripheral-row" key={periphId}><code>{periphId}</code><button className="danger-button" onClick={() => removeMissingPeripheral(periphId)} disabled={!canWrite}>移除</button></div>)}</div> : <p className="muted">没有缺失外设。</p>}
          </details>

          <details className="float-card">
            <summary>可用外设</summary>
            {availablePeriphs.length ? <div className="peripheral-list">{availablePeriphs.map((periphId, index) => <div className="peripheral-row" key={periphId}><code>{periphId}</code>{releasedPeriphs.includes(periphId) && !activeFactory.available[periphId] && <span className="muted">已释放</span>}<button onClick={() => addAvailablePeripheral(periphId, index)} disabled={!canWrite}>添加为机器</button></div>)}</div> : <p className="muted">没有可添加的外设。</p>}
            <p className="muted">删除容器后，不再被其他容器使用的外设会回到这里；重新添加会按外设重建默认容器。</p>
          </details>
        </div>}
      </Panel>

      <Panel position="top-right" className="float-panel">
        {showPanels && <div className="float-col">
          <details className="float-card" open>
            <summary>检视面板</summary>
            {selectedNodeKind && selectedNodeId ? <>
              <div className="muted">{selectedNodeKind === "machine" ? "机器" : "容器"} · {selectedNodeId}</div>
              {selectedNodeKind === "machine" && <>
                <label className="field-label">外设 ID</label>
                <div className="periph-id-list">
                  {selectedMachinePeriphs.length
                    ? selectedMachinePeriphs.map(periphId => <code key={periphId}>{periphId}</code>)
                    : <span className="muted">没有槽位引用外设</span>}
                </div>
                <p className="muted">外设 ID 由游戏端的外设引用关系决定；当前 v4.3 协议没有安全改写能力，改名只影响显示昵称。</p>
              </>}
              <label className="field-label">昵称</label>
              <input className="filter-input" value={nicknameDraft} onChange={e => setNicknameDraft(e.target.value)} disabled={!isLive} placeholder="留空则显示 ID" />
              <button className="wide-button" onClick={saveSelectedNickname} disabled={!canWrite || nicknameDraft.trim() === (selectedMachine?.nickname ?? selectedGroup?.nickname ?? "")}>保存昵称</button>
              <button className="wide-button danger-button" onClick={deleteSelectedNode} disabled={!canWrite}>删除{selectedNodeKind === "machine" ? "机器" : "容器"}</button>
              {selectedNodeKind === "group" && <p className="muted">拖动整个容器到同机器的另一个容器可合并；拖动单个槽位到机器框空白处可拆出新容器。</p>}
            </> : selectedPipe ? <>
              <div className="muted">管道 · {selectedPipe.from} → {selectedPipe.to}</div>
              <label className="field-label">管道名称</label>
              <input className="filter-input" value={pipeNicknameDraft} onChange={e => setPipeNicknameDraft(e.target.value)} disabled={!isLive} placeholder="可选，例如 主输入" />
              <label className="field-label">物品过滤表达式</label>
              <input className="filter-input" value={edgeFilter} onChange={e => setEdgeFilter(e.target.value)} disabled={!isLive} placeholder="例如 #warehouse" />
              <button className="wide-button" onClick={saveSelectedPipeFilter} disabled={!canWrite}>保存管道设置</button>
              <button className="wide-button danger-button" onClick={deleteSelectedPipe} disabled={!canWrite}>删除管道</button>
              <div className="examples">{FILTER_EXAMPLES.slice(0, 3).map(item => <button className="example" key={item.expression} onClick={() => setEdgeFilter(item.expression)}><code>{item.expression}</code><span>{item.meaning}</span></button>)}</div>
            </> : <p className="muted">点击画布中的机器、容器或管道即可编辑；选中会一直保留，不需要按住鼠标。</p>}
            {jsonError && <p className="error">{jsonError}</p>}
            {waiting && <p className="notice">等待游戏端确认；确认前不会再次发送写请求。</p>}
          </details>

          <details className="float-card">
            <summary>拆分分组</summary>
            <label className="field-label">机器</label>
            <select className="filter-input" value={groupMachineId} onChange={e => { setGroupMachineId(e.target.value); setGroupSourceId(""); setGroupSlotKeys([]); }}>
              <option value="">选择机器</option>
              {Object.values(activeFactory.machines).map(machine => <option key={machine.id} value={machine.id}>{machine.nickname || machine.id}</option>)}
            </select>
            {createMachine && <>
              <label className="field-label">来源分组</label>
              <select className="filter-input" value={groupSourceId} onChange={e => { setGroupSourceId(e.target.value); setGroupSlotKeys([]); }}>
                <option value="">选择来源分组</option>
                {createMachine.groups.map(id => <option key={id} value={id}>{activeFactory.groups[id] ? groupDisplayName(activeFactory.groups[id]) : id}</option>)}
              </select>
              {createSource && <>
                <div className="peripheral-list">{createCandidates.map(slot => {
                  const key = slotKey(slot);
                  return <label className="peripheral-row" key={key}>
                    <input type="checkbox" checked={groupSlotKeys.includes(key)} onChange={() => toggleKey(key, groupSlotKeys, setGroupSlotKeys)} />
                    <code>{key}</code>
                  </label>;
                })}</div>
                <label className="field-label">昵称</label>
                <input className="filter-input" value={groupNicknameDraft} onChange={e => setGroupNicknameDraft(e.target.value)} placeholder="可选" />
                <button className="wide-button" onClick={splitGroup} disabled={!canWrite || groupSlotKeys.length === 0}>拆分分组</button>
              </>}
            </>}
            <p className="muted">游戏端快照不含库存总容量，无法确认「未分配槽位」；只能从现有分组拆出。源分组必须至少保留一个槽位。拆分需要在线会话。</p>
          </details>
        </div>}
      </Panel>

      <Panel position="bottom-left" className="float-footer">
        <span>{connection.stale ? "数据不可信 · 写入已冻结，请重新同步工厂" : isLive ? "在线 · 修改需游戏端确认后才会显示" : "离线画布 · 输入会话码后编辑游戏端工厂"}</span>
        <b>{Object.keys(activeFactory.machines).length}</b> 个机器
        <b>{Object.keys(activeFactory.groups).length}</b> 个容器
        <b>{Object.keys(activeFactory.pipes).length}</b> 条管道
        <button className="panel-toggle" onClick={() => setShowPanels(value => !value)}>{showPanels ? "隐藏面板" : "显示面板"}</button>
      </Panel>

      {connection.stale && <Panel position="top-center" className="status-banner stale-banner">
        <span className="stale-title">工厂状态不可信</span>
        <span>{connection.staleReason || "本地数据可能与游戏端不一致"}；已冻结全部写入，请重新同步完整快照。</span>
        <button className="stale-resync" onClick={resyncFactory} disabled={!canResync || connection.syncing}>{connection.syncing ? "正在同步…" : "重新同步工厂"}</button>
      </Panel>}

      {!connection.stale && connection.status !== "connected" && connection.status !== "offline" && <Panel position="top-center" className="status-banner">
        <span className={`status-dot ${isLive ? "online" : ""}`} />
        {statusLabels[connection.status]}
        {connection.error ? ` — ${connection.error}` : ""}
      </Panel>}
    </ReactFlow>
  </div>;
}

export default function App() { return <ReactFlowProvider><Editor /></ReactFlowProvider>; }
