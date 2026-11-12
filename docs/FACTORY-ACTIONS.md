# M4 Factory actions

## Supported live operations

| UI action | Protocol request | Authority / side effects |
|---|---|---|
| Rename Machine | `MachineEdit` | CC updates the Machine nickname and returns a diff |
| Rename Group | `GroupEdit` | CC updates the Group nickname and returns a diff |
| Delete Group | `GroupDel` | CC deletes connected Pipes, removes the Group from its owner, and deletes the Machine if that was its final Group |
| Delete Machine | `BatchRequest` containing one `GroupDel` for every owned Group | The same CC cascade is used for every Group; the last deletion removes the Machine |
| Add available peripheral | `PeriphAdd` | CC creates a Machine and its Groups from the peripheral, using supplied initial x/y coordinates |
| Remove missing peripheral | `PeriphDel` | CC removes the peripheral's missing marker and Slots; empty Groups and dependent Pipes / Machines are cleaned up by the game-side implementation |
| Create Pipe | `PipeAdd` | Only Group-to-Group connections are accepted; Item and Fluid Groups cannot be mixed |
| Delete Pipe | `PipeDel` | CC deletes the Pipe |
| Edit Pipe filter | `PipeEdit` | CC stores the filter expression without browser-side reinterpretation |

## Deletion safety

The browser deliberately does not send `MachineDel` directly. In the game-side factory implementation, `MachineDel` removes only the Machine record; it does not cascade through the Machine's Groups. The supported safe path is to delete each Group in order. `GroupDel` performs the actual cascade and deletes the owning Machine when its last Group disappears.

Similarly, the browser uses `PeriphDel` rather than trying to edit Group slot arrays itself. CC owns peripheral-to-slot cleanup and can keep the factory references consistent.

## Synchronization rules

- No optimistic Factory mutation: the browser waits for CC's `ConfirmationResponse` and applies the returned `jsondiffpatch` deltas.
- Machine deletion uses a single `BatchRequest` containing one `GroupDel` for every owned Group. The final state does not depend on request iteration order.
- Request IDs are generated independently for the outer batch and each nested request.
- A failed request is surfaced in the connection notice; no automatic retry is attempted.
- Live import remains disabled. Export reads the latest browser snapshot.

## Group and slot operations (M5.1 / M5.2)

| UI action | Protocol request | Checks performed by the browser |
|---|---|---|
| Create group from unassigned slots | `GroupAdd` | group id free, slots not owned by any group of the machine, peripheral belongs to the machine |
| Split slots off a group | `BatchRequest` [`GroupAdd`, `GroupEdit` source] | source keeps at least one slot, every moved slot belongs to the source |
| Edit a group's slot list | `GroupEdit { slots }` | non-empty, no duplicates, no slot stolen from a sibling group, same machine only |
| Move slots between groups | `BatchRequest` [`GroupEdit` from, `GroupEdit` to] | same machine, source not emptied, target has no duplicate slot |

`groupActions.ts` repeats the checks `factory.lua` does not perform: `groupAdd` inserts the supplied group verbatim (an id collision silently replaces an existing group) and `groupEdit` assigns every supplied key without validation. The browser therefore never sends `id` or `fluid` edits, and new ids follow the upstream `${periphId}:gN` pattern only after a free-id check.

Slot lists are sorted by slot number then peripheral id, matching the upstream editor's `CombineHandlers.combineGroups`.

Deliberate non-goals:

- Cross-machine slot migration. There is no atomic protocol for it; a `GroupAdd` + `GroupEdit` + `GroupDel` sequence can leave a half-applied factory if one step fails.
- Editing fluid group slots. `machine.lua#addFluidTank` stores `slot = nil`, which the editor treats as owned by the game side.
- Group merge across machines, which still requires the M5.3 design decision.

## Validation

`tests/factory-actions.test.ts` covers request construction, batched Machine deletion, peripheral actions and Item / Fluid connection compatibility. `tests/group-actions.test.ts` covers group creation, split, slot-list updates and slot moves. `tests/fluid-group.test.ts` pins the fluid tank slot shape, and `tests/protocol-sim.test.ts` replays the messages against a model of the v4.3 controller. All of them run in `npm test`; the full suite and both production builds pass locally. Real CC:Tweaked in-game validation is still outstanding.
