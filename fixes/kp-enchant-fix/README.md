# Kitchen Projectiles Enchantment Fix (v2, surgical)

## What changed from v1

The first version merged `#farmersdelight:tools/knives` straight into
the shared vanilla tags `#minecraft:enchantable/trident` and
`#minecraft:enchantable/crossbow`. That's the smallest possible diff,
but those tags are shared: Loyalty, Riptide, Channeling, and Impaling
all key off the trident tag; Multishot, Piercing, and Quick Charge all
key off the crossbow tag. Widening the whole tag made all seven show up
as legal on a knife, not just the two that were wanted.

This version is surgical instead: it overrides the three enchantment
definitions themselves (`loyalty.json`, `multishot.json`,
`piercing.json`) so *only those three* recognize the knife. Riptide,
Channeling, Impaling, and Quick Charge go back to trident/crossbow-only,
exactly as vanilla.

## How it works

Two small custom tags do the actual combining, so the enchantment
files never need an unusual "list of items and tags" field - they just
point `supported_items` at a normal single tag, same as vanilla does,
except this one happens to include a second tag as a member:

- `data/kp_enchant_fix/tags/item/trident_or_knives.json` →
  `["minecraft:trident", "#farmersdelight:tools/knives"]`
- `data/kp_enchant_fix/tags/item/crossbow_or_knives.json` →
  `["minecraft:crossbow", "#farmersdelight:tools/knives"]`

Then `loyalty.json`'s `supported_items` points at the first tag, and
`multishot.json`/`piercing.json` point at the second. Every other field
in all three files (costs, weights, effects, slots) is an exact copy of
vanilla 1.21.1 - nothing about how these enchantments work changes,
only which items are allowed to carry them.

## What actually works once attached

- **Loyalty**: fully functional. `ThrownKnife.updateLoyalty()` calls
  `EnchantmentHelper.getTridentReturnToOwnerAcceleration(...)`, the same
  generic method a real trident uses, so the return pull scales with
  level exactly like it would on a trident.
- **Multishot**: fully functional. The release-mixin calls
  `EnchantmentHelper.processProjectileCount(...)` /
  `processProjectileSpread(...)`, the same generic methods a crossbow
  uses, so it throws the extra knives with the correct spread.
- **Piercing**: attaches and costs an anvil combine like any other
  enchantment, but has **no gameplay effect right now**.
  `ThrownKnife.findHitEntity()` is overridden to return `null` once
  `hasDealtDamage()` is true, and `onHitEntity()` sets that flag
  unconditionally on the very first hit - there's no pierce-count
  tracking anywhere in the class, so the knife stops after one target
  regardless of enchantment level. It's included because it was asked
  for, and it's harmless to have sitting on the item, but don't expect
  it to do anything until someone patches `ThrownKnife` itself to track
  remaining pierces (which means mixing into Kitchen Projectiles' own
  class as it's remapped by Sinytra Connector on NeoForge - a heavier
  and more fragile job than this datapack, and not something I'd take
  on speculatively without confirming it's worth it to you first).

## Multishot vs. Piercing

Both still belong to vanilla's `#minecraft:exclusive_set/crossbow`,
which this fix doesn't touch. That means a knife can carry Multishot
*or* Piercing, never both at the same time - identical to how a real
crossbow behaves. Nothing to fix there; it's working as intended.

## The tradeoff, explicitly

Tags merge automatically across packs; enchantment definitions replace
whichever pack loaded last. That means these three files are a frozen
snapshot of Mojang's 1.21.1 values. If a future Minecraft update changes
Loyalty/Multishot/Piercing's costs, weights, or effects, this pack won't
pick that up automatically - it'll need its three JSON files re-diffed
against the new vanilla versions. For a pack pinned to 1.21.1 that's a
non-issue; worth remembering if this modpack ever updates.

## Install

Drop the `.jar` in `mods/` next to Kitchen Projectiles and Farmer's
Delight. No config. `showAsDataPack=true` is set so you can confirm
it's active from the Data Packs screen.
