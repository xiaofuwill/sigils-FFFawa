# Changelog

## M6.2.2.4 — 2026-11-12（Group 数据完整性验证闭环）

### Note

用户提供的 M6.2.2.4 指导包以 M6.2.2.3 为基线，但本轮工作区只有 M6.2.2.2，未收到 M6.2.2.3 工程包。因此先在 M6.2.2.2 基线上补齐指导包描述的 M6.2.2.3 Group 约束，再执行 M6.2.2.4 的验证矩阵；报告中已如实标注该基线差异。

### Fixed（CC Lua v4.3）

- **GroupAdd 归属**：`machineId` 必填且必须为非空字符串；执行前校验目标 Machine 存在。
- **非空槽位**：`GroupAdd.group.slots` 与 `GroupEdit.edits.slots` 均不得为空数组。
- **槽位编号语义**：普通物品组每个 slot 必须有正整数 `slot`；`fluid = true` 的流体组允许只有 `periphId`。
- **重复引用**：同一槽位列表内拒绝重复 `(periphId, slot)`；同一 Machine 的不同 Group 在最终状态引用同一 `(periphId, slot)` 时拒绝。
- **批量最终态校验**：允许 split 等操作在 staged 执行期间临时重叠，但保存前对最终 staged Factory 做归属校验；重复则整批丢弃。
- **单条入口一致**：`applySingleRequest` 现在也执行 schema + factory 校验，与 BatchRequest 使用同一套规则。

### Changed（Web / 测试）

- `tests/support/fake-cc.ts`：镜像 Group 归属、非空槽位、槽位编号、重复引用与最终态校验；单条消息也走同一校验。
- `tests/batch-validation.test.ts`：新增 Group 专项矩阵（G-01…G-19）。
- Lua 测试：`batchValidation.test.lua` 191 条断言、`controllerBatch.test.lua` 21 项；另执行 `filterCompatibility` 6 项、`packageTransport` 9 项。

### Docs

- 新增 `docs/M6.2.2.4-验收报告.md`、`M6.2.2.4-环境与命令记录.md`、`M6.2.2.4-Group验收矩阵结果.md`、`M6.2.2.4-部署包一致性.md`。

### Verified

| 检查 | 结果 |
|---|---|
| Lua 全量测试（4 文件，lupa 2.8 / Lua 5.5） | 191 + 21 + 6 + 9 全部通过 |
| `npm run typecheck` | 通过 |
| `npx vitest run` | **192 项 / 13 文件通过** |
| `npm run build:web` / `build:server` | 通过 |
| CC 部署包 | 30 文件逐文件 SHA-256 一致 |
| Minecraft / CC:T / Create 实机 | **未执行** |
| 浏览器冒烟 | **未执行**（本轮无脚本化冒烟） |

## M6.2.2.2 — 2026-11-12（BatchRequest 深层字段校验）

### Fixed（CC Lua v4.3）

- **字段白名单**：`PipeEdit` 只接受 `mode/nickname/filter`，`MachineEdit` 只接受 `nickname/x/y`，`GroupEdit` 只接受 `nickname/x/y/fluid/slots`；`id`、`from`、`to`、`groups`、`machineId` 等身份/关系字段通过 `edits` 注入时整批拒绝。
- **Add 对象校验**：`PipeAdd.pipe`、`MachineAdd.machine`、`GroupAdd.group` 只接受 schema 字段；必填字段、连续字符串数组、槽位结构与 `periphId`/slot number 逐项检查。
- **PeriphAdd.options**：只允许 `nickname/x/y`，禁止通过 options 覆盖 `id`、`groups`、`periphId` 或其他身份字段。
- **边界检查**：坐标、slot number 拒绝 NaN / ±Infinity；`mode` 仅接受 `natural`/`spread`；字符串必需字段拒绝空串；数组拒绝稀疏与字符串 key。
- **错误可诊断**：错误消息包含 child 序号、请求类型、字段路径和拒绝原因。
- 校验仍在 `staged` 之前完成；失败时 Factory 不变、`saveFactory` 不调用、不发送成功确认。

### Changed（Web / 测试）

- `tests/support/fake-cc.ts`：`batchChildError` 与 Lua 契约同步为深度白名单校验，新增 `saveCount`，失败确认携带诊断 message。
- 新增 `tests/batch-validation.test.ts`（63 项）：逐 mutation 覆盖合法对象、未知字段、身份/关系注入、NaN/Infinity、稀疏数组、枚举与执行边界。
- `tests/batchValidation.test.lua` 扩展为 160 条断言；`tests/controllerBatch.test.lua` 扩展为 13 项，新增“深层字段非法时首个 child 也未执行、save=0、无成功 ack、Factory 不变”。

### Docs

- 新增 `docs/M6.2.2.2-交付报告.md`、`docs/M6.2.2.2-变更说明.md`。

### Verified

| 检查 | 结果 |
|---|---|
| CC Lua 校验测试（Lua 5.5 + lupa） | 160 条断言通过 |
| CC Lua 控制器时序测试 | 13 项通过 |
| `npm run typecheck` | 通过 |
| `npx vitest run` | **173 项 / 13 文件通过** |
| `npm run build:web` / `build:server` | 通过 |
| CC 部署包 | 30 文件重新打包；逐文件 SHA-256 与源码一致 |
| 真实 CC:Tweaked / Minecraft / Create | **未执行** |

## M6.2.2 — 2026-11-12（CC 批量执行与持久化语义）

### Fixed（CC Lua v4.3）

- **BatchRequest 严格预校验**：新增 `sigils/batchValidation.lua`；`requests` 必须是连续非空数组，key 只能是从 1 开始的整数；子请求必须是已知工厂 mutation 且必需字段齐全。未知类型/缺字段不再静默跳过，整批在 mutation 前拒绝。
- **确定性顺序**：预校验通过后用 `ipairs` 按数组顺序执行，不再依赖 `pairs`。
- **保存成功才确认**：`Factory.saveFactory` 成功时显式 `return true`；控制器要求返回值严格为 `true` 才 `commitFactory` 并发送 `ok=true`。
- **持久化失败隔离**：保存失败（异常或返回 false）时丢弃 staged、不提交、不发送成功；`persistenceFailed` latch 阻断后续 mutation 与 FactoryGet，直到重启并通过 `recoverFactory` 恢复。
- 失败确认响应附带 `error` / `message`（v4.3 已定义字段）。
- `sigils-v4.3-packager.lua` 兼容 Lua 5.5，便于在 PC 上重新打包与测试。

### Corrected

- 实际部署源码 `sigils-v4.3-source` 已采用 staged clone + save-before-ack；M6.2.1 审计中的“先响应后保存”结论针对 upstream master。M6.2.2 以实际部署源码为准补齐校验、顺序与失败隔离。

### Changed（Web / 测试）

- `tests/support/fake-cc.ts` 模拟新的 BatchRequest 校验：未知子请求 / 缺字段整批 `ok=false` 且不修改工厂。
- 移除 `atomic / transaction / never contains half-merged` 等超出实际保证的注释与测试名称，统一为 ordered batch / single save / non-transactional。

### Docs

- 新增 `docs/M6.2.2-交付报告.md`、`docs/M6.2.2-变更说明.md`。
- 新增 CC Lua 测试：`batchValidation.test.lua`（18 项）、`controllerBatch.test.lua`（7 项）。

### Verified

| 检查 | 结果 |
|---|---|
| CC Lua 逻辑测试（Lua 5.5 + stub） | 25 项通过（18 校验 + 7 控制器时序） |
| `npm run typecheck` | 通过 |
| `npx vitest run` | **110 项 / 12 文件通过** |
| `npm run build:web` / `build:server` | 通过 |
| CC 部署包 | 30 文件重新打包；unpack 回读 SHA256 与源码一致 |
| 浏览器冒烟（生产构建） | 通过：连接、机器 ID、重新同步；无错误提示、无 console 报错 |
| 真实 CC:Tweaked / Minecraft / Create | **未执行** |

## M6.2.1 — 2026-11-12（Stability & Sync Safety）

### Fixed

- **响应必须严格匹配**：新增 `responseGuard.ts`，依次校验 envelope、reqId、respondingTo、Session、connection epoch、payload；全部通过前不清 pending、不 `guard.finish`、不应用 Factory/diff、不改变 stale。
- **未知 / 重复 / 错配 / 迟到响应**：只记录日志并忽略，不再据此更新画面或误标 stale；pending 保留到超时。
- **FactoryGet 单飞**：同一 Session / 连接代际只允许一个快照请求；同步期间 UI 显示「正在同步…」并禁用按钮。
- **stale 恢复屏障**：FactoryGet 只有在完整校验且 `snapshotSeq === currentMutationSeq`（快照晚于全部写入）时才解除 stale；否则保持冻结并要求再次同步。
- **Session / 连接代际隔离**：pending 记录 Session 与 epoch；每条新连接递增 epoch；切换会话主动清空旧请求。
- **多管道删除**：单条直接 `PipeDel`，多条合并为一个 `BatchRequest`，避免逐条发送与 mutation 单飞门禁冲突。

### Changed

- FactoryGet 结构与引用校验失败时不再立即标记 stale（按规范“不改变 stale”），快照不应用、pending 等超时后 fail closed。
- 同步相关日志统一输出 `[sigils-sync]`，包含 reqId、类型、respondingTo、Session / epoch。

### Docs

- 新增 `docs/M6.2.1-CC控制器审计.md`：证明 CC FIFO 同步屏障；BatchRequest 审计结论为 **C（单次持久化但非事务）**。
- 新增 `docs/M6.2.1-验收报告.md`、`docs/M6.2.1-变更说明.md`。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | **109 项 / 12 文件通过**（新增 `response-guard` 14 项；sync-guard +3；factory-actions +1；protocol-sim +1） |
| `npm run build:web` / `npm run build:server` | 通过 |
| 浏览器冒烟（生产构建） | 通过：连接、机器内管道改名、重新同步、删除管道；无错误提示、无 console 报错 |
| 真实 CC:Tweaked / Minecraft / Create | **未执行** |

## M6.2 — 2026-11-12（管道与外设 ID 修正）

### Fixed

- **管道无法删除**：检视面板新增「删除管道」按钮（`PipeDel`）；Delete / Backspace 均可删除选中的边。机器框背景不再拦截鼠标（`pointer-events: none`），机器内部的管道现在可以被点选。
- 节点不再响应键盘删除（`deletable: false`），避免只删掉本地节点却没有向 CC 发送 `GroupDel` / 级联删除。

### Added

- **管道命名**：管道检视面板新增「管道名称」，与过滤表达式一起通过 `PipeEdit` 提交；边标签显示为「名称 (过滤表达式)」，无名称时仍显示过滤表达式或 mode。
- 机器框标题改为显示原始 Peripheral ID，昵称作为「别名」单独显示；改名不再影响机器标识。

### Changed

- 机器框底色改为半透明，使框内管道可见。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | 91 项 / 11 文件通过 |
| `npm run build:web` / `build:server` | 通过 |
| 浏览器实测 | 通过：机器内管道可点选；改名后标签为「主输入 (#warehouse)」；「删除管道」后边消失；点击机器标题显示原始 ID `minecraft:chest_0`；无 console 错误 |
| 真实 CC / Create | **未执行** |

## M6.1 — 2026-11-12（测试反馈修复）

### Fixed

- **容器末尾槽位被裁切**：根因是 React Flow 默认节点自带 10px padding 与边框，而节点宽高按内容计算，导致 9 列槽位可用宽度少约 21px，第 9 列及最后一行被 `overflow: hidden` 裁掉。现在节点 wrapper 显式 `padding: 0 / border: none / background: transparent`，容器改用固定列数的 CSS Grid。27 槽位实测为 3 行 × 9 列，全部可见。
- **删除容器后无法找回**：删除容器（分组）后，不再被其他容器引用的外设会回到「可用外设」区并标记「已释放」，可直接「添加为机器」重建容器。释放列表只在权威 Factory 更新后计算，删除失败不会误报。

### Removed

- 移除右侧「分组槽位」面板（槽位勾选、保存槽位、移动槽位）。槽位交互统一为拖动：拖单个槽位拆出新容器，拖整个容器合并；不再提供面板式槽位编辑。

### Changed

- CC 默认容器名显示为中文：`Inventory` → 物品槽、`Fluid tank` → 液体槽（仅显示映射，不改写游戏端昵称）。
- 液体容器的槽位方块改为与物品槽一致的编号显示（1、2、3…），不再显示「液」。
- 检视面板、删除确认、底部统计统一使用「容器」术语。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | 89 项 / 11 文件通过 |
| `npm run build:web` / `npm run build:server` | 通过 |
| 浏览器实测 27 槽布局 | 通过：3 行 × 9 列，`.group-slots` clientWidth = scrollWidth = 250，无裁切 |
| 浏览器实测删除/重建 | 通过：删除 27 槽容器 → 可用外设出现 `minecraft:barrel_0`（已释放）→ 添加为机器后容器重建 |
| 中文标题与面板移除 | 通过：物品槽 / 液体槽；全文档不再有「分组槽位」 |
| 真实 CC:Tweaked / Create 联机 | **未执行** |

> 备注：本地 mock CC 的 `inventories` 未登记 barrel 容量，因此上方「重建」实测得到的容器为 1 槽；真实 CC 会按外设实际槽位数创建。该限制只影响 mock，不是编辑器行为。

## M6 — 2026-11-12（编辑器交互语义恢复）

### Added

- **容器框合并**：拖动整个分组卡片到同一机器内的兼容分组卡片上，目标卡片绿色高亮并提示「松开以合并到此容器」；松开后经确认发送一个 `BatchRequest`（`GroupEdit` 目标槽位 + `GroupDel` 源分组），源分组的关联管道按 CC 级联规则删除。规则与旧版 `combineGroups` 一致：同机器、Item↔Item / Fluid↔Fluid、目标保留 ID 与昵称、槽位按 `slot`→`periphId` 排序。
- **槽位拖动**：展开容器内的槽位可拖回同一机器框空白处，拆成一个新的容器（`GroupAdd` + `GroupEdit`，保留原昵称与落点位置）；源容器只剩一个槽位时拒绝，跨机器拖动直接拒绝。
- **外设 ID 只读展示**：机器检视面板列出该机器槽位引用的全部 Peripheral ID，并说明当前协议没有安全改写能力。
- 新增 `docs/M6-旧版交互对照.md`（I1 源码调查）与 `docs/M6-I4-外设ID能力分析.md`（含 `MachineReassignPeriph` 协议提案）。

### Fixed

- 槽位方块改为 `box-sizing: border-box`：此前 1px 边框计入额外宽度，6 个以上槽位会换行并被卡片裁切。

### Safety

- 槽位拖动与容器合并都是 mutation，统一经过 M5.5.1 写入门禁；pending / stale / 非在线状态下不生成请求。
- 合并前校验同机器、类型一致、槽位不重复；合并确认框明确列出被删除的源容器与关联管道数。
- 不做乐观更新：失败或等待确认期间不修改本地 Factory。

### Docs

- 阐明 v4.3 中「容器框」就是 Group 节点，容器合并在协议层即 `GroupEdit` + `GroupDel`，并记录与旧版行为一致 / 未实现的边界（机器框合并、外设徽章拆分）。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | 85 项 / 11 文件通过（新增 `tests/container-merge.test.ts` 10 项） |
| `npm run build:web` / `npm run build:server` | 通过 |
| 浏览器冒烟（生产构建 :4173） | 通过：拖拽 Overflow 到 Main 触发确认与高亮，合并后 Main 为槽位 1–6、Overflow 消失；重连重新拉取快照后结果一致 |
| 槽位拖动浏览器实测 | **未执行**（HTML5 DnD 自动化不稳定），由构造器 + Fake CC 协议测试覆盖 |
| 6 槽位单行布局目视复验 | **未执行**（mock 固定夹具只有 4 槽）；已由 `box-sizing` 修复，4 槽位实测无裁剪 |
| 真实 CC:Tweaked / Create 联机 | **未执行** |

## M5.5.1 — 2026-11-12（写入安全修复，P0）

### Added

- 新增 `apps/web/src/websocket/syncGuard.ts`：`classifyRequest()` 区分 mutation / read / session，`FactorySyncGuard` 维护「单飞写入门禁 + stale(needsResync) 状态机」。
- 新增 stale 横幅：显示不可信原因，提供「重新同步工厂」按钮；stale 期间底部状态栏同步提示「数据不可信 · 写入已冻结」。

### Fixed

- 所有工厂写入统一收敛到连接层 `sendRequest` 门禁：已有 mutation pending 或 stale 时直接抛错，UI 禁用状态失效也不会产生第二次写入。
- 画布全部写入入口按同一规则拦截：连线、边删除、Delete 键、节点拖动位置持久化、昵称/槽位/拆分/删除/外设面板、管道过滤提交。
- mutation 超时（结果未知）、diff 无法应用、diff 引用校验失败、迟到或无法匹配的写入确认、断线时仍有未确认写入，都会进入 stale 并冻结全部写入。
- stale 期间忽略所有增量 diff，保留当前画面供查看；迟到响应不能解除 stale，断线/重连也不会。
- 恢复只允许通过完整 `FactoryGet` 快照：先校验结构/引用，再原子替换，成功后才解除 stale；快照失败、超时或校验失败继续冻结。
- UI 在 pending / stale 时禁用拖动、连线与删除快捷键；只读请求（`FactoryGet`）与会话请求不被写入门禁误拦，stale 时仍可主动重新同步。

### Docs

- 新增 `docs/M5.5.1-验收记录.md`，逐项对照 W1–W6 记录实现与证据。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | 72 项 / 10 文件通过（新增 `tests/sync-guard.test.ts` 11 项） |
| `npm run build:web` / `npm run build:server` | 通过 |
| 浏览器冒烟（生产构建 4173 + relay 3000 + mock CC） | 通过：连接、快照、节点/检视面板正常，无 stale 横幅、无 console 错误 |
| stale 路径浏览器实测 | **未执行**：mock CC 无故障注入，stale 由 11 项状态机单测覆盖 |
| 真实 CC:Tweaked 联机 | **未执行**（M6 范围） |

## M5.5 — 2026-11-12（缺陷收敛）

### Fixed

- 「未分配槽位」分组创建入口已移除：Factory 快照不含库存容量，候选集合恒为空，属于不可靠数据来源。界面改为「拆分分组」，必须选择现有分组作为来源；`buildGroupCreate` 保留为受校验的构造路径但不再从 UI 调用。
- `normalizeSlots` 不再静默去重：重复的 `(periphId, slot)` 直接抛出错误，避免把用户输入的错误写进槽位列表。
- 同一槽位被两个分组占用时，错误信息会指出占用者分组 ID，而不是笼统的“已属于其他 Group”。
- 折叠态分组节点高度不足导致摘要行被裁切（上一轮遗留，本次随 UI 复核一并确认）。

### Safety

- 发送前校验消息类型：顶层消息必须属于 `FactoryGet` / `SessionJoin` / `SessionClose` / `BatchRequest` / 工厂更新类型，批量请求的每个子项必须是工厂更新类型。v4.3 对未知批量类型仍返回 `ok:true`，因此不能依赖服务端报错。
- 新增 `pendingCount`：有请求在途时禁用全部写按钮并提示「等待游戏端确认」，避免连续点击造成重复写入。
- 请求超时文案改为「结果未知，请点击重新同步工厂确认」，不再暗示操作已失败。
- 删除分组 / 机器 / 外设时展示影响范围：关联管道数、将被删除的分组与机器、被清除的槽位数。

### Docs

- README 新增「运行与部署」：区分开发联调包与生产部署包，明确 relay 依赖 `ws`，列出环境变量、启动前检查与安全边界。
- 新增 `docs/M5.5-验收记录.md`，逐项记录 P0-01 至 P0-04 的处理与证据。

### Verified

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run` | 59 项 / 9 文件通过 |
| `npm run build:web` / `npm run build:server` | 通过 |
| 浏览器冒烟（生产构建） | 通过：拆分面板提示/选项正确、按钮禁用逻辑正确、无 React 报错 |
| 真实 CC:Tweaked 联机 | **未执行**（M6 范围） |

## UI interaction pass — 2026-11-12

### Fixed

- Node and Pipe selection no longer disappears when the mouse button is released. Selection now comes from explicit `onNodeClick` / `onEdgeClick` / `onPaneClick` handlers and is re-applied to the rebuilt React Flow node objects, so the inspector stays open and Nickname / Delete actions remain reachable.
- Local drag positions are preserved when the Factory is rebuilt, instead of snapping back to the last server position.
- Added a `Resync factory` button (sends `FactoryGet`) and a top-centre status banner, so a dropped CC connection or a stale snapshot is visible instead of silently doing nothing.

### Changed

- Layout moved from a fixed header + sidebar to a full-canvas React Flow with floating cards, matching the upstream arrangement: session and peripheral cards on the left, Inspector / Group slots / Create Group on the right, counters and a panel toggle on the bottom left.
- Peripheral, Group slots and Create Group cards are collapsible; on viewports narrower than 1100 px all floating cards start hidden and can be toggled with `Show panels`.
- All interface text is now Chinese except the brand word `SIGILS`; the page title and `lang` attribute were updated as well.
- Group nodes render their slots as a 9-per-row chip grid (26 px chips, slot number inside, colour derived from `periphId`), and the header carries a fold button that collapses the grid to a one-line summary.
- Nodes whose peripherals are all missing get a red border, a translucent background and a `外设缺失` label; machines follow the same rule.
- Text selection is disabled on the app chrome (`user-select: none`), so dragging or clicking repeatedly no longer highlights labels; inputs, selects and textareas stay selectable.

### Fixed

- Collapsed group nodes were shorter than their summary line, clipping the `物品 · N 个槽位` text. `COLLAPSED_HEIGHT` now matches the rendered content.

### Not changed

- Colour palette, fonts, handle orientation (still left/right) and pipe styling are unchanged. The upstream Minecraft GUI palette, pixel font and top-input/bottom-output handles are queued for the next visual pass together with the licence decision.

## M5.1 / M5.2 / M5.4 — 2026-11-11

### M4.1 baseline repair

- `packages/factory-model`: `Slot.slot` is optional and only item groups require an integer slot number. Fluid tank groups created by `machine.lua#addFluidTank` (`slot = nil`) no longer fail `FactoryGet` validation.
- `apps/server/src/index.ts`: fixed the message-envelope narrowing error that broke `tsc -p apps/server/tsconfig.json`.
- `apps/web/src/App.tsx`: replaced the non-existent React Flow `edgesDeletable` prop with an explicit `deleteKeyCode`, which also restores edge deletion in live mode.
- `packages/protocol`: `BatchRequest.requests` is typed as `FactoryUpdateRequest[]`, matching the v4.3 controller, which only dispatches factory-update handlers inside a batch.
- `tests/factory-actions.test.ts`, `tests/factory-model.test.ts`: corrected the four `idFactory` call sites and the reference-count expectation.

### Added

- `apps/web/src/groupActions.ts`: `suggestGroupId`, `buildGroupCreate`, `buildGroupSplit`, `buildSlotUpdate`, `buildSlotTransfer` plus slot helpers. Slot lists are sorted by slot number then peripheral id, matching the upstream `CombineHandlers`.
- `apps/web/src/App.tsx`: "Group slots" panel (edit a group's slot list, move slots to a sibling group) and "Create Group" panel (create from unassigned slots or split from an existing group).
- `tests/group-actions.test.ts`: 10 cases for id generation and the validation rules.
- `tests/fluid-group.test.ts`: pins the fluid tank slot shape.
- `tests/support/fake-cc.ts`: in-memory model of the v4.3 controller pipeline (staged clone, handler, single save, commit, jsondiffpatch delta), including unknown-type handling and save rollback.
- `tests/protocol-sim.test.ts`: 18 cases covering SessionCreate, SessionJoin, FactoryGet, MachineEdit, GroupEdit, GroupDel, BatchRequest ordering, PeriphAdd, PeriphDel, CcUpdatedFactory, diff application, reconnect, unconfirmed-request timeout and error responses.
- `tsconfig.tests.json` and `npm run typecheck:tests`; `npm run typecheck` now covers packages, apps, tests and the server build.

### Verified locally

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npx vitest run` | pass, 49 tests in 8 files |
| `npm run build:web` | pass (Vite production build) |
| `npm run build:server` | pass |
| Real CC:Tweaked session | **not run** — no game environment available |

### Known limits

- Cross-machine slot migration is not offered: no atomic protocol exists for it.
- Fluid group slots stay read-only in the editor.
- Group merge across machines (M5.3) is still unimplemented.
- Behaviour against a real Minecraft/CC:Tweaked/Create world remains unverified.

## M0–M4 — initial engineering baseline

Initial skeleton, offline canvas, independent WebSocket relay, live session editing and factory management actions. The baseline was delivered without a successful full build or test run; see M4.1 above for the repairs.
