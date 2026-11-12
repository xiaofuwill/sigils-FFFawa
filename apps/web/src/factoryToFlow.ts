import type { Edge, Node } from "reactflow";
import type { Factory, Group, Slot } from "../../../packages/factory-model/src/index";

/** Slot chip geometry; mirrors the upstream editor's 9-column slot grid. */
export const SLOT_SIZE = 26;
export const SLOT_GAP = 2;
export const NODE_PADDING = 8;
export const HEADER_HEIGHT = 24;
/** Header + summary line + padding + border, measured from the rendered card. */
export const COLLAPSED_HEIGHT = 48;
export const MAX_COLUMNS = 9;

/** Default nicknames assigned by CC, shown with Chinese labels in the editor. */
const GROUP_LABEL_OVERRIDES: Record<string, string> = {
  inventory: "物品槽",
  "fluid tank": "液体槽",
};

/** Container title for display only; the stored nickname is never rewritten. */
export function groupDisplayName(group: Group): string {
  const nickname = group.nickname?.trim();
  if (!nickname) return group.id;
  return GROUP_LABEL_OVERRIDES[nickname.toLowerCase()] ?? nickname;
}

/** Slot chips use numbers for item and fluid containers alike. */
export function slotChipLabel(slot: { slot?: number }, index: number): string {
  return String(slot.slot ?? index + 1);
}

export interface GroupNodeData {
  label: string;
  fluid: boolean;
  slots: Slot[];
  collapsed: boolean;
  missing: boolean;
  /** Owning machine, needed by the slot-drag payload. */
  machineId?: string;
  /** Slot chips are draggable only while a write is allowed. */
  canDragSlots?: boolean;
  /** Highlighted while a compatible container is dragged over this one. */
  dropTarget?: boolean;
  onToggle?: () => void;
}

export interface MachineNodeData {
  /** Raw peripheral ID; renaming the machine nickname never changes this. */
  label: string;
  nickname?: string;
  groupCount: number;
  missing: boolean;
}

export interface FlowOptions {
  collapsedGroups?: ReadonlySet<string>;
  onToggleGroup?: (groupId: string) => void;
  /** Container currently highlighted as a merge target. */
  dropTargetId?: string | null;
  /** Whether slot chips may start a drag. */
  canWrite?: boolean;
}

export function slotGridSize(slotCount: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(MAX_COLUMNS, slotCount));
  return { columns, rows: Math.max(1, Math.ceil(slotCount / MAX_COLUMNS)) };
}

/** Card size for a group node; a collapsed node only keeps its header. */
export function groupNodeSize(slotCount: number, collapsed: boolean): { width: number; height: number } {
  const { columns, rows } = slotGridSize(Math.max(1, slotCount));
  const width = columns * SLOT_SIZE + (columns - 1) * SLOT_GAP + NODE_PADDING * 2;
  const height = collapsed
    ? COLLAPSED_HEIGHT
    : HEADER_HEIGHT + rows * SLOT_SIZE + (rows - 1) * SLOT_GAP + NODE_PADDING * 2 + 6;
  return { width: Math.max(150, width), height };
}

/** Stable HSL colour per peripheral, matching the upstream `stringToColor`. */
export function periphColor(periphId: string): string {
  let hash = 0;
  for (let i = 0; i < periphId.length; i += 1) {
    hash = periphId.charCodeAt(i) + ((hash << 5) - hash);
    hash &= hash;
  }
  return `hsl(${((100 * hash) % 360 + 360) % 360}, 60%, 38%)`;
}

export function factoryToFlow(factory: Factory, options: FlowOptions = {}): { nodes: Node[]; edges: Edge[] } {
  const collapsedGroups = options.collapsedGroups ?? new Set<string>();
  const isMissing = (periphId: string) => factory.missing[periphId] === true;

  const groupMissing = (group: Group) =>
    group.slots.length > 0 && group.slots.every(slot => isMissing(slot.periphId));

  const groupData = (group: Group, machineId?: string): GroupNodeData => {
    const collapsed = collapsedGroups.has(group.id);
    return {
      label: groupDisplayName(group),
      fluid: group.fluid === true,
      slots: group.slots,
      collapsed,
      missing: groupMissing(group),
      ...(machineId ? { machineId } : {}),
      canDragSlots: Boolean(options.canWrite) && Boolean(machineId) && group.fluid !== true && group.slots.length > 1 && !collapsed,
      dropTarget: options.dropTargetId === group.id,
      ...(options.onToggleGroup ? { onToggle: () => options.onToggleGroup?.(group.id) } : {}),
    };
  };

  const machineNodes: Node[] = [];
  const groupNodes: Node[] = [];

  for (const machine of Object.values(factory.machines)) {
    const owned = machine.groups
      .map(groupId => factory.groups[groupId])
      .filter((group): group is Group => Boolean(group));

    let cursorY = 44;
    let rightEdge = 200;
    const periphIds = new Set<string>();

    for (const group of owned) {
      for (const slot of group.slots) periphIds.add(slot.periphId);
      const collapsed = collapsedGroups.has(group.id);
      const size = groupNodeSize(group.slots.length, collapsed);
      const x = group.x ?? 16;
      const y = group.y ?? cursorY;
      cursorY = y + size.height + 12;
      rightEdge = Math.max(rightEdge, x + size.width);

      groupNodes.push({
        id: group.id,
        type: "group",
        parentId: machine.id,
        extent: "parent",
        position: { x, y },
        // React Flow's default node adds padding/border; zero it so the wrapper
        // box is exactly the size used for slot-grid and machine layout maths.
        style: { width: size.width, height: size.height, padding: 0, border: "none", background: "transparent" },
        data: groupData(group, machine.id),
        draggable: true,
        // Deletion must go through the inspector action so CC receives GroupDel.
        deletable: false,
      });
    }

    const missing = periphIds.size > 0 && [...periphIds].every(isMissing);
    machineNodes.push({
      id: machine.id,
      type: "machine",
      position: { x: machine.x ?? 0, y: machine.y ?? 0 },
      style: {
        width: Math.max(240, rightEdge + 16),
        height: Math.max(150, cursorY + 8),
        padding: 0, border: "none", background: "transparent",
        // Let clicks reach Pipes drawn inside the machine frame; the header
        // still receives events via .machine-title / .machine-meta.
        pointerEvents: "none",
      },
      data: {
        label: machine.id,
        ...(machine.nickname ? { nickname: machine.nickname } : {}),
        groupCount: machine.groups.length,
        missing,
      } satisfies MachineNodeData,
      draggable: true,
      // Deletion must go through the inspector action so CC receives the cascade.
      deletable: false,
    });
  }

  // Groups without an owning machine are still rendered so the state stays visible.
  for (const group of Object.values(factory.groups)) {
    if (groupNodes.some(node => node.id === group.id)) continue;
    const collapsed = collapsedGroups.has(group.id);
    const size = groupNodeSize(group.slots.length, collapsed);
    groupNodes.push({
      id: group.id,
      type: "group",
      position: { x: group.x ?? 0, y: group.y ?? 0 },
      style: { width: size.width, height: size.height, padding: 0, border: "none", background: "transparent" },
      data: groupData(group),
      draggable: true,
      deletable: false,
    });
  }

  const edges: Edge[] = Object.values(factory.pipes).map(pipe => ({
    id: pipe.id,
    source: pipe.from,
    target: pipe.to,
    label: pipe.nickname
      ? `${pipe.nickname}${pipe.filter ? ` (${pipe.filter})` : ""}`
      : pipe.filter || pipe.mode || "pipe",
    animated: false,
    style: { strokeWidth: 2 },
  }));

  return { nodes: [...machineNodes, ...groupNodes], edges };
}
