package com.kpslotfix.kpslotfix;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.Projectile;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;

import java.lang.reflect.Field;

/**
 * Kitchen Projectiles' ThrownKnife constructor tries to find which inventory
 * slot a knife was thrown from by scanning the player's inventory and
 * comparing item stacks with {@code ==}. But the mixin that constructs it
 * (ItemMixin#throwRelease) always calls {@code itemStack.copyWithCount(1)}
 * first - even with no Multishot involved, since the loop runs at least once
 * with a base projectile count of 1 - and hands that fresh copy to the
 * constructor. A copy is never reference-equal to whatever's still sitting
 * in the inventory, so the scan never matches, and the entity's private
 * `slot` field is left at its constructor default of -1. That makes
 * ThrownKnife#tryPickup fall back to "insert into any free slot" instead of
 * returning the knife to the slot (including the offhand) it came from.
 *
 * Rather than trying to intercept the mixin-woven release method or the
 * constructor itself (either of which means targeting bytecode inside a
 * class loaded through the Sinytra Connector, which is more fragile to get
 * right blind), this reacts after the fact: at the moment the knife entity
 * joins the level, its owner and the hand that was used to throw it are
 * both still valid, ordinary public state. That's enough to compute the
 * *correct* slot directly - no stack-reference matching needed at all.
 */
@EventBusSubscriber(modid = KpSlotFix.MODID)
public final class KnifeSlotFixHandler {

    // Kitchen Projectiles registers its thrown-knife entity as "kitchenprojectiles:knife".
    private static final ResourceLocation KNIFE_ID = ResourceLocation.parse("kitchenprojectiles:knife");

    private static volatile Field slotField;
    private static volatile boolean lookupFailed = false;

    @SubscribeEvent
    public static void onEntityJoin(EntityJoinLevelEvent event) {
        if (event.getLevel().isClientSide()) return;

        Entity entity = event.getEntity();
        if (!KNIFE_ID.equals(BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()))) return;

        // ThrownKnife extends AbstractArrow extends Projectile, all vanilla types.
        if (!(entity instanceof Projectile projectile)) return;
        if (!(projectile.getOwner() instanceof Player player)) return;

        Field field = slotField(entity.getClass());
        if (field == null) return;

        try {
            if (field.getInt(entity) >= 0) return; // already correctly tracked somehow; leave it alone

            Inventory inventory = player.getInventory();
            boolean thrownFromOffhand = player.getUsedItemHand() == InteractionHand.OFF_HAND;
            field.setInt(entity, thrownFromOffhand ? Inventory.SLOT_OFFHAND : inventory.selected);
        } catch (IllegalAccessException ignored) {
            // Field turned out not to be settable for some reason; worst case is
            // the original (broken) fallback-to-any-free-slot behavior remains.
        }
    }

    private static Field slotField(Class<?> knifeClass) {
        if (lookupFailed) return null;
        Field cached = slotField;
        if (cached != null) return cached;
        try {
            Field field = knifeClass.getDeclaredField("slot");
            field.setAccessible(true);
            return slotField = field;
        } catch (ReflectiveOperationException e) {
            lookupFailed = true;
            return null;
        }
    }
}
