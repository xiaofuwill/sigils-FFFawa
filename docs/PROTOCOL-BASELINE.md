# SIGILS v4.3 protocol baseline (M0)

This baseline is derived from the public `fechan/SIGILS` server contract and the supplied SIGILS v4.3 CC:Tweaked source. It is a compatibility contract, not a new protocol.

## Session lifecycle

1. CC sends `SessionCreate` with a four-character uppercase (`A`–`Z`) `sessionId` and `reqId`.
2. The server replies with `ConfirmationResponse` (`respondingTo: SessionCreate`, `ok: true`) and `ccReconnectToken`.
3. The browser sends `SessionJoin` with the same `sessionId` and a `reqId`.
4. The server confirms `SessionJoin`; the browser requests `FactoryGet`.
5. CC returns `ConfirmationResponse` (`respondingTo: FactoryGet`, `ok: true`) with the complete `factory` object.
6. The browser emits existing CRUD messages or `BatchRequest`; CC responds with `ConfirmationResponse`, including `diff` on successful factory updates.
7. CC may independently send `CcUpdatedFactory` with a jsondiffpatch delta.
8. The browser applies every delta in the received array sequentially to a clone of the current Factory; it does not interpret a delta as a full Factory snapshot. On editor reconnect, it rejoins and requests a fresh `FactoryGet` snapshot.
8. CC reconnects using `SessionRejoin`, `sessionId`, and `ccReconnectToken`.

## Message names

Factory mutation requests remain exactly: `PipeAdd`, `PipeEdit`, `PipeDel`, `MachineAdd`, `MachineEdit`, `MachineDel`, `GroupAdd`, `GroupEdit`, `GroupDel`, `PeriphAdd`, `PeriphDel`.

Other existing message names: `BatchRequest`, `ConfirmationResponse`, `IdleTimeout`, `SessionCreate`, `SessionJoin`, `SessionRejoin`, `SessionClose`, `FactoryGet`, `FactoryGetResponse`, `CcUpdatedFactory`.

## Factory wire shape

`Factory` has exactly five root maps: `pipes`, `machines`, `groups`, `missing`, `available`. `Pipe` connects Group IDs (`from`, `to`), never Machine IDs. Machines own group IDs; Groups contain `{ periphId, slot }` slots. `missing` and `available` are runtime peripheral maps and must not be overwritten blindly by stale imports.

## Diff semantics

Successful factory update confirmations and `CcUpdatedFactory` carry `jsondiffpatch` deltas. The editor must patch the existing factory with those deltas; it must not treat a delta as a full Factory document. Batch requests preserve request ordering.

## Independent server URL

The supplied v4.3 source already reads `server` from the root-level `sigils-config.json` (created from `.sigils/sigils/sigils-config.dist.json` when absent) and falls back to `wss://sigils.fredchan.org`. Therefore a self-hosted WebSocket endpoint can be selected through the existing config field; no protocol change or new CC message is required. Confirm the exact deployed config path and installer behavior during integration testing.

## Compatibility constraints

- Do not rename message types or fields.
- Do not change session ID / reconnect token semantics.
- Do not add editor-only fields to the persisted Factory object.
- Do not replace diff messages with full-state overwrites.
- Do not alter Group/Machine/Peripheral relationships or v4.3 Create package transport.
- Import/restore must be reconciled through supported mutations and tested against GroupDel cascading behavior.
