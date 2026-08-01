# Client troubleshooting

Working notes for diagnosing client-side problems with the Skymoss pack. Written
during a live investigation on Pop!_OS + COSMIC with an RTX 3070; the commands assume
Linux and Prism Launcher.

---

## RESOLVED (2026-07-31): GLFW failure was a Flatpak NVIDIA GL mismatch

**Symptom:** the Skymoss instance failed to launch with *"failed to find a valid GLFW
profile"*; vanilla launched but rendered nothing. Both appeared immediately after
rebooting into an updated NVIDIA driver.

**Actual root cause (NOT the system-GLFW theory in Step 2 below):** Prism is installed
as a **Flatpak**. A Flatpak app does not use the host's GL drivers — it uses a bundled
`org.freedesktop.Platform.GL.nvidia-<ver>` runtime extension that must match the host
driver *exactly*. The update bumped the host driver to **580.173.02**, but the only
installed extensions were `580-126-18` and `580-159-03`. With no matching extension the
sandbox GLX exposed no framebuffer configs, producing the real log error:

```
[EARLYDISPLAY/]: ... GLFW error: [0x10009]GLX: Failed to find a suitable GLXFBConfig
```

Vanilla rendered nothing for the same reason. Hardware GL on the *host* was fine the
whole time (`glxinfo -B` → RTX 3070, OpenGL 4.6, driver 580.173.02, direct rendering).

**Fix:**

```bash
flatpak update -y          # pulls the GL.nvidia extension matching the new host driver
# verify the match:
nvidia-smi --query-gpu=driver_version --format=csv,noheader   # e.g. 580.173.02
flatpak list | grep GL.nvidia                                 # must show 580-173-02
```

No reboot needed — Flatpak selects the extension at launch time. If `flatpak update`
does not pull it, install explicitly:
`flatpak install flathub org.freedesktop.Platform.GL.nvidia-580-173-02 org.freedesktop.Platform.GL32.nvidia-580-173-02`

**Lesson:** after any host GPU-driver update on a Flatpak Prism install, re-run
`flatpak update` before troubleshooting anything else. This recurs on every driver bump.

---

## RESOLVED (2026-07-31): the "10 FPS" was a 10 FPS framerate CAP

**Root cause:** `options.txt` had **`maxFps:10`**. The "Max Framerate" video slider was
set to its minimum. Minecraft was capping the client to 10 FPS on purpose. Nothing was
wrong with the machine, driver, pack, or server.

**How the spark profile proved it** (client render thread, standing still):

| Frame | % of render thread |
|---|---|
| `RenderSystem.limitDisplayFPS` → `glfwWaitEventsTimeout` → `ppoll` (**sleeping**) | **58.8%** |
| `GameRenderer.render` (actual rendering) | 29.2% |
| `Minecraft.tick` | 9.3% |
| `Window.updateDisplay` (GPU present/swap) | 0.31% |

A render thread that sleeps 59% of every frame in the frame limiter is **not**
compute-bound — it renders with time to spare and idles the rest to hold the cap. No mod
used meaningful time (top was `neoforge` 4.8%; `distanthorizons` 1.2%, `sodium` 0.9%,
`create` 1.1%). GPU present was 0.31%, so it was never GPU-bound either. The earlier
"one thread pinned at 100%" in `htop` was **not** this render thread.

**Fix:** raise Max Framerate. In-game: **Options → Video Settings → Max Framerate**, off
`10`. Or edit `options.txt` `maxFps:` **while the game is closed** (Minecraft rewrites
`options.txt` on exit, so editing it live is discarded). VSync is on, so it settles at
the monitor refresh (~60).

**Lessons for next time — check the cheap, dumb things first.** A "10 FPS" symptom that
is *exactly* 10 (a round number) is a cap, not a bottleneck. Before profiling 227 mods:
read `options.txt` (`maxFps`, `enableVsync`, `renderDistance`), and confirm the number
isn't suspiciously round. Everything ruled out in the table below was real work, but
none of it was the cause.

### The earlier investigation (all correct eliminations, wrong target)

The table below and Step 3 profiling were still useful — they *proved* it wasn't the
machine — but the actual answer was a one-line setting.

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

## RESOLVED (2026-07-31): RS-cable chunk-mesh crash — a race, only on high-core clients

**Symptom:** client crash, `Encountered exception while building chunk meshes`, whenever
Sodium meshed a chunk containing a Refined Storage cable-family block (plain cable,
importer, exporter, external storage, etc.). Path:

```
CableBakedModel.getQuads → (Guava LoadingCache miss) → RotationTranslationModelBaker.bake
  → ModelBakery$ModelBakerImpl.bake → FFA wrapInnerBake
  → ModelLoadingEventDispatcher.modifyModelBeforeBake / modifyModelAfterBake  → corrupt stack
```

**Three crashes, three exceptions, one race** — all at the same block (85,192,85):

| Time | Exception | Interleaving |
|---|---|---|
| 19:21 | `IndexOutOfBounds: Index (0) >= size (1)` (beforeBake pop) | two threads pop, size desync |
| 19:44 | `ArrayIndexOutOfBounds: Index -1, length 10` (afterBake pop) | concurrent pop drove size < 0 |
| 20:36 | `NullPointerException: context is null` (beforeBake `context.prepare`) | `isEmpty()` passes, another thread pops first, this pop reads a nulled slot |

**Root cause:** a **race condition**, not a missing model. Refined Storage bakes cable
extension models *lazily, at render time*, on Sodium's chunk-builder worker threads.
Forgified Fabric API's `ModelLoadingEventDispatcher` holds four **shared, un-synchronised**
`ObjectArrayList` stacks (instance fields, no `ThreadLocal`) that were only ever meant to
be touched by the main thread during resource reload. Concurrent bakes from multiple
Sodium workers do check-then-act (`isEmpty()` then `pop()`) on those shared stacks and
corrupt them. The three symptoms above are that one bug seen from three angles.

**Why only one player on the server hit it (the important part):** the trigger is
client-side **meshing concurrency**, not the presence of cables — every player had the
same cables for most of their playtime and never crashed. What's different about the
affected client:

1. **24-thread i9-12900K** with Sodium `chunk_builder_threads: 0` (auto). Auto scales with
   core count → a large worker pool → many concurrent *distinct* cable bakes (Guava
   serialises misses on the *same* key, so it's distinct models across workers that collide).
   Low-core machines spawn 2–3 workers and effectively never reach the race threshold.
2. **Framerate uncapped** (after fixing the `maxFps:10` cap). Capped at 10 FPS the workers
   rarely ran simultaneously — which is why the crashes *started* right after uncapping.

**Distant Horizons is an amplifier, not a requirement.** Early theory was that DH's LOD
builder (a second concurrent baker) was needed to trip it. The 20:36 crash **disproved that**:
it fired at `threads=24` with DH *distant generation off* and the region's LODs already
cached. DH raises the hazard rate; Sodium's own worker concurrency alone is sufficient. (DH
`enableRealTimeUpdates` was still on, so not a 100%-clean isolation — but the direction is
clear, and it's the simpler, stronger claim: **Sodium + RS + a multi-core CPU is enough.**)

**It is a probability race, not a state you can reach safely.** After a full restart at
`threads=24`, a streak of cold-cache teleports into the cable mass did *not* crash — then
20:36 did. That's a low-but-nonzero per-unit-time hazard, not "safe until X." `threads=24`
is a time bomb regardless of DH.

**Fix (client-side, the only deterministic one):** set Sodium **Chunk Update / Builder
Threads = 1** (Options → Video Settings → Performance; Reese's Sodium Options exposes it,
applies live). One worker → no concurrent bake → no race. This is a **per-client** setting
for fast/high-core machines — do **not** ship it as a pack default and slow everyone's chunk
loading; low-core players are unaffected and don't want the hit.

**Not fixable by updating mods.** RS 2.0.9 is latest and won't change (lazy baking is
intentional — too many cover/attachment combinations to pre-bake: refinedstorage#3763,
refinedstorage2#1255). Forgified Fabric API / Sinytra closed their side as can't-reproduce
(ForgifiedFabricAPI#221), and the current 1.21.1 FFA source still has the identical racy
shared stacks. The real fix must come from FFA making those context stacks thread-local.

**One-off cleanup vs systemic:** a specific stray cable was at world (85,192,85); removing a
single block only helps until players build more RS infrastructure. The `threads: 1`
client setting is the general answer for anyone on a high-core CPU.

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
