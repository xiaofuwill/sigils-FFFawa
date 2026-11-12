# SIGILS Independent Web Editor

Independent web editor and session server for SIGILS v4.3. The project is a compatibility-first independent editor with a React Flow graph UI and a separate WebSocket relay.

## Scope

- Replica: React Flow graph editor reproducing Machine → Group hierarchy and Group-to-Group Pipes.
- Create: filter syntax assistance for v4.3 package address Glob expressions.
- Config: validated local JSON import/export; connected restore and backup history are planned separately.

## Current status

**M0 completed:** shared Factory types, protocol message contracts, structural/reference validators, filter syntax reference, and contract tests.

**M1 prototype created:** React Flow offline canvas with Machine → Group nesting, Group-to-Group Pipe edges, Create filter helper, and validated local JSON import/export.

**M2 implemented:** independent Node.js WebSocket relay with CC-created four-character session codes, reconnect tokens, single-editor pairing, FIFO reconnect outbox, idle timeout, payload limit, optional Origin allowlist, and `/healthz`. The relay forwards existing SIGILS messages and never edits or persists Factory data.

**M3 implemented (initial live-edit slice):** browser WebSocket connection UI, four-letter Session Code pairing, `SessionJoin` → `FactoryGet`, heartbeat, automatic editor reconnect, factory validation, sequential `jsondiffpatch` delta application, and live Pipe add/edit/delete plus Machine/Group position updates. Offline import/export remains available; importing is disabled while connected to prevent accidental local snapshot replacement.

**M4 implemented (factory management slice):** Machine/Group nickname editing and safe deletion through the existing CC cascade, adding available peripherals as Machines, removing missing peripherals, and Item/Fluid Pipe compatibility checks.

**M4.1 baseline repair:** fluid tank groups (`slot = nil` in `machine.lua#addFluidTank`) are accepted again, the server and web production builds compile, and the previously failing tests were corrected.

**M5.1 / M5.2 implemented (group and slot editing):** group creation from unassigned slots, group split through a single `BatchRequest`, slot-list editing, and slot moves between groups of the same machine. Every builder enforces the checks the game side omits: ID collisions, duplicate slots, slot stealing, cross-machine moves and empty groups.

**M5.4 implemented (protocol simulation):** `tests/support/fake-cc.ts` models the v4.3 controller pipeline (staged clone, save, commit, diff) and `tests/protocol-sim.test.ts` covers the handshake, all factory messages, ordered batch execution, save failure rollback in the simulator, `CcUpdatedFactory`, reconnect and outbox timeout.

**M5.5.1 implemented (write safety):** all factory mutations pass a single gate at the connection layer: at most one in-flight mutation, and no writes at all while the local factory is marked stale. Stale is entered on mutation timeout, unapplicable/invalid diffs, unmatched write confirmations, or a dropped connection with unconfirmed writes. It is only cleared by a fully validated `FactoryGet` snapshot; diffs and reconnects never clear it.

**M6 implemented (interaction semantics):** slot drags split a slot into a new container of the same machine, and dragging a whole container onto a compatible container of the same machine merges it through one `BatchRequest` (`GroupEdit` + `GroupDel`), matching the upstream `combineGroups` rules. Machine panels show the referenced Peripheral IDs read-only; changing them needs a CC-side protocol extension (`docs/M6-I4-外设ID能力分析.md`).

**M6.1 implemented (test feedback):** container cards now size their 9-column slot grid exactly, so the last slots are never clipped. The per-slot editing panel is removed; slots are only manipulated by dragging. Deleting a container returns peripherals that no other container uses to 可用外设 (marked 已释放), where 添加为机器 rebuilds them. CC defaults display as 物品槽 / 液体槽, and fluid slots are numbered like item slots.

**M6.2 implemented (pipes and machine identity):** machine frames no longer intercept pointer events, so pipes drawn inside a machine can be selected; the inspector can rename a pipe (stored as `PipeEdit.nickname`) and delete it (`PipeDel`), and Delete/Backspace work on the selected edge. Machine titles always show the raw peripheral ID, with the nickname shown separately as 别名.

**M6.2.1 implemented (stability & sync safety):** every `ConfirmationResponse` is matched on reqId, respondingTo, Session, connection epoch and payload before pending/guard/Factory state changes. FactoryGet is single-flight, and a stale state is cleared only when a fully validated snapshot was requested after every mutation (`snapshotSeq === currentMutationSeq`). Multi-pipe deletes are sent as one `BatchRequest`. The CC Lua audit proves a FIFO execution barrier and classifies `BatchRequest` as single-save but **not** transactional; see `docs/M6.2.1-CC控制器审计.md`.

**M6.2.2 implemented (CC batch and persistence semantics):** the CC v4.3 controller now validates `BatchRequest` arrays and child schemas before mutation, executes children with `ipairs`, rejects unknown/incomplete children, and acknowledges success only after `saveFactory` explicitly returns `true`. A failed save discards the staged factory and latches persistence as unhealthy, blocking further mutations until restart. Pipe processing was audited as read-only for persistent Factory fields; only the controller writes. See `docs/M6.2.2-交付报告.md`.

**M6.2.2.2 implemented (deep BatchRequest field validation):** every batch child is checked against an explicit field whitelist before anything runs. Generic `edits` cannot rewrite `id`, pipe endpoints, `groups` or ownership fields; `PeriphAdd.options` only accepts `nickname/x/y`; coordinates and slot numbers reject NaN/Infinity; sparse arrays and unknown keys are rejected with a child-indexed diagnostic. The TypeScript fake CC mirrors the same contract, and rejection is proven to leave the Factory unchanged with no save and no success acknowledgement. See `docs/M6.2.2.2-交付报告.md`.

**M6.2.2.4 implemented (Group integrity verification closure):** `GroupAdd` now requires a valid `machineId` pointing at an existing Machine, `GroupAdd`/`GroupEdit` reject empty slot lists, item groups require positive slot numbers, and duplicate `(periphId, slot)` ownership is rejected. The single-message and `BatchRequest` paths share the same validation; slot ownership is checked on the final staged Factory so a legitimate split may overlap temporarily but a duplicate final state is rejected as a whole. All Lua tests, Vitest, typecheck and builds were executed; in-game Minecraft/CC:T verification remains outstanding. See `docs/M6.2.2.4-验收报告.md`.

Still pending: Cross-machine slot migration (no atomic protocol exists), machine-frame merging and peripheral-badge splitting (upstream behaviours outside M6), browser backup history, safe connected import reconciliation, and end-to-end testing against a running CC:Tweaked instance.

## Compatibility target

Minecraft 1.20.1 Forge, CC:Tweaked, Create 6.0.8 Fix, SIGILS v4.3.

See `docs/PROTOCOL-BASELINE.md`, `docs/SESSION-SERVER.md`, and `docs/FILTER-SYNTAX.md` before changing wire or filter behavior.

## Development

Requires Node.js 20+.

```sh
npm install
npm test
npm run typecheck
npm run dev:web
npm run dev:server
```

`npm test` runs the contract and protocol-simulation tests; `npm run typecheck` covers the shared packages, the apps, the tests and the server build; `npm run build:web` builds the browser app.

## 运行与部署

### 开发联调包

```powershell
npm.cmd install --registry=https://registry.npmmirror.com
npm.cmd run dev:server   # relay，默认 0.0.0.0:3000
npm.cmd run dev:web      # 编辑器，默认 http://localhost:5173
```

`registry.npmjs.org` 在部分网络下不可达；PowerShell 若提示“禁止运行脚本”，用 `npm.cmd` 代替 `npm`。

### 生产部署包

**relay 依赖 `ws`，不是零依赖。** 服务器端只需要运行依赖：

```powershell
npm.cmd install --omit=dev --registry=https://registry.npmmirror.com
node apps/server/dist/index.js
```

浏览器端 `apps/web/dist` 是纯静态产物，用任意静态服务器托管即可；页面里的 WebSocket 地址默认 `ws://localhost:3000`，跨机访问时在界面「服务端地址」里改成 `ws://<主机IP>:3000`。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | relay 监听地址 |
| `PORT` | `3000` | relay 端口，需在防火墙放行 |
| `IDLE_TIMEOUT_MS` | `600000` | 空闲超时（10 分钟） |
| `OUTBOX_TIMEOUT_MS` | `10000` | CC 断线时编辑器请求的暂存上限 |
| `MAX_PAYLOAD_BYTES` | `104857600` | 单条消息上限 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的浏览器来源白名单；CC 不带 Origin 仍可连 |

启动前检查：Node ≥ 20；端口未被占用（`Get-NetTCPConnection -LocalPort 3000`）；`http://<主机>:3000/healthz` 返回 `{"ok":true,...}`；CC 端 `sigils-config.json` 的 `server` 指向该地址。

### 安全边界

- 四位会话码约 45.7 万种组合，**不是身份认证**，不做速率限制；只建议在可信局域网使用。
- 不要把 relay 端口直接暴露到公网。需要远程访问时先做 TLS（`wss://`）、反向代理和访问控制。
- relay 不持久化 Factory；进程重启后所有会话失效。
- 编辑器同一时刻只允许一个未确认的工厂写入。写入超时/结果未知、diff 无法应用、断线时仍有未确认写入，都会进入「数据不可信」状态并冻结写入；此时只能点「重新同步工厂」做完整快照校验后恢复，重连或关闭提示不会解除冻结。

## Architecture (planned)

```text
apps/web        React + TypeScript + Vite + React Flow
apps/server     Node.js + TypeScript + ws (independent session relay; M2 implemented)
packages/*      shared protocol, factory model, filter syntax
```

The game-side SIGILS computer remains authoritative for the live Factory and its persistence. The browser must never write directly to CC's `factory.json`. Offline import/export runs only against local browser state. In live mode the browser receives the game-side Factory and sends existing mutation messages through the relay.

## License note

The upstream repository root identifies GPL-3.0-or-later while its client package declares MIT. This project currently defines compatibility contracts independently and does not copy upstream UI implementation. Before copying any upstream implementation files, resolve the applicable license for those exact files.

## M4 — Factory management actions

M4 adds live Machine / Group nickname editing and deletion, adds newly discovered peripherals as Machines, and removes missing peripherals. Deletion is delegated to the game-side API: deleting a Group removes connected Pipes and may remove its parent Machine when it was the final Group; deleting a Machine is encoded as a `BatchRequest` of `GroupDel` operations. Peripheral removal uses `PeriphDel`, allowing CC to clean up Slots, empty Groups, Pipes, and Machine references consistently.

Pipe creation now rejects connections between Item Groups and Fluid Groups. The browser does not mutate the Factory optimistically: it waits for CC confirmation and applies the returned diffs.

See `docs/FACTORY-ACTIONS.md` for operation semantics and test coverage.
