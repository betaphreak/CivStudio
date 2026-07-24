# Design note: the city of hamlets

**Status:** Design (not built) — the plan for turning a city's plots into first-class **hamlets**:
self-contained peasant cells, each led by the noble (or crown) that holds it, under the city's shared
money and market. ("Hamlet" is the code/type name — the tier a hamlet caps at; the UI may still say
"village" as flavor. See §7.) Grows directly out of the shipped vassalage (P1–P5) and the P2 land
model.
**Date:** 2026-07-24
**Depends on:** the vassalage — `Plot.ownerId` (fief-holder), `Noble.fief`, `AbstractHousehold.liege`
(ruler→nobles→peasants), `Settlement.grantFief`; the P2 land model (empty plot = single-household
farm, built plot = stacked housing, `Plot.hasRegularBuilding`); `FoodEconomy`; the `SettlementTier`
ladder (one `Settlement` class + a `tier` field — NO `Village`/`City` subclasses; see §7).

---

## 1. What this is

A **City** is not a monolith of agents; it is a **ruler over a set of Villages** — its plots, each a
self-contained cluster of peasants led by the noble that got it from the ruler (or by the crown
directly). A village *is* a fief made first-class: the plot(s) + its resident peasants + its leader.
Province 4111's city holds ~30 villages (its 30 plots); 44 urban plots remain in the province for a
future second city or **unincorporated villages** (none exist at game start).

## 2. Decisions (from the 2026-07-24 design dialogue)

- **Autonomy = shared economy, local population.** Money, banks, and the consumer-good **market** (one
  price discovery) are city-wide; a village owns its **population, leader, food, housing, births, and
  dues** locally. Each village's local state steps per-village inside the city's `newDay`; the market
  clears once, city-wide, after the fan-out.
- **Leader = fief OR crown demesne.** A noble-held plot is a noble-led village; an un-enfeoffed plot
  is a **crown demesne village** (matches "the ruler holds some peasants directly").
- **Self-contained villages.** A village's peasants live and work *their own* ground; the village
  feeds itself locally and posts only **surplus/deficit** to the shared market.
- **Firm split.** **Enjoyment firms stay city-level** (luxury, sold on the shared market); **villages
  get the Necessity firms** (food). So villages are the food cells; the city is luxury + market.
- **Village = seat plot + farmland.** A village is its **seat plot** (the leader's manor/palace +
  stacked peasant housing) plus **whatever farmland exists around it (or none)** — the empty plots it
  works for food. A village therefore holds a *set* of plots, not one (extend `Noble.fief` → a
  territory).
- **Food production = the leader's village Necessity firm(s) employing its peasants.** The leader
  (noble, or the crown for a demesne village) owns the village's `NFirm`(s); they **hire the village's
  peasants** and produce food into the **village larder**, with the **surplus sold** to the shared
  city market (and deficits bought from it). The leader is the employer-lord. (No separate per-
  household subsistence farming — the firm is the village's food engine; peasants earn wages and eat
  from the village larder.)
- **Larder = a village-level shared food balance, a PROVISIONED FLOOR.** (Decided 2026-07-24 — the
  load-bearing fork.) The village holds one larder its peasants eat from (fed by its NFirm, split among
  its households) — a refactor of the current per-household larder into a per-village pool. It is a
  **provisioned floor, not a purchased good**: the larder feeds the village's resident households up to
  their ration **regardless of their ability to pay** — a peasant does *not* individually buy its
  staple food on the market. This is the feudal social contract made mechanical: **the lord feeds his
  vassals.** Consequences that fall out of the choice:
  - **The market participant for food is the VILLAGE, not the household.** Households stop posting
    individual necessity demand; the village posts its larder's **surplus (sell) / deficit (buy)** to
    the shared city market, so food price discovery runs on the *aggregate of village net balances*
    (fewer, larger participants) rather than per-household demand. The unmet-demand pressure signal
    survives, at village granularity.
  - **The leader funds any deficit import** (the provision duty), from its **NFirm dividends + P4
    dues** — so a peasant's wage goes to **Enjoyment + dues + savings**, never to its own bread; the
    leader is the food-provider. This closes the money loop the earlier §2 BALANCE WATCH flagged:
    wage → dues → the lord provisions the larder (buying the deficit if the fields fall short).
  - **The provisioned floor IS the anti-collapse survival mechanism** — it replaces per-household
    home-plot subsistence as the guarantee. A village whose NFirm output + food buildings + purchased
    imports cannot fill the larder to the floor *starves* (the failure mode the survival tests gate:
    keep dues + wage/price such that a village does not starve its own people). The current
    per-household eat → starve → child-granary-relief priority moves to **village-larder scope**.
- **Peasant pool = one city-wide `Retinue` (kept).** A single shared labor reserve; villages draw new
  households from it as they have room, on top of their own births/immigration. Least structural
  change to the pool.
- **Founding = emergent.** The city starts with a few villages and **incorporates more plots into
  villages as it grows** into them; the village count climbs over the run rather than all ~30 existing
  at day one.
- **Incorporation = the builder developing a plot.** When the colony's `BuilderFirm` develops a new
  plot (a seat), that plot **becomes a village** — villages track the physical buildout. A grant /
  ennoblement then hands the village to a noble; an un-granted one is a crown demesne village.
- **Territory grows by proximity.** A village starts as its seat; as its population grows it **claims
  nearby empty plots as fields** (organic spread outward). Territory expands with need, not a fixed
  bundle at grant time. **Urban ground is farmable ground** (see §8): an urban plot keeps its natural
  terrain food yield, and the "paved, no farm" signal is `Plot.hasRegularBuilding()`, not the `urban`
  flag. So even in all-urban territory a village's *unbuilt* urban plots are real fields its NFirm
  farms; only its **built** plots (the seat's manor + stacked housing, firms) don't farm. A dense,
  fully built-up village is a **net food importer** (it buys from the shared city market); a village
  with unbuilt urban fields is a net **exporter**. As a city densifies, more plots gain a regular
  building and its farmable base shrinks — so it drifts from self-feeding toward import-dependent as it
  grows, the shared market balancing exporters against importers. **Food buildings are additive**
  (bonus food to the land), not the lifeline the all-urban case once seemed to need.
- **The leader takes BOTH firm profit and dues.** The leader draws NFirm dividends (as owner) **and**
  collects P4 dues from its peasants — the full feudal + capitalist take. BALANCE WATCH: the same
  peasants are squeezed from both sides; keep dues + the firm's wage/price low enough that a village
  doesn't starve its own people (survival tests gate this).
- **Overflow → the city pool.** When a village fills (seat stacking cap + no more claimable fields),
  its surplus returns to the shared city `Retinue`, to be **re-seated** in whichever village has room
  (or a newly-incorporated one). The pool is the inter-village buffer; no direct village→village
  migration.
- **Name = `Hamlet` (leave `Village` alone).** There is **no `Village` class today** — the old
  `Village`/`City` subclasses were long ago collapsed into one `Settlement` + a `SettlementTier` field,
  and the old "Village" *rung* is now `SMALLHOLDING`. Rather than reuse "Village" (still live as the
  *separate* `Rank.VILLAGE` command-rank and a tile-improvement), the new sub-unit is a **`Hamlet`**,
  named for the tier it sits at — **zero collision, self-documenting, nothing to rename**. (Scrap the
  earlier `Village`→`Township` idea entirely; the UI may still *say* "village" as flavor.) On the ladder
  (`CAMP<COTTAGE<HAMLET<SMALLHOLDING<TOWN<METROPOLIS`) a `Hamlet` carries **its own `tier`, capped at
  HAMLET**, and grows `CAMP→COTTAGE→HAMLET` via its own food-box as it gains households — while
  **sharing the city's market and banks** (consistent with "shared economy, local population"). The
  HAMLET cap (`minHouseholds` 9, below SMALLHOLDING's 16 — the rung a settlement boots a Ruler and
  becomes a real colony) is what keeps a hamlet a *dependent* unit, and replaces the ad-hoc P2 stacking
  cap. A city is the `TOWN`/`METROPOLIS` `Settlement` that contains its hamlets. Wrinkle: HAMLET's
  derived head-rank is a Captain, but a hamlet's leader comes from the **fief** (noble by grant, or
  crown) — decoupled (HAMLET in *size*, noble-*led*). An **unincorporated** hamlet is a standalone
  low-tier `Settlement` (literally at HAMLET); one that outgrows HAMLET graduates into a real
  `SMALLHOLDING` colony — a clean promotion; a second city can incorporate it (V4).

## 3. The model

A **Village** exists at one of two scopes:
- **Incorporated** — a neighborhood of a city; shares the city's money, banks, and market (the case
  the phases below build first).
- **Unincorporated** — a **standalone village on a leftover province plot**, belonging to no city; it
  is its own small settlement with its own economy (what today's `Village`/`Township` already is). The
  province holds more plots than a city occupies (province 4111: a ~30-plot city + 44 leftover urban
  plots), and those leftover plots can carry unincorporated villages. None exist at game start; they
  emerge (a seceding neighborhood, a settler band that settles a leftover plot, or the builder
  developing ground outside the city) and can later be **incorporated into a second city** (V4).

- **City** = ruler/crown · shared banks + money · shared consumer-good **market** (price discovery) ·
  **Enjoyment firms** + dynamic provisioning · the villages. Its **center plot (index 0) is the
  non-village core** — the shared market + Enjoyment firms + civic heart, sitting *above* the villages,
  not one of them (the ruler heads the city; it does not also run a central village).
- **Village** = a **leader** (fief-holder `Noble`, or the crown for a demesne village) · a **territory**
  (seat plot + 0..N farm plots) · its **peasant households** (on the seat, P2 stacking) · the leader's
  **Necessity firm(s)** employing those peasants · a **village larder** (shared local food balance) ·
  local **housing/building**, **births/immigration**, and **dues**.
- **Economy flow:** the leader's village NFirm(s) hire the village's peasants and farm its fields →
  food into the **village larder** (its peasants eat from it), **surplus sold** to the shared city
  market, deficits bought from it. Peasants earn wages (spent on **Enjoyment** from the city's
  Enjoyment firms, dues, savings). Money/banks and the market are shared; dues run peasant → village
  leader → crown (the vassalage levy).

## 4. Phased plan

- **M — urban fields (map regen; the food substrate). ✅ SHIPPED (MAP_VERSION 10).** Stopped the
  generation-time yield surgery on urban cells: an urban plot keeps its **full natural yield stack** —
  terrain, relief, feature, and (critically) **bonus** — exactly like every other plot; `urban` is a
  pure orthogonal overlay (a footprint marker), never a replacement for the feature slot. Whether a
  plot actually farms is decided at runtime by `hasRegularBuilding()` (paved core = no farm), not
  stamped at gen. One gen-time guard survives: an urban plot is never an unworkable peak (peaks in the
  footprint are clamped to hills). Roads are no longer pre-paved on urban plots either — a city's
  ground carries **trails**, upgraded by real building, not a free paved network (see the routes note
  in §8). **Calibration held: no `YIELD_REFERENCE` re-tune was needed** — the full engine + server
  suites stayed green (survival, growth, CanonicalRun, twin-settlement all pass), because for a
  *farmed* plot the only new food comes from food bonuses (features clear when farmed; relief doesn't
  touch food), a modest shift. Still needs the CI full-world rebake → deploy → clear the plot cache
  before prod serves v10. It is the substrate V2/V3 stand on. See §8.
- **V0 — the `Hamlet` entity. ✅ SHIPPED.** `settlement.Hamlet` (record: `seat`, `name`, `leaderId`,
  `households`, `tier`) + `Settlement.hamlets()` / `householdsByHomePlot()`: one hamlet per plot with
  resident households, led by the seat's `ownerId` (noble/ruler) or the Crown, named for the seat's
  GeoNames place, tier derived from household count and **capped at HAMLET**; the city center (plot 0)
  is excluded. A pure read-only projection over the shipped vassalage state — no stored state, no
  behavior change. `HamletTest` covers the grouping + the tier derivation.
- **V1 — membership & roster + view. ✅ SHIPPED.** `Settlement.householdsByHomePlot()` groups
  households by `homePlot` → hamlet; `DistrictView.households` carries the per-plot count into the live
  snapshot (same grouping the engine projects). The **city screen shows each plot as a hamlet** —
  name (already from the plot grid) · leader (the ⚜ fief chip, or Crown) · **N households** (a new
  `N⌂` badge + a "a hamlet · N households under the <house>" line) — and no longer folds away a
  peopled plot as empty "worked ground".
- **V2 — village larder + local tick. 🚧 IN PROGRESS (flag-gated `villageLarder`, default off).**
  Refactor the per-household larder into a **village larder** (a shared local food balance the
  village's peasants eat from, the **provisioned floor**). The city's `newDay` fans out a
  `Village.step()`: its **food balance**, **housing/building**, **births/immigration into that
  village**, and **dues** — per-village, not global. Shared market still clears once, city-wide.
  - *Slice 1 ✅ SHIPPED* — the foundation: `settlement.Larder` (a per-hamlet Necessity pool),
    `settlement.VillageLarders` (the per-hamlet larder subsystem, one pool per hamlet seat), the
    `SimulationConfig.villageLarder` flag + `Settlement.enableVillageLarders()`, harness wiring.
    Behavior-neutral: flag off = byte-identical (null subsystem), and even flag-on nothing eats from
    the pools yet. `VillageLarderTest`.
  - *Slice 2a ✅ SHIPPED* — the **market delivery-target seam**: `ConsumerGoodMarket.addBuyOffer(payer,
    deliverTo, demand)` bills the payer (so the village's leader pays and its demand joins price
    discovery) but delivers the bought food into a named `Good` — the village larder's `Necessity` —
    rather than the payer's own store. Backward-compatible (the old `addBuyOffer(buyer, demand)`
    delegates with `deliverTo = null`); byte-identical. This is the mechanism that lets a leader fund
    its village's imports without a new agent or a post-clear split — a `Noble` eats from its own
    necessity, so its `getGood` can't be the larder.
  - *Slice 2b ✅ SHIPPED* — **provisioned eating + leader-funded imports**. `Laborer.act()` routes its
    eating through a `foodStock()` seam — the hamlet's shared `Larder` when the household is
    provisioned (its home plot is a `Settlement.isHamletSeat`), else its own necessity — so the whole
    eat → starve → child-granary-relief priority and births run at larder scope unchanged; a
    provisioned peasant drops its home-plot food into the larder and posts **no** necessity demand (its
    wage flows to enjoyment + dues + savings). Each village's leader tops the larder to a `FLOOR_DAYS`
    floor by posting a **purse-capped** deficit buy (via the 2a seam) in `VillageLarders.provision()`,
    after the day's eating and before the market clears; a poor lord under-provisions rather than
    borrowing without bound. Larders are pre-stocked with a founding buffer so day 1 is fed.
    **`VillageLarderTest.aProvisionedColonySurvivesAndFeedsItsVillages`** asserts a flag-on colony
    survives three years with fed larders; the full suite (470) stays byte-identical flag-off. Ran the
    4-angle simplify pass on the diff (single `provisioned()` eval via a `foodStock(boolean)` overload,
    shared `isHamletSeat` predicate, reuse `Settlement.getHouseholdById`, dropped the dead
    `Larder.draw()`).
  - *Slice 3 ✅ SHIPPED (emergent — no new machinery).* Per-hamlet births / immigration / dues turned
    out to be **already emergent** from the household-in-a-village model, so no explicit `Village.step()`
    fan-out was built: a peasant's **births** are gated on its village larder (slice 2b's `foodStock`
    redirect), its **dues** flow to its village's leader (its liege is the plot's fief-holder, P4), and
    **immigration** seats a new household on a plot = in a village (`claimHomePlot`). A test
    (`provisionedVillagesStillPayDuesToTheirLeaderAndGrowLocally`) locks in that the provisioned floor
    doesn't sever the fill (larder) from the take (dues) or the growth (births).

**V2 status: ✅ THE DEFAULT (flag flipped on, 2026-07-24).** `SimulationConfig.villageLarder` now
defaults **on**, so every home-plot colony organizes food per hamlet as a provisioned larder — the
build-economy-style flip. The flip surfaced exactly one latent bug (a labor-market employee whose
household departs — drafted / emigrated / dissolved — between posting its offer and the market clear
left a stale offer → NPE crediting a closed account; guarded centrally in `LaborMarket.clear`), and
otherwise the full engine (471) + server (131) + `-Pfull` scenario suites stay green — the survival,
growth, and CanonicalRun-dependent tests holding *is* the calibration validation that the levers
(`FLOOR_DAYS`, `FOUNDING_STOCK`, the `dailyNeed` over-estimate) produce a healthy economy. Those levers
were later revisited under V3: `FOUNDING_STOCK` was **recalibrated away** (it is now the village's own
floor — see V3 below), and the larder/food status **is** now surfaced in the city screen. `FLOOR_DAYS`
and the `dailyNeed` over-estimate remain as tuning levers.
- **V3 — leader-owned NFirms + surplus. ✅ SHIPPED — AND THE DEFAULT (flag flipped on, 2026-07-24).**
  Every necessity farm now belongs to a **village** rather than to the city at large, via one link
  (`NFirm.village`, the hamlet seat) set by a new daily pass, `settlement.VillageFirms` (gated by
  `SimulationConfig.villageFirms`, wired by the harness, run at the top of `Settlement.newDay` before
  the agents act). Three consequences ride that one link:
  - **It feeds its own village first.** `ConsumerGoodFirm.act()` gained a `deliverLocally()` hook,
    called after production and *before* the sell offer; `NFirm` overrides it to move what its
    larder is short of the floor into that larder (`VillageLarders.deposit`), so only the **surplus**
    reaches the shared market. Crucially this is a **priced local sale, not a free transfer**: the
    village's leader *buys* the food at the going market price (money leader → farm), because a farm
    that gave its output away would lose the revenue its labor-share wage budget is sized from and
    spiral to zero output. Two caps make it degrade gracefully — the larder takes only up to its
    floor (a full village exports the rest), and the leader buys only what its purse affords.
  - **It hires its own village's people first.** `Firm.laborAffinity()` (null by default; `NFirm`
    returns its village) plus a worker's home plot on the labor-market employee. `LaborMarket.clear`
    now sizes every firm's slice up front, then runs `placeVillagers` — a pure **reordering** of the
    already-shuffled workforce inside the already-sized slices, so every firm still hires the same
    number of workers at the same wage; only *who* changes. A farm may take villagers from anywhere
    except a slice whose employer wants that same village (so one farm never robs another of its own
    people), which makes the pass monotone and hence terminating, and means being served late in the
    shuffle costs a farm nothing. Labor stays **one city-wide market with one wage discovery** — the
    §5 shared-labor decision, honored exactly.
  - **Its leader owns it.** The pass grants each village's farm to that village's fief-holder
    (`Noble.owns` added so an already-correct holding is left alone rather than removed and re-added).
    A **crown-demesne village keeps its farm's existing owner**: the `Ruler` is a treasury, not a
    rentier — it draws no dividends — so there is no crown hand to move the holding into. The crown's
    stake in a demesne village stays its provisioning duty and its taxes.

  **Assignment is balanced, not spatial** (farms go to the villages with the fewest, ties on
  plot-claim order, plus one gentle rebalancing move a day): the plot field is claim-ordered, not a
  spatial grid, so proximity would have been a fiction. The "territory grows by proximity" rule stays
  a later storey.

  **What the shipped colony actually looks like — the finding that shapes V3's weight.** A mature
  colony runs **~400 hamlets of one household each** against **1–2 necessity farms**: since the
  build-economy flip, food is overwhelmingly **home-plot subsistence** dropped straight into the
  larder, and the dynamic provisioning has shrunk the farm sector to near-vestigial. So V3's
  machinery is correct and lands the model, but its present *economic* weight is small — it will
  grow as cities densify (a built-up village cannot farm its own ground and must import). Two things
  fell out of looking:
  - **`FOUNDING_STOCK` was recalibrated away** (the lever the user flagged). A flat 100 units per
    larder, conceived when a "village" meant many households, is multiplied by ~400 one-household
    villages into ~40,000 units of food **created from nothing** — about 100 days of the whole
    colony's ration need. The founding endowment is now the village's **own floor** (`FLOOR_DAYS` of
    its ration need, ~5 units), which removes the free lunch and folds two uncalibrated levers into
    one. Full suite stayed green, so it was not load-bearing.
  - **A Crown-demesne village was provisioned by a broke crown — FIXED 2026-07-25.** The purse cap
    (`max(0, checking + savings)`) exists so a poor *noble* under-provisions rather than borrowing
    without bound, but the crown's treasury is structurally negative, so for the crown it read as
    zero forever and its provisioning duty was purely nominal. Two changes: the crown now provisions
    **on credit**, its line being its **bank's equity** (the realm's accumulated wealth, which is
    what a sovereign actually borrows against) — deliberately finite, since an unbounded budget makes
    the demand curve `min(deficit, budget/price)` perfectly *inelastic*, which is a price ratchet and
    also poisons the market's binary search (a demand of `Infinity` never converges). And the
    underlying deficit was fixed at source: see the research-funding change in
    [`docs/tech-tree.md`](tech-tree.md). The bill is small either way — topping *every* village to its
    floor measured 0.0 at year boundaries, because home-plot food already fills the larders.

  **Validation.** Engine 482 (488 under `-Pfull`) + server 131 green with the flag **on**, including
  every survival/growth/CanonicalRun test — the same calibration signal V2's flip rested on. Only the
  two tests asserting "off by default" changed. `VillageFirmTest` covers assignment, the grant→
  ownership move, the priced larder sale with its floor cap, the live surplus market, and multi-year
  survival; `LaborMarketTest` covers the affinity rule directly.
  - *Reporting.* `DistrictView` gained `larder` / `larderFloor` / `farms`, and the **city screen**
    now shows each hamlet's food status: a 🍞 larder chip that turns red when the village has fallen
    below the floor its lord provisions it to, and a 🌾 chip for the farms working its fields
    (`web/js/hamlet-food.mjs`, unit tested). A starving village was otherwise invisible until its
    people began to die.
- **V4 — lifecycle & unincorporated villages.** Charter a new village (ruler grants a leftover plot →
  a village seeded with peasants), the 44 leftover plots as **unincorporated villages** (a `Village`
  with no parent city), and the seam for a **second city** to incorporate them. `Township` converges
  into "unincorporated `Village`" here.
- **V5 — governance.** The leader runs *its* village (dues, housing, eventually local policy) — ties
  into the estate system.

## 5. Open details to settle as we build

- **Larder = provisioned floor. ✅ DECIDED (2026-07-24)** — see the larder bullet in §2. The larder
  feeds resident households regardless of pay; the *village* (not the household) is the market's food
  participant. Unblocks V2/V3.
- **Labor market = SHARED + village affinity. ✅ DECIDED (2026-07-24).** Labor stays **one city-wide
  market** (one price discovery, the existing wage-budget allocation) — no per-village markets. A
  village's NFirm **hires its own resident peasants first**, spilling over to other villages' peasants
  only when it is short of labor. Keeps the shared-economy principle intact while making "the lord's
  firm employs his own people" the default. (The provisioned floor already decoupled *eating* from
  *earning*, so affinity is about identity/flavor + keeping wages coherent, not survival.) This is a
  **V3** concern — V2's labor is unchanged; V3 adds the affinity rule when the NFirms move under
  villages.
- **Farm-plot → village association.** How do the empty farm plots map to a village — by proximity to
  the seat, or by the ruler granting the noble a seat + its fields together? (Extend `grantFief` /
  `Noble.fief` from one plot to a territory.)
- **Population growth & migration.** Each village grows its own population (births/immigration); is
  there migration *between* villages (a full village overflows to a neighbour, or to a caravan — the
  P2 landless-emigration outlet)?
- **Village size.** Seat stacking (P2 cap ~20) + fields; what's a healthy village size vs the ~30 per
  city?
- **Determinism.** Per-village fan-out must keep the seed-reproducible order (villages stepped in a
  stable order; no new economic RNG stream leakage).

## 6. Relation to what's shipped

This is the natural next storey on the vassalage: P1–P5 gave the tree (ruler→nobles→peasants), fiefs
(`Plot.ownerId`), the grant decree, dues, and inheritance. The city-of-hamlets makes the fief a
first-class **place** with its own people and tick. It does **not** depend on closing the
**food-building gap** (food-producing buildings have no engine effect yet): urban fields feed the city
on their own (see §8), so food buildings are an additive bonus to the land whenever they land, not a
prerequisite.

## 7. How a Hamlet aligns with the tier + rank ladders

Two **orthogonal** ladders; a Hamlet sits on both, and "Village" touches each differently.

- **Size — `SettlementTier` (`CAMP<COTTAGE<HAMLET<SMALLHOLDING<TOWN<METROPOLIS`).** The old "Village"
  is now the **`SMALLHOLDING`** rung — where a settlement boots its own **Ruler** and becomes a real,
  self-governing colony (16+ households). A `Hamlet` caps one rung below at **`HAMLET`** (9–15), to
  stay a *dependent* unit. So they are a **continuum**: a Hamlet is a proto-Village, and the old
  "Village" (`SMALLHOLDING`) is a grown-up, independent Hamlet. An *incorporated* hamlet caps at
  HAMLET and overflows to the city pool; an *unincorporated* one that outgrows HAMLET **graduates into
  a `SMALLHOLDING`** colony (the V4 promotion → seed a second city).
- **Governance — the `Rank` ladder.** `Rank.VILLAGE` is **not a place** — it is the command rank a
  **city ruler** holds (`SettlementTier.headRank` maps SMALLHOLDING/TOWN → Ruler `Rank.VILLAGE`,
  METROPOLIS → Mayor `Rank.CITY`). The vassalage tree already IS this ladder: **city ruler
  (`Rank.VILLAGE`/`CITY`) → hamlet leader (`Rank.HOLDING` noble) → peasants (`Rank.HOUSEHOLD`)**. A
  Hamlet is the geographic cell a `HOLDING` noble governs, one rung under the ruler. Size and
  governance are independent — a HAMLET-*sized* place is *noble*-governed, no conflict.
- **The incorporation seam.** HAMLET's *derived* head-rank is a Captain (`Rank.CARAVAN`) — a
  *standalone* HAMLET camp is Captain-led. An *incorporated* hamlet is Noble-led. So **incorporation
  swaps the head's rank**: a standalone Captain-led HAMLET, granted to a noble and pulled into a city,
  has its head become a `Rank.HOLDING` noble. That swap *is* the unincorporated→incorporated moment,
  and `grantFief` is the hook.
- **Not the tile-improvement.** The Civ4 `Cottage→Hamlet→Village→Town→Suburbs` line is a plot's cottage
  densifying — a different domain (`geo.Improvement`), not a settlement. Name overlap only: keep
  `geo.Improvement`-"Hamlet" (a tile stage) and `settlement.Hamlet` (the unit) clearly commented apart.

**In one line:** a Hamlet is the HAMLET-tier, `HOLDING`-governed *dependent* cell; a "Village"
(`SMALLHOLDING`) is what it *graduates into* when independent; `Rank.VILLAGE` is the ruler-rank above
it. One continuum — a hamlet is a colony-in-waiting — with governance layered on by the fief.

## 8. Urban ground is farmable ground (the map-regen decision)

The earlier premise — "an all-urban city cannot feed itself from village fields" — was **wrong**, and
correcting it is what unblocks the food model. Two facts about the shipped code:

- **`urban` is already an overlay on natural terrain, and `Plot.yields()` never reads it.** An urban
  plot's food yield is its natural terrain's yield (grassland ≈ 2, …). Urban does **not** zero food.
- **The real "no farm" gate is `Plot.hasRegularBuilding()`** (a firm occupant or a non-housing
  building) — read by `FoodEconomy.homePlotFoodYield` and by where an NFirm may raise its FARM. That
  is a *runtime, building-presence* fact, not the `urban` flag.

So an *unbuilt* urban plot already is a real field, farmable by home-plot subsistence and by an NFirm
(whose `yieldFactor(NECESSITY)` reads the same natural food). That is why fully-urban Dhenijansar
already feeds itself.

**The decision (the design-correct choice).** Stop doing yield surgery at generation. Today gen strips
urban cells to `FLAT` + `feature=null` + `bonus=null` — which pre-emptively *paves* even the unbuilt
field plots the hamlet economy needs. Instead:

- an urban plot keeps its **full natural yield stack** — terrain, relief, feature, **bonus** — like
  every other plot;
- `urban` is a **pure orthogonal overlay** (a zoning/footprint marker), *not* the plot's feature — it
  cannot occupy the yield-bearing feature slot, exactly as relief is orthogonal to terrain;
- **runtime `hasRegularBuilding()` decides paving**, at the plots actually built (the seat's manor,
  firms), not the whole footprint at gen;
- one gen-time guard survives: don't seat a city **core** on an unworkable peak.

**Why keep the full stack (not strip to bare terrain):**
1. *World-coherence.* `CityPlacement.foundValue` sites cities *on* good land (near bonuses); stripping
   models "the city bulldozed exactly the wheat it was founded next to" — backwards. Cities kept their
   peri-urban gardens and grazing.
2. *The map must matter inside cities.* The hamlet economy is a food **gradient** (field hamlets
   export, dense hamlets import, trading over the shared market). Bare, identical urban fields flatten
   that gradient to noise; feature/bonus/relief make "this hamlet sits on cattle land" a real economic
   difference — the whole reason a real imported map is worth having inside a city.
3. *The urbanization arc falls out for free.* As a city densifies, more plots gain a regular building,
   so its farmable base **shrinks as it grows** — rich land is a head start, not permanent immunity;
   the city drifts self-feeding → import-dependent naturally.
4. *Model consistency.* Urban stops being the one plot-type that is a `yields()` exception.

**The bonus is the load-bearing leg.** Features add yield only while *wild*; farming **clears** them,
so a farmed urban field loses its forest yield anyway (intended agronomy). A **food bonus, though, is
added to a cleared farm too** (`Plot.yields()`), so it carries "cities on good land feed better"
through to farming. Stripping the bonus was the real error; keeping it is what matters most.

**Roads → trails.** In the same spirit, urban plots are no longer **pre-paved** with a road network at
generation. A paved road is real infrastructure that a settlement *builds*; ground under a city starts
as a **trail** (`ROUTE_TRAIL`, the tier the Explorer pioneers) and is upgraded only by actual
route-building. Free paved cities were the routing analogue of free-farmland-stripping — an
unearned overlay masking the natural ground. Trails keep the plot honest: the city has to earn its
paving. (Routes are per-session state, not baked into the `.map`, so this is a route-stamping change,
not part of the `GEN_VERSION` field data — but it lands with the same regen so the two urban cleanups
ship together.)

**Cost (as-built).** A `MAP_VERSION` bump 9→10 (CI rebake → deploy → clear the plot cache — still
pending for prod). The feared **calibration re-tune did NOT materialize**: `YIELD_REFERENCE` was left
untouched and the full engine (463) + server (131) suites stayed green — `CanonicalRun`, the
ruler-colony survival tests, growth, and twin-settlement all pass. The reason the shift was mild: for
a *farmed* plot the only new food is a food **bonus** (features are cleared by farming; relief feeds
production, not food), so the aggregate food box moved within tolerance. The one fixture that needed a
touch was `SettlementCampFoundingTest` — its Dhenijansar forage plot got richer, so the camp climbed
before finishing its HUNTING_CAMP; pinned the forage rate to the design "typical ground" yield so the
test still measures the improvement mechanic, not the site's incidental richness.
