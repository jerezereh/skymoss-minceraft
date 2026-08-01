package com.example.vpsunshade;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Bridges a gap between Vampirism and Sable (the physics engine behind Create Aeronautics /
 * Create: Simulated / Create: Offroad).
 *
 * <p>Root cause (see project README for the full writeup): Vampirism decides whether a vampire
 * is "in sunlight" using {@code net.minecraft.world.level.Level#canSeeSky}, the vanilla
 * heightmap check. Sable's assembled contraptions ("sub-levels") are not real blocks in the
 * main Level's chunk data, so that heightmap never sees them — a vampire standing directly
 * under a solid airship roof is still treated as fully sun-exposed. Sable already patches this
 * exact gap for vanilla undead mobs ({@code Mob}, {@code FleeSunGoal}, {@code GroundPathNavigation})
 * via a mixin, but that mixin only rewrites call sites physically inside those three vanilla
 * classes — it has no effect on Vampirism's own, separate sun check living in
 * {@code de.teamlapen.vampirism.util.Helper}. This mod closes that specific remaining gap.
 *
 * <p>This class intentionally imports nothing from Vampirism or Sable. All of that code lives in
 * {@link SubLevelSunshadeHandler}, which is only ever loaded (via {@code new SubLevelSunshadeHandler()}
 * below) once both mods are confirmed present. That way this mod is a true optional/soft
 * dependency on both — installed alone, or with only one of the two, it simply does nothing.
 */
@Mod(VpSunshadeMod.MODID)
public class VpSunshadeMod {

    public static final String MODID = "vpsunshade";
    private static final Logger LOGGER = LoggerFactory.getLogger("vpsunshade");

    private static final String VAMPIRISM_MODID = "vampirism";
    private static final String SABLE_MODID = "sable";

    public VpSunshadeMod(IEventBus modEventBus) {
        boolean vampirismLoaded = ModList.get().isLoaded(VAMPIRISM_MODID);
        boolean sableLoaded = ModList.get().isLoaded(SABLE_MODID);

        if (vampirismLoaded && sableLoaded) {
            NeoForge.EVENT_BUS.register(new SubLevelSunshadeHandler());
            LOGGER.info("[vpsunshade] Vampirism + Sable both detected — sub-level sunshade bridge active.");
        } else {
            LOGGER.info(
                    "[vpsunshade] Inactive: vampirism loaded={}, sable loaded={}. Both are required; " +
                            "this mod does nothing on its own.",
                    vampirismLoaded, sableLoaded
            );
        }
    }
}
