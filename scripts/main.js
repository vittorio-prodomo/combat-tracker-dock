import { initConfig } from './config.js';
import {registerSettings} from './settings.js';
import {CombatDock} from './app/CombatDock.js';
import {CombatantPortrait, isAllyOfViewer} from './app/CombatantPortrait.js';
import {defaultAttributesConfig, generateDescription} from './systems.js';
import { showWelcome } from './lib/welcome.js';
import "../scss/module.scss";

export const MODULE_ID = 'combat-tracker-dock';

export function getCurrentCombat(){
    return ui.combat.viewed;
}

Hooks.once('init', function () {
    registerWrappers();
    registerHotkeys();
    CONFIG.combatTrackerDock = {
        CombatDock,
        CombatantPortrait,
        defaultAttributesConfig,
        generateDescription,
        INTRO_ANIMATION_DURATION: 1000,
        INTRO_ANIMATION_DELAY: 0.25,
    }

    // Public API. Lazily delegates to the live dock, so a caller never has to know whether one
    // is rendered — with no dock there is no carousel to spoil and holding is a harmless no-op.
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = {
        holdInitiativeReveal: (combatantId, options) => ui.combatDock?.holdInitiativeReveal(combatantId, options) ?? false,
        releaseInitiativeReveal: (combatantId) => ui.combatDock?.releaseInitiativeReveal(combatantId) ?? false,
    };

    Hooks.callAll(`${MODULE_ID}-init`, CONFIG.combatTrackerDock);
});

Hooks.on('ready', () => {
    registerSettings();
    initConfig();
    // The sidebar tracker first renders before "ready", when the hook below must skip (no settings yet) — redo it.
    if (!game.user.isGM && ui.combat.viewed) ui.combat.render();
    const currentCombat = getCurrentCombat();
    if(currentCombat && !ui.combatDock && game.settings.get("core", "noCanvas")) {
        new CONFIG.combatTrackerDock.CombatDock(currentCombat).render(true);
    }
    showWelcome();
});

Hooks.on('createCombat', (combat) => {
    if (game.combat === combat) {
        new CONFIG.combatTrackerDock.CombatDock(combat).render(true);
    }
});

Hooks.on('updateCombat', (combat, updates) => {
    if(updates.active || updates.scene === null) {
        new CONFIG.combatTrackerDock.CombatDock(combat).render(true);
    }
    if(updates.scene && combat.scene !== game.scenes.viewed && ui.combatDock?.combat === combat) {
        ui.combatDock.close();
    }
});

Hooks.on('canvasReady', () => {
    Hooks.once("renderCombatTracker", (tab) => {
        const currentCombat = getCurrentCombat();
            if(currentCombat) {
                new CONFIG.combatTrackerDock.CombatDock(currentCombat).render(true);
            } else {
                ui.combatDock?.close();
            }
    })
});


// "Hide Enemy Initiative" covers the core sidebar tracker too — otherwise a player opens the Combat tab and
// reads every foe's number there. Same ally line as the portraits. Core renders the tracker before "ready", where
// this module registers its settings, so that first render is skipped and redone in the ready hook above.
Hooks.on("renderCombatTracker", (app, html) => {
    if (game.user.isGM || !game.ready || !game.settings.get(MODULE_ID, "hideEnemyInitiative")) return;
    const combat = app.viewed;
    if (!combat) return;
    for (const row of html.querySelectorAll("[data-combatant-id]")) {
        const combatant = combat.combatants.get(row.dataset.combatantId);
        if (!combatant || combatant.initiative === null || isAllyOfViewer(combatant)) continue;
        const cell = row.querySelector(".token-initiative");
        cell?.querySelectorAll("span").forEach((span) => (span.textContent = "?"));
        cell?.querySelectorAll("input.initiative-input").forEach((input) => (input.value = "?"));
    }
});

function registerWrappers() {
    if (!game.modules.get("lib-wrapper")?.active) return;

    libWrapper.register(MODULE_ID, "Combatant.prototype.visible", function (wrapped, ...args) {
        const visible = wrapped(...args);
        if (!ui.combatDock?.rendered) return visible;
        const cDVisible = ui.combatDock.portraits.find((p) => p.combatant == this)?.firstTurnHidden;
        return visible && !cDVisible;
    });
}

function registerHotkeys() {
    game.keybindings.register(MODULE_ID, "combatPrev", {
        name: `${MODULE_ID}.hotkeys.combatPrev.name`,
        editable: [{ key: "KeyN", modifiers: [foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.SHIFT] }],
        restricted: false,
        onDown: () => {},
        onUp: () => {
            if (!game.combat) return;
            const isOwner = game.combat.combatant?.isOwner;
            if (!isOwner) return;
            game.combat.previousTurn();
        },
    });

    game.keybindings.register(MODULE_ID, "combatNext", {
        name: `${MODULE_ID}.hotkeys.combatNext.name`,
        editable: [{ key: "KeyM", modifiers: [foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.SHIFT] }],
        restricted: false,
        onDown: () => {},
        onUp: () => {
            if (!game.combat) return;
            const isOwner = game.combat.combatant?.isOwner;
            if (!isOwner) return;
            game.combat.nextTurn();
        },
    });
}
