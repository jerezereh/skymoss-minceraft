# Slimekin — a NeoOrigins slime origin

Built against **NeoOrigins** (CyberDay1's NeoForge port), **1.21.1**, using native
`neoorigins:` 2.0 power types.

## Install

Drop the `slimekin` folder into `originpacks/` in your game/instance directory
(not `world/datapacks/`). `/reload` or rejoin, then pick **Slimekin** from the
origin screen or reroll with an Orb of Origin.

## Powers

| Power | Effect |
|---|---|
| Verdant Hide | Green skin tint, and now genuinely translucent (`alpha: 0.65`). |
| Boneless | Zero fall damage, always. |
| Elastic Landing | Hold sneak as you fall and landing bounces you back up like a slime block. Land normally otherwise. |
| Gooey Resilience | −15% incoming damage. |
| Soft Strikes | −15% outgoing damage. |
| **Flammable** | **+50% damage from fire, lava, and heat** (`#minecraft:is_fire`). |
| Acidic Residue | Reflects 10% of any hit back at the attacker — grows to 25% (see below). |
| Splitting Instinct | Fatal blows shrink you instead of killing you. |
| Reconstitution | Soak in water or rain to regrow. |

## This revision

- **Removed Springy Legs.** Permanent Jump Boost was compounding with Elastic
  Landing's bounce in ways that made landings launch much higher than intended.
  Elastic Landing on its own still carries the "bouncy" identity.
- **Elastic Landing is now opt-in, not opt-out.** The sneak check is inverted:
  sneaking *while falling* triggers the slime-block bounce; a normal landing
  (not sneaking) is just a normal landing. This also happens to be most of why
  bounces felt excessive — every ordinary landing was bouncing before, and now
  only the ones you ask for do.
- **Verdant Hide is now actually translucent.** `model_color`'s `alpha` field
  multiplies the skin texture's alpha channel (it was sitting at `1.0`, fully
  opaque, despite the old description already saying "translucent"). It's
  `0.65` now — visibly see-through without going full ghost.

## The two bugs from the previous version

**Raw text like `power.slimekin.acidic_residue.name` in the GUI.** A plain string
in a `name` field is treated as a *translation key*, and the lang file lived in
`assets/` — which never loads, because `originpacks/` are read server-side as data
only. Every name and description is now written inline in the power JSON itself,
matching the convention in the Slimeling pack you sent. There's no lang file
anymore and nothing to resolve, so the text can't go missing again.

**Starting smaller than normal without having died.** This was the real bug. I had
gated two `size_scaling` powers behind `power_condition`, but NeoOrigins explicitly
never gates lifecycle methods — `onGranted` runs regardless of the condition. So
both shrink powers applied themselves the instant the origin was granted and the
gate did nothing.

Size and max health are now applied by `attribute_modifier` powers instead
(`generic.scale` and `generic.max_health`), whose `condition` field is documented
as *tick-driven apply/remove* — no lifecycle bypass. With both split flags
defaulting to false, nothing applies at spawn. A `reset_on_respawn` power also
force-clears both flags and the regrowth bar on every real respawn, so a genuine
death always returns you to full size and 10 hearts.

## Splitting and Reconstitution

| State | Size | Max health |
|---|---|---|
| Whole | 100% | 10 hearts |
| First fatal blow | 75% | 7 hearts |
| Second fatal blow | 50% | 4 hearts |
| Third fatal blow at 50% | — | real death, then respawn whole |

Each save leaves you at 3 hearts and **extinguishes you** — worth having, since
`prevent_death` only cancels the lethal event without clearing the damage source,
and you now take extra fire damage. Without it, burning to death would just
re-kill you on the next tick and burn through both splits in about a second.

**Regrowing:** while split *and* standing in water or out in the rain, a
**Reconstitution** bar fills at 4%/second — 25 seconds per size step, so ~50
seconds from smallest back to whole. Each time it fills you go up one step and
heal 6 HP to fill the hearts you just got back. The bar only appears while you're
actually split.

## Evolution tiers (kill-based)

Only Acidic Residue scales now — Gooey Resilience and Soft Strikes are back to a
flat 15% as in the first draft.

| Tier | Kills (default) | Acidic Residue |
|---|---|---|
| Base | 0 | 10% reflected |
| 1 — Evolved | 1,000 | 15% |
| 2 — Ascended | 2,500 | 20% |
| 3 — Apex | 5,000 | 25% |

Thresholds are server config (`config/neoorigins/gameplay.toml`), not set by this
pack. The player gets an [EVOLVE]/[DECLINE] prompt at each one.

## Tuning

All under `data/slimekin/origins/powers/`:

- `verdant_hide.json` — `alpha: 0.65`. Lower = more see-through; `1.0` is fully
  opaque. `red`/`green`/`blue` only ever darken, so if the tint reads muddy,
  raise them rather than lower them.
- `slime_bounce.json` — `y: 0.55` is the bounce strength; the `condition` is
  what makes it sneak-gated at all — remove that block entirely to go back to
  bouncing on every landing.
- `flammable.json` — `multiplier: 1.5`. Matches the +50% on the Slimeling pack's
  own Flammable and the magnitude NeoOrigins' docs use for fire-weak origins.
- `gooey_resilience.json` / `soft_strikes.json` — the `0.85` multipliers.
- `acidic_residue*.json` (4 files) — `amount_ratio` per tier.
- `regrowth_soak.json` — `change: 4` per 20-tick interval sets the soak speed.
- `medium_form_size` / `small_form_size` — `-0.25` / `-0.50` off a base scale of 1.0.
- `medium_form_health` / `small_form_health` — `-6` / `-12` off a base of 20.
- `split_on_death.json` — `set_health: 6.0` after each save.

## Two things worth eyeballing in-game

- **`minecraft:generic.scale`** — 1.21.1 uses the `generic.`-prefixed attribute
  names (NeoOrigins shipped a fix specifically for this), so that's what I used. If
  you ever port this pack forward to 1.21.2+, the short form `minecraft:scale` is
  the one that applies there.
- **`model_color`** — it multiplies your skin's RGB channels, so it can only ever
  darken. If the green reads muddy on your skin, raise `red` and `blue` toward `1.0`.
