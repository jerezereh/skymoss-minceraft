package com.kpslotfix.kpslotfix;

import com.mojang.logging.LogUtils;
import net.neoforged.fml.common.Mod;
import org.slf4j.Logger;

// The value here must match the modId in META-INF/neoforge.mods.toml
@Mod(KpSlotFix.MODID)
public class KpSlotFix {
    public static final String MODID = "kp_slot_fix";
    public static final Logger LOGGER = LogUtils.getLogger();

    public KpSlotFix() {
        // KnifeSlotFixHandler is registered automatically via @EventBusSubscriber;
        // nothing else needs to happen here.
        LOGGER.info("Kitchen Projectiles Slot Fix loaded.");
    }
}
