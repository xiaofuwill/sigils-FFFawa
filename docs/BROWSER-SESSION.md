# Browser session client (M3)

## Connection flow

1. The player opens SIGILS' in-game editing session (press `E`) and reads the four-letter code.
2. The browser opens the configured `ws://` or `wss://` endpoint.
3. The browser sends `SessionJoin` with the code and a unique `reqId`.
4. On successful `ConfirmationResponse` for `SessionJoin`, the browser sends `FactoryGet`.
5. The `ConfirmationResponse` for `FactoryGet` contains the full `factory`; the browser validates its five root maps and references before displaying it.
6. Successful mutation confirmations and `CcUpdatedFactory` carry arrays of jsondiffpatch deltas. The browser applies each delta in order to a cloned current Factory.
7. If the editor WebSocket closes unexpectedly, it retries after three seconds, rejoins the same code, and fetches a new full snapshot. Requests that were not confirmed before disconnect are not automatically replayed.

## Heartbeat and request handling

- Browser sends the text frame `ping` every 45 seconds; the relay replies with `pong`.
- A missing heartbeat response closes the socket and activates reconnect.
- Mutation requests are correlated by UUID `reqId` and have a 15-second client timeout.
- Requests are not replayed after reconnect because an unconfirmed mutation may already have been executed by CC. The fresh `FactoryGet` snapshot is the source of truth.

## Live operations in this milestone

- Connect and disconnect from a four-uppercase-letter Session Code.
- `PipeAdd` by connecting two Group nodes.
- `PipeDel` by deleting selected Pipe edges.
- `PipeEdit` for the selected Pipe filter expression.
- `MachineEdit` / `GroupEdit` for node positions after dragging.
- Live CC-originated changes are applied from `CcUpdatedFactory` deltas.

Machine/Group creation, deletion, renaming, and full connected import reconciliation are not part of this initial M3 slice.

## Endpoint configuration

- Local default: `ws://localhost:3000`.
- Optional Vite environment override: `VITE_SIGILS_WS_URL` (see `apps/web/.env.example`).
- HTTPS deployments must use `wss://` and terminate TLS at the reverse proxy or hosting layer.
