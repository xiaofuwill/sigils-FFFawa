# M6｜I4 外设 ID 修改能力分析与协议提案

**日期：** 2026-11-12
**结论先行：** v4.3 现有协议与数据模型**不支持安全修改 Machine 的外设 ID**。本版只做只读展示与说明，不提供“改名即改 ID”的假功能。若要支持，需要 CC 端新增原子协议，方案见第四节。

---

## 一、现状：外设 ID 不是 Machine 的普通字段

| 事实 | 依据 |
|---|---|
| `Machine.id` 就是外设 ID | `computercraft/sigils/machines/chest.lua`、`generic.lua` 均 `machine.id = periphId` |
| 分组 ID 由外设 ID 派生 | `<periphId>:g1`、`<periphId>:g2`、`<periphId>:fluids` |
| 槽位身份由外设 ID + 槽位号组成 | `Slot { periphId, slot }` |
| Machine 没有单独的外设字段 | `server/src/types/core-types.ts#Machine { id, groups, nickname?, x?, y? }` |
| 外设属于哪台机器通过槽位反推 | `getPeripheralsInMachine`（`client/src/nodes/MachineNode.tsx`）遍历 `group.slots[].periphId` |
| 机器框“机器”字段只编辑昵称 | `client/src/components/MachineOptions.tsx` |

因此“修改外设 ID”实际要同时改动：机器 map key、`machine.id`、该机器全部 Group ID、全部 `Slot.periphId`、所有引用这些 Group 的 Pipe 端点、`missing` / `available` 集合。

## 二、为什么不能用现有 `MachineEdit` 改

`factory.lua#machineEdit` 的行为是：

```lua
for k, v in pairs(edits) do
  diff.machines[machineId][k] = { nil, v }
  machine[k] = v
end
```

它只写对象字段，不会：

- 修改 `factory.machines` 的 key（旧 ID 仍能访问该机器）；
- 更新 `machine.groups` 里由旧外设 ID 派生的分组 ID；
- 更新任何 `slot.periphId`；
- 更新 `pipe.from` / `pipe.to`；
- 更新 `missing` / `available`；
- 校验新 ID 是否存在、是否已被其他机器占用、设备是否在线。

只发送 `MachineEdit { id: newPeriphId }` 会产生 `machines[old].id = new` 的损坏状态，并通过 `validateFactoryReferences` 之外的引用路径把管道指向不存在的分组。**因此本版明确不做这种写入。**

## 三、本版 UI 行为

- 机器检视面板新增只读「外设 ID」区域，列出该机器当前所有槽位引用的 `periphId`。
- 明确提示：外设 ID 由游戏端外设引用关系决定，当前 v4.3 协议没有安全改写能力。
- 原有「昵称」编辑保留，并说明它只影响显示。
- 无外设 ID 冲突 / 离线等错误提示，因为不提供该写入入口。

## 四、协议提案（供 CC 端评估，本版未实现）

### 方案 A（推荐）：新增原子消息 `MachineReassignPeriph`

```jsonc
{
  "type": "MachineReassignPeriph",
  "reqId": "<uuid>",
  "machineId": "minecraft:chest_0",   // 现机器 ID（= 旧外设 ID）
  "newPeriphId": "minecraft:chest_5"  // 目标外设 ID
}
```

CC 端在**同一个处理函数、一次保存**内完成：

1. 校验 `newPeriphId` 已连接、可 wrap、具备相同能力（inventory / tanks），且不属于任何现有 Machine / 不在 `available`；
2. 校验 `machineId` 存在，且其所有 Group 的槽位只引用旧外设 ID；
3. 重写：`machines` key、`machine.id`、每个 Group ID（含 `:gN` / `:fluids`）、每个 `slot.periphId`；
4. 重写所有 `pipe.from` / `pipe.to` 到新 Group ID，并检测冲突；
5. 清理 `missing[oldPeriphId]` / `available[newPeriphId]`；
6. 返回完整 diff（`ConfirmationResponse.ok=true`），失败返回 `ok=false` 且不产生任何部分修改。

失败语义建议：

| 错误 | 含义 |
|---|---|
| `PeriphNotFound` | 新外设不存在 / 未连接 |
| `PeriphAlreadyUsed` | 新外设已属于其他机器或 available |
| `PeriphTypeMismatch` | 新外设能力（槽位数 / 液体）与原机器不兼容 |
| `MachineNotFound` | 旧机器不存在 |

### 方案 B（不推荐）：客户端串行多条消息

用 `MachineAdd` + `GroupAdd...` + `GroupDel...` 拼出“迁移”，问题：

- 多条消息无法保证事务；中途失败会留下两台机器 / 悬空管道；
- 分组 ID、槽位、管道端点需要客户端自行推导，正是本文件第二节列出的全部风险；
- 与“不得用多条无事务请求拼接原子操作”的开发总则冲突。

### 客户端侧后续工作（协议落地后）

1. 增加 `MachineReassignPeriph` 到 protocol 白名单与 `FactorySyncGuard` 分类（mutation）；
2. 构造器校验：新 ID 非空、格式与外设一致、与本机器现有 ID 不同、不在 `machines` / `available` 中；
3. UI：编辑 / 确认 / 取消三态，提交后等待 CC 确认；失败保留原值并提示；
4. 回归：管道引用、槽位身份、重连后全量快照、`missing` / `available` 同步。

## 五、风险与限制

- 本版没有真实 CC 环境验证，以上提案只是基于源码的协议设计，未在游戏中执行。
- 即使协议落地，修改外设 ID 仍会改变分组 ID 与管道端点，属于高破坏性操作，建议在 CC 端提供显式确认或备份点。
- 设备离线 ≠ 不存在：新 ID 不可 wrap 时应区分“未知”（读取失败）与“不存在”，并禁止在未知状态下覆盖。
