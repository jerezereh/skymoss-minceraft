# Client troubleshooting

Working notes for diagnosing client-side problems with the Skymoss pack. Written
during a live investigation on Pop!_OS + COSMIC with an RTX 3070; the commands assume
Linux and Prism Launcher.

---

## Current open issue (2026-08-01)

**Symptom:** the Skymoss instance fails to launch with *"failed to find a valid GLFW
profile"*. This appeared immediately after rebooting to fix an NVIDIA
driver/library version mismatch.

**Immediately before that**, the same instance ran but at **10 FPS**.

### What has already been ruled out

| Checked | Result |
|---|---|
| Server performance | **Not the cause.** 20.000 TPS, 25.9 ms/tick — half the 50 ms budget |
| Client RAM | **Not the cause.** Raised 4 GB → 8 GB; usage fell 75–80% → 40–50%, FPS unchanged |
| Distant Horizons | **Not the cause.** LOD radius 256 → 64, FPS unchanged |
| GPU bottleneck | **No.** GPU utilisation 20–30% while at 10 FPS — an idle GPU, not a saturated one |
| Wayland / XWayland | **Not the cause.** Vanilla 1.21.1 runs at 61 FPS (V-Sync capped) in the same session |
| Discrete GPU in use | **Yes.** F3 reports RTX 3070 |
| NVML mismatch | Fixed by reboot; `nvidia-smi` now returns a normal table |

**Conclusion so far:** vanilla is fine, the modded instance is not — so this is the
pack or the instance configuration, not the machine, the driver, or the server.

`htop` during the 10 FPS period showed **one thread pinned at 100%**, a second at 30%,
and the rest idle. That is a single-thread CPU bottleneck on the client's main/render
thread.

---

## Step 1 — does vanilla still launch?

Thirty seconds, and it splits the problem in half.

- **Vanilla also fails now** → environmental (driver/GLFW), unrelated to Skymoss
- **Vanilla still runs** → instance-specific

---

## Step 2 — the GLFW failure

The likeliest cause is Prism injecting the **system GLFW**. On COSMIC/Wayland the
system `libglfw` is frequently built Wayland-only, while Minecraft wants an X11/GLX
context through XWayland — which produces exactly this error.

- Per-instance: **Edit Instance → Settings → Workarounds → Use system installation of GLFW**
- Global: **Prism Settings → Minecraft →** same option

Toggle it (either direction — if it is already off, try turning it *on*, since the
newly loaded 580 driver may pair better with the system library). Ensure **Custom
GLFW path** is empty.

Get the real error code, which is what actually identifies the cause:

```bash
grep -iE "glfw|glx|opengl|EGL|error" \
  ~/.local/share/PrismLauncher/instances/*/minecraft/logs/latest.log | head -30
```

| Error | Meaning |
|---|---|
| `GLX: GLX extension not found` | XWayland/GLX unreachable — driver or session issue |
| `65542` / `API unavailable` | GLFW built without the backend Minecraft needs |
| `Requested OpenGL version not available` | driver reporting a lower GL version than required |

Confirm the OpenGL stack independently of Minecraft:

```bash
glxinfo -B | grep -E "OpenGL renderer|OpenGL version|OpenGL vendor"
nvidia-smi --query-gpu=driver_version,name --format=csv
lsmod | grep -E "^nvidia|^nouveau"
```

`OpenGL renderer` naming the RTX 3070 means hardware GL works. If it says `llvmpipe`,
you are on software rendering and nothing else matters until that is fixed.

---

## Step 3 — once it launches again, find what eats the frame

`spark` ships in the pack, so profile rather than bisect 227 mods:

```
/sparkc profiler start --timeout 30
```

Play normally for 30 seconds; it prints a URL with a flame graph naming exactly what
consumes the client thread. If `/sparkc` is not recognised, try
`/spark profiler start --timeout 30` — the client command name varies by version.

**Is Sodium actually loading?** If it silently failed you would be on the vanilla
renderer with 227 mods, which alone would explain 10 FPS:

```bash
grep -iE "sodium|iris|embeddium|failed|exception" \
  ~/.local/share/PrismLauncher/instances/*/minecraft/logs/latest.log | head -30
```

**Singleplayer vs multiplayer.** Create a singleplayer world in the Skymoss instance.
Equally bad → pure client rendering, the server is irrelevant. Fine in singleplayer
but bad on the server → a network/sync problem instead, which is a different hunt.

**Distant Horizons, properly disabled.** Lowering the render distance does not stop
*generation*, which is the expensive half. Turn off **Distant Generation** outright
before concluding DH is innocent.

---

## Useful paths

```
~/.local/share/PrismLauncher/instances/<instance>/minecraft/logs/latest.log
~/.local/share/PrismLauncher/instances/<instance>/minecraft/config/
~/.local/share/PrismLauncher/instances/<instance>/instance.cfg
```

Prism also exposes the log directly: select the instance → **Logs** in the right panel.

---

## Reference: what "good" looks like

| | |
|---|---|
| Vanilla 1.21.1 | 61 FPS (V-Sync capped at 60 Hz) |
| Server TPS | 20.000, ~26 ms/tick |
| Client RAM | 40–50% of 8 GB |
| GPU | RTX 3070, proprietary driver 580.173 |
| Session | Wayland (COSMIC) — XWayland for Minecraft |
