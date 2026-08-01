package com.example.vpsunshade;

import de.teamlapen.vampirism.api.VReference;
import de.teamlapen.vampirism.api.VampirismAPI;
import dev.ryanhcode.sable.mixinhelpers.entity.sublevels_block_sky.SubLevelsBlockSkyMixinHelper;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;

import java.util.Optional;

/**
 * The actual compat logic. Only ever loaded once {@link VpSunshadeMod} has confirmed both
 * Vampirism and Sable are present.
 *
 * <p>Every {@link #CHECK_INTERVAL_TICKS} ticks, for every real player:
 * <ol>
 *   <li>Cheap filters first: skip spectators / creative-invulnerable players, and skip anyone
 *       who isn't currently a vampire. Vampirism's own sun check is faction-agnostic (it's
 *       shared with hostile vampire mobs), so without this gate we'd also tag non-vampire
 *       players standing under a ship roof — harmless, but pointless, and it'd show a stray
 *       "Sunscreen" icon on a hunter's HUD.</li>
 *   <li>Ask Vampirism's own public API whether this player would currently take sun damage
 *       ({@link VampirismAPI#sundamageRegistry()}). That already accounts for rain, time of
 *       day, per-dimension/per-biome overrides, and the vanilla canSeeSky heightmap check —
 *       we don't want to duplicate any of that logic ourselves.</li>
 *   <li>Only if Vampirism thinks they're exposed do we do the one relatively expensive check:
 *       ask Sable whether a sub-level — an assembled Create Aeronautics vessel, an Offroad
 *       vehicle, or any other Sable-physics contraption — actually occupies the sky above them
 *       right now. This is the exact thing the vanilla-based heightmap check cannot see.</li>
 *   <li>If a sub-level is there, apply Vampirism's own "sunscreen" effect at amplifier 5 — the
 *       same protection level Vampirism's built-in Sunscreen Beacon grants. That's what makes
 *       {@code VampirePlayer#handleSunDamage} cap {@code ticksInSun} at 50 (it never reaches the
 *       100-tick damage / instant-death threshold) and fully skip the periodic Weakness debuff.
 *       Net effect: standing under the ship's roof behaves exactly like standing under a real
 *       one, for as long as you stay there.</li>
 * </ol>
 *
 * <p><b>Known limitation:</b> {@code SubLevelsBlockSkyMixinHelper} is annotated
 * {@code @ApiStatus.Internal} by Sable — it's the real method Sable uses for its own vanilla-mob
 * sun-avoidance fix, but it isn't a committed public contract. If a future Sable release renames
 * or changes the semantics of this method, this class will fail to load (see the guard in
 * {@link VpSunshadeMod}) rather than silently misbehave, but it will need updating.
 */
public class SubLevelSunshadeHandler {

    private static final ResourceLocation SUNSCREEN_ID = ResourceLocation.fromNamespaceAndPath("vampirism", "sunscreen");
    private static final ResourceKey<MobEffect> SUNSCREEN_KEY = ResourceKey.create(Registries.MOB_EFFECT, SUNSCREEN_ID);

    /**
     * Matches the amplifier Vampirism's own SunscreenBeaconBlockEntity grants (amplifier 5 =
     * "Sunscreen VI" in-game). Below amplifier 4, sun damage isn't blocked at all; at amplifier
     * 4 damage is blocked but the periodic Weakness debuff still applies (VampirePlayer checks
     * {@code sunscreen < 5}). Amplifier 5 is required for full parity with genuine physical shade.
     */
    private static final int SUNSCREEN_AMPLIFIER = 5;

    /** Must comfortably outlast {@link #CHECK_INTERVAL_TICKS} so the effect never lapses between checks. */
    private static final int SUNSCREEN_DURATION_TICKS = 100;

    /**
     * Re-check each player every 20 ticks (1 second) instead of every tick.
     * {@code isGettingSundamage} is fairly cheap; the sub-level raycast is not, and neither one
     * needs sub-second precision for something that only ever changes how a slow-moving airship
     * is positioned overhead.
     */
    private static final int CHECK_INTERVAL_TICKS = 20;

    @SubscribeEvent
    public void onPlayerTick(PlayerTickEvent.Post event) {
        Player playerEntity = event.getEntity();
        if (!(playerEntity instanceof ServerPlayer player)) {
            return; // server-authoritative only
        }
        if (player.tickCount % CHECK_INTERVAL_TICKS != 0) {
            return;
        }
        if (player.isSpectator() || player.getAbilities().invulnerable) {
            return;
        }

        // Cheap check first: is this player even a vampire? (see class javadoc for why)
        if (!VampirismAPI.factionPlayerHandler(player).isInFaction(VReference.VAMPIRE_FACTION)) {
            return;
        }

        Level level = player.level();

        // Ask Vampirism itself whether it thinks this player is currently sun-exposed — the
        // exact same public API entry point VampirePlayer uses internally
        // (ISundamageRegistry#isGettingSundamage -> Helper.gettingSundamge -> canBlockSeeSun ->
        // Level#canSeeSky). If Vampirism already thinks they're safe (night, rain, indoors,
        // wrong dimension/biome, already under a real roof, holding an umbrella, near a
        // Sunscreen Beacon, etc.) there is nothing for us to add.
        if (!VampirismAPI.sundamageRegistry().isGettingSundamage(player, level)) {
            return;
        }

        // Vampirism thinks this position is open sky. Ask Sable whether a sub-level is actually
        // overhead right now — the one thing the vanilla heightmap check can't see. Mirrors the
        // exact eye-position BlockPos formula Helper.gettingSundamge itself uses internally, so
        // we're testing the same point Vampirism just tested.
        BlockPos eyePos = new BlockPos(player.getBlockX(), player.getBlockY() + (int) player.getEyeHeight(), player.getBlockZ());

        if (SubLevelsBlockSkyMixinHelper.checkSkyWithSublevels(level, eyePos)) {
            applySunscreen(player);
        }
        // else: genuinely exposed, no sub-level overhead — let Vampirism handle it normally.
    }

    private void applySunscreen(ServerPlayer player) {
        Optional<Holder.Reference<MobEffect>> sunscreen = BuiltInRegistries.MOB_EFFECT.getHolder(SUNSCREEN_KEY);
        sunscreen.ifPresent(holder ->
                player.addEffect(new MobEffectInstance(holder, SUNSCREEN_DURATION_TICKS, SUNSCREEN_AMPLIFIER, true, false))
        );
    }
}
