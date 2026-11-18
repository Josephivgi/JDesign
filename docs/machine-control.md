# Machine Control


Cutline desktop lets you register GUI machines, see live previews, and send basic input from the **Machines** nav page (Other group).

Merged to `main` from branches `cursor/editor-chat-persist-a537` and `cursor/machine-control` (branches kept on origin for history).

## Architecture

```
Renderer (machine-control.js)
  window.cutline.listMachines / captureMachine / controlMachine / …
       ↓ IPC
electron/machine-control-ipc.cjs
       ↓
lib/machine-control.js          → SQLite registry (machines.db)
lib/machine-control-service.js  → status, capture, control, discover
lib/recorder-capture.js         → VirtualBox screenshot (VBoxManage)
lib/recorder-computer-use.js    → guest xdotool (VirtualBox) or local SendKeys
lib/recorder-targets.js         → discover running VMs, start stopped VMs
```

Registry data lives under the Cutline data root as `machines.db` (SQLite, WAL). Status is computed at read time from VirtualBox / local target inventory, not stored in the database.

## Register a machine

1. Open **Machines** in the sidebar.
2. Click **Add machine**.
3. Pick a target:
   - **This computer** (`local:this-computer`)
   - Any discovered **VirtualBox** guest (`virtualbox:<name>`)
4. Set a display name and confirm.

You can also add machines through IPC:

```js
await window.cutline.addMachine({
  name: "cutline-test-2",
  type: "virtualbox",
  targetId: "virtualbox:cutline-test-2",
});
```

### VirtualBox test guest: cutline-test-2

Primary GUI verify guest: **cutline-test-2** (Ubuntu, Cutline build, fleet `fleets/cutline-vbox.json` in the Testingfleets checkout).

1. Ensure the VM is running in VirtualBox.
2. Open **Machines** → **Add machine** → pick `virtualbox:cutline-test-2`.
3. Preview should poll PNG screenshots. Click the preview to send left clicks.

Fleet SSH from Testingfleets is used for guest input when configured.

## See (preview)

When a machine is **Idle** (running), the detail pane polls a screenshot every 3 seconds via `captureMachine`. VirtualBox guests use `VBoxManage controlvm … screenshotpng`, the same path as Recorder vision.

Offline VirtualBox guests show an empty stage until you click **Start machine** (wraps `ensureTargetRunning`).

## Control

| Action | How |
|--------|-----|
| Left click | Click the preview image (coordinates mapped to guest resolution) |
| Enter | **Send Enter** toolbar button |
| Start VM | **Start machine** when status is Offline (VirtualBox only) |

Control calls `controlMachine`, which delegates to `recorder-computer-use`:

- **VirtualBox (running):** SSH guest session + `xdotool` (fleet SSH from Testingfleets when configured)
- **Local:** PowerShell `SendKeys` / mouse events on the host

Control actions never return frames. The page polls `captureMachineScreenshot` for the preview after each action.

## IPC surface

| Preload API | Purpose |
|-------------|---------|
| `listMachines()` | Registry rows + live status |
| `getMachine({ id })` | One machine + status |
| `addMachine({ name, type, targetId, config? })` | Register |
| `updateMachine({ id, patch })` | Rename / retarget |
| `removeMachine({ id })` | Delete registry row |
| `getMachineStatus({ id })` | Status only |
| `connectMachine({ id })` | Connection metadata |
| `captureMachine({ id })` | PNG base64 preview |
| `controlMachine({ machineId, action, x?, y?, key?, text?, dy? })` | Input |
| `startMachine({ id })` | Power on VirtualBox guest |
| `discoverMachines({ type? })` | Targets for Add dialog |

## Adding another machine type

1. Extend `MACHINE_TYPES` in `lib/machine-control-store.js`.
2. Teach `statusForMachine` and `connectMachine` in `lib/machine-control-service.js`.
3. Wire capture/control to an existing transport or a new adapter module.
4. Expose discovery in `discoverTargets` if the type is auto-detected.
5. Add the type to the Add machine dialog in `renderer/js/machine-control.js`.

## v1 limitations

| Area | v1 behavior |
|------|-------------|
| VNC | Type exists in schema; connect/capture/control return stub errors |
| Hyper-V / WSL | Not registered as machine types (Recorder targets only) |
| Busy status | Set only while a control IPC call is in flight |
| Full-screen viewer | No embedded VNC/RDP window; preview is screenshot polling |
| Keyboard | Enter only in toolbar; no full keyboard overlay |
| Agent integration | Machines page is manual control; Recorder agents still use `recorder_computer_use` |
| VirtualBox video files | VBox capture yields `.webm` screen recordings via `controlvm recording`. Preview still polls PNG frames. |
| Host desktop in CI | Some cloud agents cannot drive the Windows host. GUI verify runs on VirtualBox guests only (`vm-computer-use`). |

## Tests

- `test/machine-control-store.test.js` — SQLite CRUD
- `test/machine-control-service.test.js` — status / connect / discover
- `test/machine-control-wiring.test.js` — IPC, preload, page registration
