# Changelog

## 2.0.1

- Updated `midi-qol.preTargetDamageApplication` to Midi-QoL 14.6.5's current `(token, { item, workflow, damageItem, ditem })` arguments.
- Replaced the nonexistent `midi-qol.preApplyDamage` listener with D&D 5e's `dnd5e.preApplyDamage(actor, amount, updates, options)` hook.
- Capture source Actor and item-card/workflow identity from the current Midi damage options.
- Prefer the explicit source Actor UUID for the current damage application over the shared last-attacker cache, improving attribution when multiple workflows target the same Actor.
- Removed obsolete workflow target resolution and global last-workflow/combatant fallbacks that could guess the wrong attacker.
- Updated compatibility metadata and documentation for the Foundry V14 / D&D 5e 6.0.x / Midi-QoL 14.6.5 target environment.

## 2.0.0

- Repository baseline retained as the authoritative source for this release.
