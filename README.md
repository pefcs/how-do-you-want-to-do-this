# How Do You Want To Do This?

**How Do You Want To Do This?** pauses Midi-QoL automatic damage application when a player-character attack would reduce a target from positive HP to 0 or less. The GM receives a prompt and can continue the damage application after describing the target's defeat.

## Behavior

- The trigger is limited to an HP update that would reduce a target from positive HP to 0 or less.
- The resolved attacker must be a player character (a character Actor or an Actor with a player owner).
- Midi-QoL automatic damage application must be enabled. The module recognizes the `yes`, `yesCard`, `yesCardMisses`, and `yesCardNPC` settings.
- NPC attackers do not trigger the prompt.
- The GM can press **Continue** or close the dialog to resume damage application.
- When a player client is applying the damage, it requests the GM's approval over the module socket and resumes when the GM responds.
- If **Polymorph With Overflow** is active and the target is marked as polymorphed, the prompt is skipped so the polymorph HP pool can be depleted normally.

## Settings

- **Enable module** — enables or disables the interception.
- **Prompt text (GM dialog)** — custom text displayed in the GM prompt.
- **DEBUG logs** — writes diagnostic information to the browser console.

## Requirements

- Foundry VTT **14.369–14.999**
- D&D 5e **6.0.6–6.0.999**
- Midi-QoL **14.6.5 or newer compatible release**
- libWrapper

**Optional integration:** Polymorph With Overflow. The module checks for its active state and polymorph flag but does not require it.

## Midi-QoL integration

The module uses the current `midi-qol.preTargetDamageApplication` arguments `(token, { item, workflow, damageItem, ditem })` to associate a target with the attacking workflow.

For the imminent HP update, it uses D&D 5e's `dnd5e.preApplyDamage` hook `(actor, amount, updates, options)`. Midi-QoL 14.6.5 includes the source Actor UUID and item-card UUID in `options.midi`; the explicit source on that damage application is preferred over the short-lived target-attacker cache. This avoids confusing overlapping workflows that damage the same Actor.

## Notes

The module does not decide how a creature dies or alter the damage amount. It only delays the HP update until the GM continues. A manual HP edit or damage application without Midi-QoL source attribution will not be assigned a guessed attacker.
