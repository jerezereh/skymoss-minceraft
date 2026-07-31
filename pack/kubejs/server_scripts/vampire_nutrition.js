// Listen to the player tick event server-side
PlayerEvents.tick(event => {
    const player = event.player;
    
    // Only run once every 20 ticks (1 second) to maintain high performance
    if (player.age % 20 !== 0) return;

    // Fetch the player's NBT data
    let nbt = player.nbt;
    if (!nbt) return;

    // Check if Vampirism data exists and if the player is in Faction 1 (Vampire)
    // In 1.21+, Vampirism data is nested within Forge/NeoForge capabilities/attachments
    if (nbt.contains('vampirism') && nbt.getCompound('vampirism').getInt('faction') === 1) {
        
        // Target the Nutritional Balance NBT structure
        // Note: Check your world's playerdata files if Nutritional Balance uses a different sub-tag identifier
        if (nbt.contains('nutritionalbalance:nutrition')) {
            let nutritionData = nbt.getCompound('nutritionalbalance:nutrition');
            
            // List of default nutrient categories tracked by Nutritional Balance
            let categories = ['protein', 'carbohydrate', 'fat', 'vegetable', 'fruit'];
            
            // Overwrite categories to 0.5 (the 50% neutral target baseline)
            categories.forEach(category => {
                nutritionData.putDouble(category, 0.75);
            });
            
            // Merge the modified NBT back into the live player object
            player.mergeNbt(nbt);
        }
    }
});
