const MODULE_ID = "how-do-you-want-to-do-this";
const SOCKET = `module.${MODULE_ID}`;

const BYPASS_FLAG = Symbol(`${MODULE_ID}-bypass`);
const IN_PROGRESS = new Set();

const LAST_ATTACKER = new Map();
const ATTACKER_TTL = 15000;

const LETHAL_SESSIONS = new Map();
const SESSION_TTL = 30000;

const ACTOR_SESSION = new Map();

const getProp = (obj, path) => {
  const fu = globalThis.foundry?.utils;
  if (fu?.getProperty) return fu.getProperty(obj, path);
  // v12- kompat fallback (elkerülhetetlen, ha régi core fut)
  // eslint-disable-next-line no-undef
  return globalThis.getProperty ? globalThis.getProperty(obj, path) : undefined;
};								
function dbg(...args) {
  if (!game.settings?.get(MODULE_ID, "debug")) return;
  try { console.log(`%c[${MODULE_ID}]`, "color:#7bd;font-weight:bold", ...args); }
  catch { console.log(`[${MODULE_ID}]`, ...args); }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable module", scope: "world", config: true, default: true, type: Boolean
  });
  game.settings.register(MODULE_ID, "promptText", {
    name: "Prompt text (GM dialog)",
    hint: "Text shown to the GM when a target would drop to 0 HP.",
    scope: "world", config: true, default: "How do you want to do this?", type: String
  });
  game.settings.register(MODULE_ID, "debug", {
    name: "DEBUG logs", scope: "world", config: true, default: false, type: Boolean
  });

  game.socket?.on(SOCKET, async data => {
    if (!game.user.isGM) return;
    if (!data || data.action !== "REQUEST_CONTINUE") return;
    const { requestId, actorId } = data;
    dbg("Socket REQUEST_CONTINUE received", { requestId, actorId });
    try {
      await showGMDialog(actorId);
      dbg("Dialog resolved; emitting CONTINUE", { requestId });
      game.socket.emit(SOCKET, { action: "CONTINUE", requestId });
    } catch (e) {
      console.error(`${MODULE_ID} | Dialog error`, e);
      game.socket.emit(SOCKET, { action: "CONTINUE", requestId });
    }
  });
});

Hooks.once("ready", () => {
  if (!game.modules.get("midi-qol")?.active) {
    ui.notifications?.error("How do you want to do this: Midi-QoL is required and must be active.");
    console.error(`[${MODULE_ID}] Midi-QoL is not active → aborting.`);
    return;
  }
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.error("How do you want to do this: libWrapper is required and must be active.");
    console.error(`[${MODULE_ID}] libWrapper is not active → aborting.`);
    return;
  }

  Hooks.on("midi-qol.preTargetDamageApplication", (workflow, targetTokenDoc) => {
    try {
      const attacker = workflow?.actor ?? workflow?.item?.parent ?? workflow?.token?.actor;
      const targetActorId = targetTokenDoc?.actor?.id ?? targetTokenDoc?.actorId ?? targetTokenDoc?.actor?.id;
      const wfId = workflow?.id ?? workflow?.uuid;
      if (attacker && targetActorId) {
        LAST_ATTACKER.set(targetActorId, { attacker, ts: Date.now(), by: "preTargetDamageApplication", wfId });
        dbg("Remember attacker (preTargetDamageApplication)", { targetActorId, attackerName: attacker?.name, attackerType: attacker?.type, wfId });
      }
    } catch {}
  });

  Hooks.on("midi-qol.preApplyDamage", (workflow) => {
    try {
      const attacker = workflow?.actor ?? workflow?.item?.parent ?? workflow?.token?.actor;
      const wfId = workflow?.id ?? workflow?.uuid;
      const targets = resolveTargetActorsFromWorkflow(workflow);
      for (const tActor of targets) {
        LAST_ATTACKER.set(tActor.id, { attacker, ts: Date.now(), by: "preApplyDamage", wfId });
        dbg("Remember attacker (preApplyDamage)", { targetActorId: tActor.id, attackerName: attacker?.name, attackerType: attacker?.type, wfId });
      }
    } catch {}
  });

  Hooks.on("updateCombat", () => { pruneAttackers("updateCombat"); pruneSessions("updateCombat"); });
  Hooks.on("deleteCombat", () => { pruneAttackers("deleteCombat"); pruneSessions("deleteCombat"); });
  setInterval(() => { pruneAttackers("interval"); pruneSessions("interval"); }, 10000);

  dbg("Ready. Registering Actor.update wrapper.");

  libWrapper.register(
    MODULE_ID,
    "CONFIG.Actor.documentClass.prototype.update",
    async function (wrapped, data = {}, options = {}) {
      try {
        if (!game.settings.get(MODULE_ID, "enabled")) return await wrapped.call(this, data, options);

        const newHP = getProp(data, "system.attributes.hp.value");
        const currentHP = getProp(this, "system.attributes.hp.value");
        dbg("Actor.update intercepted", {
          actorId: this.id, name: this.name, type: this.type,
          currentHP, newHP, optionsKeys: Object.keys(options ?? {}), inProgress: IN_PROGRESS.has(this.id)
        });

        if (options[BYPASS_FLAG]) { dbg("Bypass flag → wrapped"); return await wrapped.call(this, data, options); }
        if (game.system?.id !== "dnd5e") { dbg("Not dnd5e → pass"); return await wrapped.call(this, data, options); }

        if (newHP === undefined || newHP === null || typeof currentHP !== "number") {
          dbg("HP not in update → pass"); return await wrapped.call(this, data, options);
        }
        const willDropToZero = currentHP > 0 && newHP <= 0;
        dbg("Drop check", { willDropToZero });
        if (!willDropToZero) return await wrapped.call(this, data, options);

        const midiCheck = midiAutoApplyInfo();
        dbg("Midi auto-apply check", midiCheck);
        if (!midiCheck.enabled) { dbg("Auto-apply not enabled → pass"); return await wrapped.call(this, data, options); }

        const { attacker: killer, wfId } = resolveAttackerForTarget(this.id, options) ?? {};
        dbg("Killer resolved", {
          found: !!killer, killerName: killer?.name, killerType: killer?.type,
          killerHasPlayerOwner: killer?.hasPlayerOwner, wfId
        });
        const killerIsPC = !!killer && (killer.type === "character" || killer.hasPlayerOwner === true);
        if (!killerIsPC) { dbg("Killer not PC / not found → pass"); return await wrapped.call(this, data, options); }

        const sessionKey = (wfId && `wf:${wfId}`) || `atk:${killer?.id}:r${game.combat?.round ?? 0}t${game.combat?.turn ?? 0}`;

        const existingKey = ACTOR_SESSION.get(this.id);
        if (existingKey) {
          const sess = LETHAL_SESSIONS.get(existingKey);
          if (sess) {
            dbg("Target already assigned to session → waiting", { actorId: this.id, sessionKey: existingKey });
            await sess.promise;
            const nextOptions = { ...options, [BYPASS_FLAG]: true };
            dbg("Resuming after existing session", { actorId: this.id, sessionKey: existingKey });
            return await wrapped.call(this, data, nextOptions);
          } else {
            ACTOR_SESSION.delete(this.id);
          }
        }

        let session = LETHAL_SESSIONS.get(sessionKey);
        const isFirstInSession = !session;
        if (isFirstInSession) {
          session = createDeferred();
          LETHAL_SESSIONS.set(sessionKey, session);
          dbg("Created lethal session", { sessionKey });
        } else {
          dbg("Joining existing lethal session", { sessionKey });
        }

        ACTOR_SESSION.set(this.id, sessionKey);

        IN_PROGRESS.add(this.id);

        try {
          if (isFirstInSession) {
            dbg("Pause engaged; awaiting GM approval (first in session)", {
              targetId: this.id, targetName: this.name, killer: killer?.name, sessionKey, gm: game.user.isGM
            });
            if (game.user.isGM) await showGMDialog(this.id);
            else await requestGMApproval(this.id);

            dbg("Resolving lethal session", { sessionKey });
            session.resolve();
            LETHAL_SESSIONS.delete(sessionKey);
          } else {
            dbg("Waiting on lethal session", { sessionKey, actorId: this.id });
            await session.promise;
          }

          const nextOptions = { ...options, [BYPASS_FLAG]: true };
          dbg("Resuming target update", { actorId: this.id, sessionKey });
          return await wrapped.call(this, data, nextOptions);
        } finally {
          IN_PROGRESS.delete(this.id);
          ACTOR_SESSION.delete(this.id);
          dbg("Cleared IN_PROGRESS and ACTOR_SESSION", { targetId: this.id });
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Error in wrapper`, err);
        return await wrapped.call(this, data, options);
      }
    },
    "MIXED"
  );
});

// ---------- Helpers ----------

function resolveTargetActorsFromWorkflow(workflow) {
  const actors = new Set();
  try {
    const tSet = workflow?.hitTargets?.size ? workflow.hitTargets : workflow?.targets;
    if (tSet && typeof tSet.forEach === "function") {
      tSet.forEach(t => {
        const a = t?.actor ?? t?.document?.actor ?? t?.object?.actor;
        if (a) actors.add(a);
      });
    }
    const uuids = workflow?.chatCard?.getFlag?.("midi-qol", "targetUuids");
    if (Array.isArray(uuids)) {
      for (const uuid of uuids) {
        const tok = fromUuidMaybe(uuid);
        const a = tok?.actor ?? tok?.object?.actor;
        if (a) actors.add(a);
      }
    }
  } catch {}
  return actors;
}

function resolveAttackerForTarget(targetActorId, options = {}) {
  pruneAttackers("resolve");
  const mem = LAST_ATTACKER.get(targetActorId);
  if (mem?.attacker) {
    tagResolved(mem.attacker, mem.by ?? "remembered");
    return { attacker: mem.attacker, wfId: mem.wfId };
  }

  const wf = options?.midi?.workflow ?? options?.workflow ?? null;
  const wfId = wf?.id ?? wf?.uuid;
  if (wf?.actor) return { attacker: tagResolved(wf.actor, "options.workflow.actor"), wfId };

  const actorUuid = wf?.actorUuid ?? options?.midi?.actorUuid ?? options?.midi?.sourceActorUuid ?? options?.actorUuid;
  const aFromActorUuid = fromUuidMaybe(actorUuid);
  if (aFromActorUuid?.isActor || aFromActorUuid?.type) return { attacker: tagResolved(aFromActorUuid.document ?? aFromActorUuid, "actorUuid"), wfId };

  const itemUuid = wf?.itemUuid ?? options?.midi?.itemUuid ?? options?.itemUuid;
  const item = fromUuidMaybe(itemUuid);
  const actorFromItem = item?.parent?.document ?? item?.parent;
  if (actorFromItem?.isActor || actorFromItem?.type) return { attacker: tagResolved(actorFromItem, "itemUuid.parent"), wfId };

  const tokenUuid = wf?.tokenUuid ?? options?.midi?.tokenUuid ?? options?.tokenUuid;
  const tokenDoc = fromUuidMaybe(tokenUuid);
  const actorFromTokenDoc = tokenDoc?.actor ?? tokenDoc?.object?.actor;
  if (actorFromTokenDoc) return { attacker: tagResolved(actorFromTokenDoc, "tokenUuid"), wfId };

  const tokId = options?.midi?.tokenId ?? options?.tokenId;
  const tok = canvas?.tokens?.get(tokId);
  if (tok?.actor) return { attacker: tagResolved(tok.actor, "canvas.tokens.get(tokenId)"), wfId };

  const lastWf = getLastMidiWorkflow();
  if (lastWf?.actor) return { attacker: tagResolved(lastWf.actor, "MidiQOL.lastWorkflow"), wfId: lastWf?.id ?? lastWf?.uuid };

  const activeActor = game.combat?.combatant?.actor;
  if (activeActor) return { attacker: tagResolved(activeActor, "game.combat.combatant"), wfId: undefined };

  return null;
}

// --- Deferred/session utils ---

function createDeferred() {
  let _resolve;
  const promise = new Promise(res => { _resolve = res; });
  return { promise, resolve: _resolve, createdAt: Date.now() };
}

function pruneAttackers(reason) {
  const now = Date.now(); let removed = 0;
  for (const [aid, entry] of LAST_ATTACKER.entries()) {
    if (!entry?.ts || now - entry.ts > ATTACKER_TTL) { LAST_ATTACKER.delete(aid); removed++; }
  }
  if (removed) dbg(`Pruned ${removed} attacker entries`, { reason });
}

function pruneSessions(reason) {
  const now = Date.now(); let removed = 0;
  for (const [key, sess] of LETHAL_SESSIONS.entries()) {
    if (!sess?.createdAt || now - sess.createdAt > SESSION_TTL) { LETHAL_SESSIONS.delete(key); removed++; }
  }
  if (removed) dbg(`Pruned ${removed} lethal sessions`, { reason });
}

function tagResolved(actor, by) { try { actor._mlpResolvedBy = by; } catch {} return actor; }

function fromUuidMaybe(uuid) {
  if (!uuid || typeof fromUuidSync !== "function") return null;
  try { 
    return fromUuidSync(uuid); 
  } catch { return null; }
}

function getLastMidiWorkflow() { try { return MidiQOL?.Workflow?.lastWorkflow ?? MidiQOL?.lastWorkflow ?? null; } catch { return null; } }

// --- Midi auto-apply ---

function midiAutoApplyInfo() {
  const YES_RAW = new Set(["yes", "yesCard", "yesCardMisses", "yesCardNPC"]);
  const YES_ENUM = new Set([
    "midi-qol.autoApplyDamageOptions.yes",
    "midi-qol.autoApplyDamageOptions.yesCard",
    "midi-qol.autoApplyDamageOptions.yesCardMisses",
    "midi-qol.autoApplyDamageOptions.yesCardNPC"
  ]);

  let source = "unknown"; let raw;

  try {
    const cfg = game.settings.get?.("midi-qol", "ConfigSettings");
    if (cfg && typeof cfg === "object") { raw = cfg.autoApplyDamage ?? cfg["Auto Apply Damage to Target"]; source = "game.settings[midi-qol].ConfigSettings"; }
  } catch {}

  if (!raw && typeof MidiQOL !== "undefined") {
    const cfg2 = MidiQOL?.configSettings;
    raw = cfg2?.autoApplyDamage ?? cfg2?.["Auto Apply Damage to Target"];
    source = "MidiQOL.configSettings";
  }

  let normalized = raw;
  if (raw && typeof raw === "string") {
    if (YES_RAW.has(raw)) normalized = raw;
    else if (raw.startsWith?.("midi-qol.autoApplyDamageOptions.")) normalized = raw;
  }

  const enabled = !!(normalized && (YES_RAW.has(normalized) || YES_ENUM.has(normalized)));
  return { enabled, value: raw, normalized, source };
}

// --- Dialog & sockets ---

function showGMDialog(actorId) {
  return new Promise((resolve) => {
    const text = game.settings.get(MODULE_ID, "promptText") || "How do you want to do this?";
    const actorName = game.actors?.get(actorId)?.name ?? "Target";
    dbg("Rendering GM dialog", { actorId, actorName, text });

    const d = new Dialog({
      title: `${actorName} → 0 HP`,
      content: `<p style="margin:0.5rem 0 1rem">${escapeHtml(text)}</p>`,
      buttons: { cont: { icon: '<i class="fas fa-play"></i>', label: "Continue", callback: () => resolve() } },
      default: "cont",
      close: () => resolve()
    }, { jQuery: true, classes: ["hdywtdt-dialog"] });

    if (game.user.isGM) d.render(true); else resolve();
  });
}

function requestGMApproval(actorId) {
  return new Promise((resolve) => {
    const requestId = randomId();
    const onContinue = (data) => {
      if (data?.action === "CONTINUE" && data?.requestId === requestId) {
        dbg("Socket CONTINUE received", { requestId });
        game.socket?.off(SOCKET, onContinue);
        resolve();
      }
    };
    game.socket?.on(SOCKET, onContinue);

    dbg("Emitting REQUEST_CONTINUE", { requestId, actorId });
    game.socket?.emit(SOCKET, { action: "REQUEST_CONTINUE", requestId, actorId });

    setTimeout(() => { try { game.socket?.off(SOCKET, onContinue); } catch {} dbg("REQUEST_CONTINUE timeout → resolve"); resolve(); }, 30000);
  });
}

// --- Utils ---

function randomId() { return crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2); }
function escapeHtml(s) { return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'", "&#039;"); }
