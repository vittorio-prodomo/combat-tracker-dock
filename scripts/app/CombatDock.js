import { MODULE_ID } from "../main.js";
import { AddEvent } from "./AddEvent.js";
import { HandlebarsApplication, mergeClone, mergeObject } from "../lib/utils.js";

// Hold the carousel reorder until the 3D dice settle (Dice So Nice), so a "Roll All"
// doesn't spoil the animated initiative results. Same pattern as dnd5e-alert-initiative-swap:
// a start/complete animation counter, a debounce that coalesces the batch, and a MAX_WAIT
// guard against a leaked counter (or DSN being off / a manual initiative entry).
const INIT_REORDER_SETTLE_MS = 500;
const INIT_REORDER_MAX_WAIT_MS = 8000;

// T44b: hide the Primal Companion beast's portrait from the dock (GM + players alike). The beast stays a
// real combatant — its 'follows' initiative slot is what preserves CPR's charge rider (movementHistory) —
// but the CPR fork auto-resolves and skips its turn, so it should never appear in the carousel. Detect it
// structurally (a chris-premades summon carrying the Primal Companion Dodge/Strike item) so CCT needs no
// hard dependency on the CPR module; no-ops for every other combatant, including other summons.
const PRIMAL_BEAST_ITEM_IDS = ["primalCompanionDodge", "primalCompanionLandBeastsStrike", "primalCompanionSeaBeastsStrike", "primalCompanionSkyBeastsStrike"];
function isPrimalCompanionBeast(combatant) {
    const actor = combatant?.actor;
    if (!actor?.flags?.["chris-premades"]?.summons?.control?.actor) return false;
    return actor.items.some((i) => PRIMAL_BEAST_ITEM_IDS.includes(i.flags?.["chris-premades"]?.info?.identifier));
}

export class CombatDock extends HandlebarsApplication {
    constructor(combat) {
        super();
        ui.combatDock?.close();
        ui.combatDock = this;
        this.portraits = [];
        this.combat = combat ?? game.combat;
        this.hooks = [];
        this._playAnimation = true;
        this._currentPortraitSize = {
            max: parseInt(game.settings.get(MODULE_ID, "portraitSize")),
            aspect: game.settings.get(MODULE_ID, "portraitAspect"),
        };
        this.setHooks();
        window.addEventListener("resize", this.autosize.bind(this));
        this._combatTrackerRefreshed = false;
        this._diceAnimations = 0;
        this._initReorderSince = 0;
        this._initReorderTimer = null;
        // T40: combatant ids whose freshly-rolled initiative must not display yet — the
        // badge shows a bare die icon until the deferred reorder lands (one coherent reveal).
        this._pendingInitiativeReveal = new Set();
        // Outstanding external reveal holds: combatantId → expiry timer. See holdInitiativeReveal.
        this._initiativeRevealHolds = new Map();
    }

    /**
     * Hold a combatant's initiative reveal open past the dice-settle point, so an external
     * decision can be made before the table sees the number or the new turn order (e.g. a
     * post-roll "spend a die and add it to your Initiative?" offer, which is only a real
     * decision while the rest of the field is still unknown).
     *
     * Generic on purpose: the dock never learns who is holding or why — same
     * no-hard-dependency shape as the T44b beast-portrait check. A hold outranks the dice
     * guard, blanks the badge immediately (including with Dice So Nice off, where the
     * reorder would otherwise be instant), and carries its own expiry so a caller that dies
     * mid-decision cannot strand the carousel blank forever.
     *
     * @param {string} combatantId
     * @param {object} [options]
     * @param {number} [options.timeoutMs=30000]  Safety expiry; the holder is expected to
     *                                            release well before this.
     * @returns {boolean} whether the hold was taken
     */
    holdInitiativeReveal(combatantId, { timeoutMs = 30000 } = {}) {
        if (!combatantId) return false;
        const existing = this._initiativeRevealHolds.get(combatantId);
        if (existing) clearTimeout(existing);
        this._initiativeRevealHolds.set(
            combatantId,
            setTimeout(() => this.releaseInitiativeReveal(combatantId), timeoutMs)
        );
        // Blank now: without DSN nothing marked this combatant pending, and a hold taken
        // late (after a flush already cleared the mark) still has to withhold the number.
        this._pendingInitiativeReveal.add(combatantId);
        if (this._initReorderTimer) {
            clearTimeout(this._initReorderTimer);
            this._initReorderTimer = null;
        }
        const portrait = this.portraits.find((p) => p.combatant?.id === combatantId);
        if (portrait) portrait.renderInner();
        return true;
    }

    /** Release a hold taken by holdInitiativeReveal; the last one out triggers the reveal. */
    releaseInitiativeReveal(combatantId) {
        const timer = this._initiativeRevealHolds.get(combatantId);
        if (timer === undefined) return false;
        clearTimeout(timer);
        this._initiativeRevealHolds.delete(combatantId);
        if (!this._initiativeRevealHolds.size) {
            // Restart the dice guard window: accepting the offer rolls a die of its own, and
            // that animation should finish before the coherent reveal, exactly like the
            // initiative dice did.
            this._initReorderSince = Date.now();
            this._scheduleInitReorderFlush();
        }
        return true;
    }

    static get DEFAULT_OPTIONS() {
        let options = mergeClone(super.DEFAULT_OPTIONS, {
            classes: ["hidden"],
            window: {
                title: "",
                icon: "fas fa-arrows-up-down-left-right",
                frame: false,
                positioned: false,
                minimizable: false,
                resizable: false,
                savePosition: true,
            },
            position: {
                width: "auto",
                height: "auto"
            }
        });
        if (game.settings.get(MODULE_ID, "direction") !== "rowDocked") {
            mergeObject(options, this.WINDOWED_DEFAULT_OPTIONS);
        }
        return options;
    }

    static get WINDOWED_DEFAULT_OPTIONS() {
        return {
            window: {
                frame: true,
                positioned: true,
                // savePosition: true,
                preventEscapeClose: true
            }
        }
    }

    get sortedCombatants() {
        const sorted = Array.from(this.combat.combatants.contents.sort(this.combat._sortCombatants));
        if (game.settings.get(MODULE_ID, "hideDefeated")) {
            return sorted.filter(c => !c.isDefeated);
        }
        return sorted;
    }

    get trueCarousel() {
        return game.settings.get(MODULE_ID, "carouselStyle") < 2;
    }

    get leftAligned() {
        return game.settings.get(MODULE_ID, "carouselStyle") == 1;
    }

    get autoFit() {
        return game.settings.get(MODULE_ID, "overflowStyle") == "autofit";
    }

    get isVertical() {
        return game.settings.get(MODULE_ID, "direction") == "columnFloat";
    }

    get isDocked() {
        return game.settings.get(MODULE_ID, "direction") == "rowDocked";
    }

    setHooks() {
        this.hooks = [
            {
                hook: "renderCombatTracker",
                fn: this._onRenderCombatTracker.bind(this),
            },
            {
                hook: "createCombatant",
                fn: this.setupCombatants.bind(this),
            },
            {
                hook: "deleteCombatant",
                fn: this.setupCombatants.bind(this),
            },
            {
                hook: "updateCombatant",
                fn: this.updateCombatant.bind(this),
            },
            {
                hook: "updateCombat",
                fn: this._onCombatTurn.bind(this),
            },
            {
                hook: "deleteCombat",
                fn: this._onDeleteCombat.bind(this),
            },
            {
                hook: "combatStart",
                fn: this._onCombatStart.bind(this),
            },
            {
                hook: "hoverToken",
                fn: this._onHoverToken.bind(this),
            },
            {
                hook: "updateActor",
                fn: this._onUpdateActor.bind(this),
            },
            {
                hook: "diceSoNiceRollStart",
                fn: () => { this._diceAnimations++; },
            },
            {
                hook: "diceSoNiceRollComplete",
                fn: () => {
                    this._diceAnimations = Math.max(0, this._diceAnimations - 1);
                    if (this._initReorderTimer || this._initReorderSince) this._scheduleInitReorderFlush();
                },
            },
        ];
        for (let hook of this.hooks) {
            hook.id = Hooks.on(hook.hook, hook.fn);
        }
    }

    removeHooks() {
        for (let hook of this.hooks) {
            Hooks.off(hook.hook, hook.id);
        }
    }

    _prepareContext(options) {
        const scroll = game.settings.get(MODULE_ID, "overflowStyle") === "scroll";
        const lessButtons = game.settings.get(MODULE_ID, "lessButtons");
        const reverseHeaderPosition = !this.isDocked && !this.isVertical;
        return {
            isGM: game.user.isGM,
            scroll,
            lessButtons,
            reverseHeaderPosition
        };
    }

    setupCombatants() {
        this.portraits = [];
        // T44b: the beast is left in sortedCombatants (turn-index math depends on it) but gets no portrait.
        this.sortedCombatants.forEach((combatant) => {
            if (isPrimalCompanionBeast(combatant)) return;
            this.portraits.push(new CONFIG.combatTrackerDock.CombatantPortrait(combatant));
        });
        const combatantsContainer = this.element.querySelector("#combatants");
        combatantsContainer.innerHTML = "";
        this.portraits.forEach((p) => combatantsContainer.appendChild(p.element));
        const isEven = this.portraits.length % 2 === 0;
        this.element.classList.toggle("even", isEven);
        this.setupSeparator();
        this.updateOrder();
        this.autosize();
        if (!this._combatTrackerRefreshed) {
            this._combatTrackerRefreshed = true;
            ui.combat.render(true);
        }
        if (this._playAnimation && this.sortedCombatants.length > 0) {
            this._playAnimation = false;
            const promises = this.portraits.map((p) => p.ready);
            this._promises = promises;
            Promise.all(promises).then(() => {
                this.playIntroAnimation();
            });
        }
    }

    setupSeparator(){
        const combatantsContainer = this.element.querySelector("#combatants");
        combatantsContainer.querySelectorAll(".separator").forEach(s => s.remove());
        const turn = this.combat.turn + 1;
        const combatantsCount = this.sortedCombatants.length;
        const afterHalf = turn > Math.floor(combatantsCount / 2) || this.leftAligned ? 1 : 0;
        const separator = document.createElement("div");
        separator.classList.add("separator");
        const line = document.createElement("div");
        line.classList.add("line");
        separator.appendChild(line);
        const round = document.createElement("div");
        round.classList.add("round", this.isVertical ? "flexrow" : "flexcol");
        round.innerHTML = this.isVertical ? `<i class="fal fa-angle-down"></i>${this.combat.round + afterHalf}` : `<i class="fal fa-angle-right"></i>${this.combat.round + afterHalf}`;
        separator.appendChild(round);
        combatantsContainer.appendChild(separator);
    }

    playIntroAnimation(easing = "cubic-bezier(0.22, 1, 0.36, 1)") {
        Hooks.callAll("combatDock:playIntroAnimation", this);

        const duration = CONFIG.combatTrackerDock.INTRO_ANIMATION_DURATION;
        const delayMultiplier = CONFIG.combatTrackerDock.INTRO_ANIMATION_DELAY;

        const isVertical = this.isVertical;
        const alignment = game.settings.get(MODULE_ID, "alignment");

        const transformAxis = isVertical ? "X" : "Y";
        const transformDirection = isVertical && alignment == "right" ? "" : "-";

        const playSlideInAnimation = (el, delay = 0) => {
            el.style.transform = `translate${transformAxis}(${transformDirection}150%)`;
            const anim = el.animate([{ transform: `translate${transformAxis}(${transformDirection}150%)` }, { transform: `translate${transformAxis}(0)` }], {
                duration: duration,
                easing: easing,
                //fill: "forwards",
                delay: delay,
            });

            anim.finished.then(() => {
                el.style.transform = "";
                Hooks.callAll("combatDock:playIntroAnimation:finished", this, el);
            });
        };
        let totalAnimationTime = 0;
        Array.from(this.element.querySelector("#combatants").children).forEach((el, index) => {
            const order = this.trueCarousel ? parseInt(el.style.order) / 100 : index;
            const delay = order * duration * delayMultiplier;
            totalAnimationTime = Math.max(totalAnimationTime, delay + duration);
            playSlideInAnimation(el, delay);
        });

        setTimeout(() => {
            if (isVertical) this.centerCurrentCombatant();
        }, totalAnimationTime + duration);

        setTimeout(() => {
            this.element.classList.remove("hidden");
            if (!isVertical) this.centerCurrentCombatant();
        }, 10);
    }

    autosize(combatantRevived = false) {
        const max = parseInt(game.settings.get(MODULE_ID, "portraitSize"));
        const aspect = game.settings.get(MODULE_ID, "portraitAspect");
        this._currentPortraitSize = {
            max: max,
            aspect: aspect,
        };
        const verticalSize = max * aspect;
        if (!this.autoFit) return document.documentElement.style.setProperty("--combatant-portrait-size", max + "px");

        const sizeModifier = game.settings.get(MODULE_ID, "floatingSize");
        const combatantCount = this.sortedCombatants.length + (combatantRevived ? 1 : 0);
        let maxSpace, portraitSize;
        if (this.isVertical) {
            maxSpace = window.innerHeight * sizeModifier / 100;
        } else if (this.isDocked) {
            maxSpace = document.getElementById("ui-top").getBoundingClientRect().width * 0.9;
        } else {
            maxSpace = window.innerWidth * sizeModifier / 100;
        }
        portraitSize = this.isVertical ? Math.min(verticalSize, Math.floor(maxSpace / combatantCount)) / aspect : Math.min(max, Math.floor(maxSpace / combatantCount));

        document.documentElement.style.setProperty("--combatant-portrait-size", portraitSize / (this.isVertical ? 1 : 1.2) + "px");
    }

    updateCombatant(combatant, updates = {}, options = {}) {
        if ("initiative" in updates) {
            // A manual edit (the GM initiative editor) requests an immediate reorder; rolls
            // omit the flag and let the reorder defer until the 3D dice settle.
            if (options.cctImmediateReorder) {
                // A manual GM edit is an explicit override: it outranks any reveal hold on
                // that combatant (dropped without scheduling a flush — we reorder right here).
                const held = this._initiativeRevealHolds.get(combatant.id);
                if (held !== undefined) {
                    clearTimeout(held);
                    this._initiativeRevealHolds.delete(combatant.id);
                }
                this._pendingInitiativeReveal.delete(combatant.id);
                this.setupCombatants();
            } else {
                // T40: while the reorder waits for the dice, the badge must not show the
                // rolled value either (nor a stale one on a reroll) — mark the combatant
                // pending and repaint its portrait now so only the bare die icon shows.
                // Without DSN _scheduleInitiativeReorder reorders immediately; don't mark.
                if (game.dice3d) {
                    this._pendingInitiativeReveal.add(combatant.id);
                    const portrait = this.portraits.find((p) => p.combatant === combatant);
                    if (portrait) portrait.renderInner();
                }
                this._scheduleInitiativeReorder();
            }
            return;
        }
        const portrait = this.portraits.find((p) => p.combatant === combatant);
        if (portrait) portrait.renderInner();
        const combatantRevived = updates.defeated === false;
        this.autosize(combatantRevived);
    }

    // An initiative change reorders the carousel via setupCombatants(). When Dice So Nice is
    // active, defer that reorder until the 3D dice finish so a "Roll All" doesn't spoil the
    // animated results; without DSN there are no dice to wait for, so reorder immediately.
    _scheduleInitiativeReorder() {
        if (!game.dice3d) {
            // No dice to wait for — but another updateCombatant handler in this same tick
            // may still take a reveal hold, and hook order is not ours to control. Yield one
            // turn of the event loop first so those handlers get to speak; the flush then
            // honours whatever hold they took.
            this._scheduleInitReorderFlush(0);
            return;
        }
        if (!this._initReorderSince) this._initReorderSince = Date.now();
        this._scheduleInitReorderFlush();
    }

    _scheduleInitReorderFlush(delay = INIT_REORDER_SETTLE_MS) {
        if (this._initReorderTimer) clearTimeout(this._initReorderTimer);
        this._initReorderTimer = setTimeout(() => this._flushInitiativeReorder(), delay);
    }

    _flushInitiativeReorder() {
        this._initReorderTimer = null;
        // An external decision is still open (holdInitiativeReveal) → keep both the numbers
        // and the order back. No reschedule: releasing the last hold schedules the flush,
        // and every hold carries an expiry, so this cannot wedge.
        if (this._initiativeRevealHolds.size) return;
        // Dice still animating (within the guard window) → wait for the next completion.
        if (this._diceAnimations > 0 && Date.now() - this._initReorderSince < INIT_REORDER_MAX_WAIT_MS) {
            this._scheduleInitReorderFlush();
            return;
        }
        this._initReorderSince = 0;
        // T40: reveal the deferred initiative numbers in the same setupCombatants() call
        // that performs the reorder — one coherent reveal at the settle point.
        this._pendingInitiativeReveal.clear();
        if (!this._closed && this.element) this.setupCombatants();
    }

    updateCombatants() {
        this.portraits.forEach((p) => p.renderInner());
    }

    updateOrder() {
        this.setupSeparator();
        const separator = this.element.querySelector(".separator");
        const isTrueCarousel = this.trueCarousel;
        separator.style.display = isTrueCarousel ? "" : "none";
        if (this.sortedCombatants.filter((c) => c?.visible)?.length === 0) {
            separator.style.display = "none";
        }
        separator.classList.remove("vertical", "horizontal");
        separator.classList.add(this.isVertical ? "vertical" : "horizontal");

        const combatants = this.sortedCombatants;


        if (!this.trueCarousel) return this.portraits.forEach((p) => p.element.style.setProperty("order", combatants.indexOf(p.combatant)));

        const isLeftAligned = this.leftAligned;

        //order combatants so that the current combatant is at the center
        const currentCombatant = this.combat.combatant;
        const currentCombatantIndex = combatants.findIndex((c) => c === currentCombatant) + combatants.length;
        const tempCombatantList = [...combatants, ...combatants, ...combatants];
        const halfLength = isLeftAligned ? combatants.length : Math.floor(combatants.length / 2);
        const orderedCombatants = tempCombatantList.slice(currentCombatantIndex - halfLength, currentCombatantIndex + halfLength + 1);

        const lastCombatant = this.sortedCombatants[this.sortedCombatants.length - 1];

        this.portraits.forEach((p) => {
            const combatant = orderedCombatants.find((c) => c === p.combatant);
            const index = orderedCombatants.findIndex((c) => c === combatant);
            p.element.style.setProperty("order", index * 100);
        });

        //get last combatant's order
        const lastCombatantOrder = this.portraits.find((p) => p.combatant === lastCombatant)?.element?.style?.order ?? 999999;
        //set separator's order to last combatant's order + 1

        separator.style.setProperty("order", parseInt(lastCombatantOrder) + 1);
    }

    updateStartEndButtons() {
        if (!this.element) return;
        const started = this.combat.started;
        const setDisplay = (action, show) => {
            const btn = this.element.querySelector(`[data-action="${action}"]`);
            if (btn) btn.style.display = show ? "" : "none";
        };
        setDisplay("start-combat", !started);
        setDisplay("end-combat", started);
        setDisplay("delete-encounter", !started);
        for (const action of ["previous-turn", "next-turn", "previous-round", "next-round"]) {
            setDisplay(action, started);
        }
    }

    appendHtml(){
        if (this.isDocked) {
            return document.querySelector("#ui-top").prepend(this.element);
        }
    }

    _onRender(context, options) {
        if (this._closed) return this.close();
        super._onRender(context, options);
        this.setupCombatants();
        this.appendHtml();
        this.element.querySelectorAll(".buttons-container button").forEach((i) => {
            i.addEventListener("click", async (e) => {
                const action = e.currentTarget.dataset.action;
                switch (action) {
                    case "previous-turn":
                        this.combat.previousTurn();
                        break;
                    case "next-turn":
                        this.combat.nextTurn();
                        break;
                    case "previous-round":
                        this.combat.previousRound();
                        break;
                    case "next-round":
                        this.combat.nextRound();
                        break;
                    case "end-combat":
                        this.combat.endCombat();
                        break;
                    case "roll-all":
                        this.combat.rollAll({ event: e });
                        break;
                    case "roll-npc":
                        this.combat.rollNPC({ event: e });
                        break;
                    case "reset":
                        this.combat.resetAll();
                        break;
                    case "configure":
                        new foundry.applications.apps.CombatTrackerConfig().render(true);
                        break;
                    case "start-combat":
                        this.combat.startCombat();
                        break;
                    case "add-event":
                        new AddEvent(this.combat).render(true);
                        break;
                    case "delete-encounter": {
                        const confirmed = await foundry.applications.api.DialogV2.confirm({
                            window: { title: game.i18n.localize(`${MODULE_ID}.controls.deleteEncounter`) },
                            content: `<p>${game.i18n.localize(`${MODULE_ID}.controls.deleteEncounterConfirm`)}</p>`,
                            defaultYes: false,
                        });
                        if (confirmed) await this.combat.delete();
                        break;
                    }
                }
            });
        });
        this.autosize();
        this.setControlsOrder();
        this.updateStartEndButtons();
        new foundry.applications.ux.ContextMenu(
            this.element.querySelector("#combatants"),
            ".combatant-portrait",
            [
                {
                    condition: game?.user?.isGM,
                    name: `${MODULE_ID}.contextMenu.setAsCurrent`,
                    icon: `<i class="fas fa-swords"></i>`,
                    callback: (el) => {
                        this.combat.update({ turn: this.sortedCombatants.indexOf(this.combat.combatants.get(el.dataset.combatantId)) });
                    },
                },
                // Core's own "Clear Movement History" entry (spread in below) erases the trail but leaves the
                // token where it stopped. This one also puts it back where the turn started, for the player who
                // walked a route and changed their mind.
                //
                // It calls a DIFFERENT core method on purpose. Core clears movement history in two places of its
                // own -- at the start of every combatant's turn (Combat#_clearMovementHistoryOnStartTurn) and when
                // a combatant leaves a combat (Combat#_clearMovementHistoryOnExit) -- and BOTH go through
                // TokenDocument#clearMovementHistory. Teleporting by wrapping that primitive would therefore have
                // yanked tokens backwards on every turn change. TokenDocument#revertRecordedMovement is a separate,
                // caller-less core API that rolls the token back to movementHistory[0] and empties the history in
                // one update (isUndo, so the rollback records no new waypoints; animate:false, so it snaps).
                //
                // NOTE it also restores width/height/shape, and it undoes FORCED movement (a push, a Rideable
                // drag) because those are recorded waypoints like any other.
                {
                    condition: (el) =>
                        game.user.isGM &&
                        this.combat?.combatants.get(el.dataset.combatantId)?.token?.movementHistory.length > 0,
                    name: `${MODULE_ID}.contextMenu.revertMovement`,
                    icon: `<i class="fas fa-route"></i>`,
                    callback: async (el) => {
                        const combatant = this.combat?.combatants.get(el.dataset.combatantId);
                        const token = combatant?.token;
                        if (!token) return;
                        const reverted = await token.revertRecordedMovement();
                        if (reverted) {
                            ui.notifications.info(
                                game.i18n.format(`${MODULE_ID}.contextMenu.revertMovementDone`, { name: token.name })
                            );
                        }
                    },
                },
                ...game.combats.directory._getEntryContextOptions(),
            ],
            { jQuery: false, fixed: true }
        );
    }

    _onRenderCombatTracker() {
        this.portraits.forEach((p) => p.renderInner());
        this.updateStartEndButtons();
    }

    // T36: the AC badge (and the bars/text) read live actor data, but no combat hook
    // fires on a plain actor update (sheet edit, AC override), so a mid-combat AC
    // change could lag until the next combat update. Re-render the affected portrait.
    _onUpdateActor(actor, changes) {
        if (!foundry.utils.hasProperty(changes, "system")) return;
        const portrait = this.portraits.find((p) => p.actor === actor);
        if (portrait) portrait.renderInner();
    }

    _onCombatTurn(combat, updates, update) {
        if (!("turn" in updates) && !("round" in updates)) return;
        if ("round" in updates) this._onRoundChange();
        const combatantsContainer = this.element.querySelector("#combatants");
        const filteredChildren = Array.from(combatantsContainer.children).filter((c) => !c.classList.contains("separator"));
        const currentSize = combatantsContainer.getBoundingClientRect();
        combatantsContainer.style.minWidth = currentSize.width + "px";
        combatantsContainer.style.minHeight = currentSize.height + "px";
        //find combatant with lowest order

        const childrenByHighestOrder = [...filteredChildren].sort((a, b) => b.style.order - a.style.order);
        const childrenByLowestOrder = [...filteredChildren].sort((a, b) => a.style.order - b.style.order);

        const currentCombatant = this.combat.combatant;
        const currentIndex = this.sortedCombatants.findIndex((c) => c === currentCombatant);
        let nextDefeatedCount = 0;
        let previousDefeatedCount = 0;
        const sortedCombatants = this.sortedCombatants;
        for (let i = 0 + 1; i < sortedCombatants.length; i++) {
            const index = (currentIndex + i) % sortedCombatants.length;
            const combatant = sortedCombatants[index];
            if (combatant.defeated) previousDefeatedCount++;
            else break;
        }

        for (let i = 0 + 1; i < sortedCombatants.length; i++) {
            const index = (currentIndex - i + sortedCombatants.length) % sortedCombatants.length;
            const combatant = sortedCombatants[index];
            if (combatant.defeated) nextDefeatedCount++;
            else break;
        }

        const nextDefeatedCombatants = childrenByLowestOrder.slice(0, nextDefeatedCount + 1);
        const previousDefeatedCombatants = childrenByHighestOrder.slice(0, previousDefeatedCount + 1);

        const first = nextDefeatedCount != 0 ? nextDefeatedCombatants : [[...filteredChildren].reduce((a, b) => (a.style.order < b.style.order ? a : b), combatantsContainer.children[0])];
        const last = previousDefeatedCount != 0 ? previousDefeatedCombatants : [[...filteredChildren].reduce((a, b) => (a.style.order > b.style.order ? a : b), combatantsContainer.children[0])];

        const els = update.direction === 1 ? first : last;

        if (this._playAnimation && this.sortedCombatants.length > 0) {
            this._playAnimation = false;
            this.updateOrder();
            this.playIntroAnimation();
            return;
        }

        setTimeout(() => this.updateOrder(), 200);

        if (!this.trueCarousel) {
            combatantsContainer.style.minWidth = "";
            combatantsContainer.style.minHeight = "";
            return this.centerCurrentCombatant();
        }

        for (const el of els) {
            el.classList.add(`collapsed-${this.isVertical ? "vertical" : "horizontal"}`);
            setTimeout(() => {
                el.classList.remove(`collapsed-${this.isVertical ? "vertical" : "horizontal"}`);
                setTimeout(() => {
                    combatantsContainer.style.minWidth = "";
                    combatantsContainer.style.minHeight = "";
                }, 200);
                this.centerCurrentCombatant();
            }, 200);
        }
    }

    async _onRoundChange() {
        const toDelete = [];
        for (const combatant of this.combat.combatants) {
            const duration = combatant.getFlag(MODULE_ID, "duration");
            if (!duration) continue;
            const roundCreated = combatant.getFlag(MODULE_ID, "roundCreated");
            if (!roundCreated) continue;
            const currentRound = this.combat.round;
            const roundsElapsed = currentRound - roundCreated;
            if (roundsElapsed >= duration) {
                toDelete.push(combatant.id);
                ChatMessage.create({
                    speaker: { alias: "Combat Tracker Dock" },
                    content: game.i18n.localize("combat-tracker-dock.add-event.expired").replace("%n", `<strong>${combatant.name}</strong>`),
                    type: CONST.CHAT_MESSAGE_TYPES.OTHER,
                    whisper: [game.user.id],
                });
            }
        }
        if (toDelete.length > 0) {
            await this.combat.deleteEmbeddedDocuments("Combatant", toDelete);
        }
    }

    centerCurrentCombatant() {
        if(!this.element) return;
        const carouselStyle = game.settings.get(MODULE_ID, "carouselStyle");
        const combatantsEl = this.element.querySelector("#combatants");
        if (this.trueCarousel) {
            if (carouselStyle == 1) {
                return combatantsEl.scrollTo({
                    top: 0,
                    left: 0,
                    behavior: "smooth",
                });
            }

            combatantsEl.scrollTo({
                top: combatantsEl.scrollHeight / 2 - combatantsEl.offsetHeight / 2 + this._currentPortraitSize.max * this._currentPortraitSize.aspect,
                left: combatantsEl.scrollWidth / 2 - combatantsEl.offsetWidth / 2 + this._currentPortraitSize.max,
                behavior: "smooth",
            });
        } else {
            const current = this.portraits.find((p) => p.combatant === this.combat.combatants.get(this.combat?.current?.combatantId));
            if (!current) return;
            const el = current.element;
            el.scrollIntoView({
                behavior: "smooth",
                block: "center",
                inline: "center",
            });
        }
    }

    setControlsOrder() {
        const uiLeft = this.element.querySelector(".buttons-container.left");
        const uiRight = this.element.querySelector(".buttons-container.right");
        uiLeft.style.marginRight = "";
        uiRight.style.marginLeft = "";
        const combatants = this.element.querySelector("#combatants");
        const alignment = game.settings.get(MODULE_ID, "alignment");
        if (this.isVertical && alignment !== "center") {
            if (alignment == "right") {
                uiLeft.style.order = 0;
                uiLeft.style.marginRight = "1rem";
                uiRight.style.order = 1;
                combatants.style.order = 2;
            } else {
                uiLeft.style.order = 1;
                uiRight.style.order = 2;
                uiRight.style.marginLeft = "1rem";
                combatants.style.order = 0;
            }
        } else {
            uiLeft.style.order = "";
            uiRight.style.order = "";
            combatants.style.order = "";
        }
    }

    _onDeleteCombat(combat) {
        if (combat === this.combat) {
            this.close();
        }
    }

    _onCombatStart(combat) {
        if (combat === this.combat) this._playAnimation = true;
    }

    _onHoverToken(token, hover) {
        const portrait = this.portraits.find((p) => p.token === token);
        if (!portrait) return;
        portrait.element.classList.toggle("hovered", hover);
    }

    refresh() {
        this.autosize();
        this.updateCombatants();
        this.appendHtml();
    }

    async restart() {
        await this.close();
        await new CombatDock().render({ force: true });
    }

    async close(...args) {
        this.removeHooks();
        if (this._initReorderTimer) clearTimeout(this._initReorderTimer);
        window.removeEventListener("resize", this.autosize.bind(this));
        if (this.element) this.element.remove();
        this._closed = true;
        return super.close(...args);
    }
}
