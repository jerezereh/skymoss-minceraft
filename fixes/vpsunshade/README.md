# Vampirism × Sable Sunshade

Fixes: Vampirism vampires take sun damage even when standing under the solid roof of an
assembled Create Aeronautics (or Offroad / Simulated) vessel.

## Can this be fixed with a config file alone? No.

Neither mod exposes a config option for this, and it isn't a config-shaped problem — it's a
genuine gap between how the two mods query the world. Short version of the investigation below;
both mods' actual source was cloned and read to confirm this rather than guessed.

## How Vampirism's sunburn check actually works

Source: `TeamLapen/Vampirism`, `de.teamlapen.vampirism.util.Helper`.

```java
public static boolean gettingSundamge(LivingEntity entity, LevelAccessor world, ...) {
    if (world instanceof Level level && !level.isRaining()
            && VampirismAPI.sundamageRegistry().hasSunDamage(world, entity.blockPosition())
            && isDay(world)) {
        BlockPos pos = new BlockPos(entity.getBlockX(), entity.getBlockY() + (int) entity.getEyeHeight(), entity.getBlockZ());
        return canBlockSeeSun(world, pos) && !LevelFog.get(level).isInsideArtificialVampireFogArea(pos);
    }
    return false;
}

public static boolean canBlockSeeSun(LevelAccessor world, BlockPos pos) {
    if (pos.getY() >= world.getSeaLevel()) {
        return world.canSeeSky(pos);   // <-- the vanilla heightmap check
    }
    ...
}
```

`Level#canSeeSky` is a heightmap lookup against the real world's chunk data. Vampirism (like
vanilla zombies/skeletons) never raycasts — it just asks "is there a real block above this
column." Actual damage/effects then run in `VampirePlayer#handleSunDamage`, driven by a
`ticksInSun` ramp (0→100) and a `sunscreen` `MobEffectInstance` amplifier that can reduce or
fully suppress it — this is exactly the mechanism Vampirism's own built-in Sunscreen Beacon
block uses (grants amplifier 5, which caps `ticksInSun` at 50 forever and disables the periodic
Weakness debuff too).

## How Create Aeronautics vessels actually work

This was the bigger surprise. "Create Aeronautics" is not vanilla Create's simple kinematic
`Contraption`/`AbstractContraptionEntity` system with blocks stored in a local map. It's built on
**Sable** (`ryanhcode/sable`), a separate mod that gives assembled physics contraptions their own
real **sub-level** — `dev.ryanhcode.sable.sublevel.SubLevel` / `ServerSubLevel` — driven by an
actual physics engine (Rapier3D). Blocks on a ship are real blocks in that sub-level, transformed
into world space each frame based on the sub-level's current physics pose.

Crucially, Sable already ran into this exact sun-check problem for **vanilla** mobs, and fixed
it. From `dev.ryanhcode.sable.mixin.entity.sublevels_block_sky.SubLevelsBlockSkyMixin`:

```java
@Mixin({Mob.class, FleeSunGoal.class, GroundPathNavigation.class})
public class SubLevelsBlockSkyMixin {
    @WrapOperation(method = "*", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/level/Level;canSeeSky(Lnet/minecraft/core/BlockPos;)Z"))
    private boolean sable$subLevelsBlockSky(Level instance, BlockPos pos, Operation<Boolean> original) {
        boolean canSeeOriginal = original.call(instance, pos);
        if (canSeeOriginal && pos.getY() < instance.getMaxBuildHeight()) {
            if (SubLevelsBlockSkyMixinHelper.checkSkyWithSublevels(instance, pos)) return false;
        }
        return canSeeOriginal;
    }
}
```

And the actual check, in `SubLevelsBlockSkyMixinHelper`, is a vertical raycast from the position
up to build height using a special `ClipContext` flag (`sable$setIgnoreMainLevel(true)`) that
routes specifically through sub-level collision:

```java
public static boolean checkSkyWithSublevels(Level level, BlockPos pos) {
    Vec3 start = Vec3.atBottomCenterOf(pos);
    ClipContext context = new ClipContext(start, new Vec3(start.x, level.getMaxBuildHeight(), start.z),
            ClipContext.Block.COLLIDER, ClipContext.Fluid.ANY, CollisionContext.empty());
    ((ClipContextExtension) context).sable$setIgnoreMainLevel(true);
    return level.clip(context).getType() != HitResult.Type.MISS;
}
```

## The actual gap

`@Mixin({Mob.class, FleeSunGoal.class, GroundPathNavigation.class})` is a **bytecode-level**
patch: Mixin's `@WrapOperation` only rewrites `canSeeSky` call sites that are physically located
inside those three named vanilla classes. Vampirism's check lives in its own
`de.teamlapen.vampirism.util.Helper` class — a completely different call site that Sable's mixin
never touches. So: a zombie standing under your airship's roof correctly won't burn (Sable's fix
covers it), but a vampire standing in the exact same spot still takes full sun damage, because
Vampirism is asking the same vanilla question from a class Sable was never told to patch.

Extending Sable's own fix to also cover Vampirism is exactly what this mod does — using the
same `SubLevelsBlockSkyMixinHelper.checkSkyWithSublevels` check Sable already relies on, applied
at the one place Vampirism exposes an equivalent public hook.

## What this mod does

No mixins, no reflection into either mod's internals beyond one already-existing helper method.
Every 20 ticks, for every player who is currently a vampire:

1. Ask Vampirism's public addon API (`VampirismAPI.sundamageRegistry().isGettingSundamage(...)`)
   whether it currently thinks the player is sun-exposed.
2. If yes, ask Sable's own sub-level sky-check (the same one above) whether a sub-level is
   actually overhead.
3. If a sub-level is there, apply Vampirism's own `vampirism:sunscreen` effect at amplifier 5 —
   identical to what its built-in Sunscreen Beacon grants, which fully suppresses damage and the
   Weakness debuff for as long as it's refreshed.

The two source files are small on purpose:

- `VpSunshadeMod.java` — the `@Mod` entry point. Contains **zero** imports from Vampirism or
  Sable, and only ever loads `SubLevelSunshadeHandler` if `ModList.get().isLoaded(...)` confirms
  both are present. This is what makes it a true optional/soft dependency on both — install this
  alongside just one of the two, or neither, and it quietly does nothing instead of crashing.
- `SubLevelSunshadeHandler.java` — the actual logic described above.

Because the check is implemented at the Sable layer, it isn't actually limited to Aeronautics
specifically — it applies to *any* Sable-physics contraption with a solid roof (Offroad vehicles,
raw Simulated physics assemblies, etc.), which is the correct scope since that's where the
sky-check logic actually lives.

## Setup

**Version pins are set to match a confirmed real environment:** Minecraft 1.21.1, NeoForge
21.1.241, Vampirism 1.21-1.10.12 (confirmed live on CurseForge, published Jul 4 2026, NeoForge),
Sable 2.0.3 for mc1.21.1 (confirmed via GitHub releases). If your own versions differ, just
update the corresponding line in `gradle.properties`.

1. Unzip, then from a terminal inside the `vpsunshade` folder run `./gradlew build` (Mac/Linux)
   or `gradlew.bat build` (Windows). The Gradle wrapper (including `gradle-wrapper.jar`) is bundled
   in this zip, so you don't need Gradle installed yourself — just a JDK 21. The wrapper will
   download Gradle 9.5.0 itself on first run.
   This step needs network access to `maven.maxanier.de`, `maven.ryanhcode.dev`, and
   `maven.neoforged.net` on *your* machine — none of those were reachable from the sandboxed
   environment this was written in, so **this has still not been compiled or run**; treat it as a
   carefully-researched draft to build and iterate on, not a guaranteed first-try success.
2. The built jar lands at `build/libs/vpsunshade-1.0.0.jar`. Copy that one file into your
   instance's `mods` folder, alongside Vampirism, Sable, and Create Aeronautics.

## Honest caveats

- `SubLevelsBlockSkyMixinHelper` is marked `@ApiStatus.Internal` by Sable's own author — it's not
  a committed public contract, just the real method Sable uses for its own fix. If a future Sable
  release renames or reworks it, this mod's class will fail to load cleanly (guarded, so it just
  goes inactive) rather than misbehave silently, but it'll need a small update.
- The Sable Maven artifact *coordinate shape* (`sable-<loader>-<mc_version>:<version>`) is now
  confirmed against Sable's own published wiki documentation, not just inferred — that specific
  uncertainty from the first draft is resolved. What's still unverified is everything downstream
  of "does this compile" — I have not run a build.
- This was built by reading the real, current source of Vampirism, Simulated/Aeronautics, and
  Sable — not from general training knowledge about Minecraft modding, since the specific
  mechanism (a physics-engine sub-level, not a normal Create contraption) isn't something a
  generic answer would have guessed correctly.
- I could not compile or test this in the sandbox I wrote it in (no network route to the Minecraft
  mod-loader Maven repos), so please treat first build/runtime errors as normal iteration, not a
  sign the underlying approach is wrong — the API calls themselves were all verified against real
  source, not guessed. The Vampirism-side API (`ISundamageRegistry`, `IFactionPlayerHandler`,
  `VReference`) was verified against the `version/1.21/latest` branch HEAD, which is at or very
  close to 1.10.12; I could not get the specific 1.10.12 changelog to confirm zero changes to
  these exact classes, but patch releases breaking long-stable, `@Deprecated`-not-removed addon
  API is not this project's pattern.
