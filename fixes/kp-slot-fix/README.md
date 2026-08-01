# Kitchen Projectiles Slot Fix

## The bug

`ItemMixin#throwRelease` always does this, even with no Multishot involved
(the loop runs at least once with a base count of 1):

```java
var projectileStack = itemStack.copyWithCount(1);
var knifeEntity = new ThrownKnife(level, playerEntity, projectileStack);
```

`ThrownKnife`'s constructor then tries to find the slot the knife was
thrown from like this:

```java
for (int iSlot = 0; iSlot < size; iSlot++)
    if (inventory.getItem(iSlot) == stack) {
        slot = iSlot;
        break;
    }
```

`stack` here is `projectileStack` - a fresh copy. `copyWithCount` always
calls `.copy()` internally regardless of whether the count already matches,
so `projectileStack` is never the same object reference as whatever's
actually sitting in the inventory. The `==` check can never succeed, `slot`
is left at its constructor default of `-1`, and `tryPickup` falls back to
"insert into any free slot" instead of the slot (including the offhand)
the knife actually came from. This isn't a NeoForge/Connector-specific
problem - it would happen on Fabric too, since it's pure Java logic with
no loader-specific code involved.

## The fix

Patching this at the source would mean intercepting either the mixin-woven
`Item#releaseUsing` (which merges vanilla's logic with Kitchen Projectiles'
own injected code, making the correct target bytecode harder to pin down
without a live environment to test against) or redirecting the
`new ThrownKnife(...)` call inside it. Both are real mixin work against a
class loaded through the Sinytra Connector, which is exactly the kind of
cross-loader mixin target I didn't want to guess at blind.

Instead, this reacts after the entity already exists. At the moment a
`ThrownKnife` joins the level (`EntityJoinLevelEvent`), its owner and the
hand that was used to throw it (`LivingEntity#getUsedItemHand()`) are both
still valid, ordinary public state - nothing about them depends on the
broken reference match. That's enough to compute the *correct* slot
directly:

- Mainhand throw → the owner's currently selected hotbar slot
  (`Inventory#selected`)
- Offhand throw → the fixed offhand slot (`Inventory#SLOT_OFFHAND`)

...and write it into the entity's private `slot` field via reflection.
The entity is identified purely by its registered id
(`kitchenprojectiles:knife`), and the whole thing backs off harmlessly if
that id or the `slot` field isn't found, so there's no hard compile-time
or runtime dependency on Kitchen Projectiles at all - just an optional one
declared in `neoforge.mods.toml` for load-ordering purposes.

If `slot` is ever found to already be `>= 0` (e.g. a future Kitchen
Projectiles release fixes this upstream), this fix does nothing and gets
out of the way.

## Why you're getting source, not a jar

I can't compile this myself in the sandbox I have access to - it has no
network path to Mojang's or NeoForge's Maven repositories, so Gradle can't
resolve `net.neoforged:neoforge` or any Minecraft artifact at all, and
there's no local copy of those jars to compile against either.

What I *could* do, and did: install a JDK and hand-write minimal stub
classes matching every real method signature this code calls
(`BuiltInRegistries.ENTITY_TYPE.getKey(...)`, `ResourceLocation.parse(...)`,
`Player#getInventory()`, `LivingEntity#getUsedItemHand()`,
`Projectile#getOwner()`, `EntityJoinLevelEvent#getLevel()/getEntity()`,
the `@Mod`/`@EventBusSubscriber`/`@SubscribeEvent` annotations, and so on),
each one pulled from either the official NeoForge 1.21 MDK template, the
1.21.1-matched NeoForge javadocs, or Kitchen Projectiles' own source. The
real source in `src/main/java` compiles clean against those stubs with zero
errors - so the logic and every method/field name here should be correct.
The only thing I genuinely cannot verify without your own toolchain is
linking against the *real* jars, which needs your actual network access to
NeoForge's Maven.

## Building it

You'll already have everything this needs, given you're set up for NeoForge
mod development:

```
./gradlew build
```

The output jar lands in `build/libs/kp_slot_fix-1.0.0.jar`. Drop that in
`mods/` next to Kitchen Projectiles and Farmer's Delight.

`neo_version` in `gradle.properties` is pinned to `21.1.172`, a real,
published 1.21.1 NeoForge release. If Gradle can't resolve it (e.g. it's
been pulled from the Maven), bump it to any other `21.1.x` release - point
releases within 1.21.1 are drop-in compatible for something this small.

## Testing it

Throw a knife from a hotbar slot with that slot now empty, walk over the
returning/landed knife, confirm it goes back to that exact slot. Then do
the same from the offhand. If Multishot is enabled, only the middle knife
should be picked up (that part was already correct) and it should also
return to the original slot now.
