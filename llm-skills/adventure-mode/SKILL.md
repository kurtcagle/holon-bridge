---
name: adventure-mode
description: >
  Reference skill for Adventure Mode [AM] — the navigation, narration,
  and in-world action convention for exploring and acting on a holon
  graph through HolonBridge as a user-agent moving through space,
  rather than as a client issuing raw queries or lifecycle-verb calls
  directly. Load whenever HolonBridge is the active tool/dataset
  context, whenever Kurt enables or refers to "adventure mode," or when
  narrating a focus holon, presenting navigation options, rendering the
  navigation or action widget, moving/damaging/healing an agent,
  forming or leaving a group, or creating a new AM agent. Also trigger
  on: "adventure mode", "AM", "focus holon", "user-agent" (in the
  navigation/narrative sense), "portal", "navigation widget", "action
  widget", "currentLocation", "trackable property", "healthPoints",
  "currentWealth", "formGroup", "joinGroup", "leaveGroup",
  "createAgent", "proposeAgentPropertyUpdate". This is a living
  document — expect it to grow. See holonbridge for REST/MCP mechanics,
  holon-schema-patterns for how containment/connection predicates are
  modeled, and holon-lifecycle (kurtcagle/holon-bridge,
  SKILL.holon-lifecycle.md) for the full 17-verb reference and
  CommandEvent pipeline this skill's actions are built on. This skill
  is the *experience layer*: which verbs apply in an AM context, how
  they're invoked from narrative, and how both navigation and actions
  are surfaced as widgets.
---

# Adventure Mode

Adventure Mode (AM) is a way of presenting a holon graph to a person as
a space they move through and act within, rather than as a set of
SPARQL results or raw lifecycle-verb calls. It sits on top of ordinary
HolonBridge queries (`get_holon`, `sparql_select`, etc.) and the holon
lifecycle verb layer (`lib/lifecycle.js`, 17 verbs, full reference in
`holon-lifecycle`) — it doesn't change the data model or the verb
contracts, it changes how the graph is selected for display and how a
person triggers verbs without ever writing Turtle or SPARQL themselves.

AM datasets are the flat-graph style described in the lifecycle schema
(`urn:{dataset}:holons` / `:events` / `:ontology`) rather than the
per-holon schema/scene/events triad used by verbs 1–12. That's why AM's
action set below is a specific subset of the 17 — the ones built to
operate on flat AM-shaped graphs.

---

## Core state

At any point in AM there are these pieces of state:

| State | Meaning |
|---|---|
| **Active dataset** | Which Fuseki dataset/graph is currently being navigated (an AM-flat-graph dataset — `conn.dataset`) |
| **Focus holon** | The holon the user-agent is currently "at" — the center of the current view |
| **Active agent(s)** | The `holon:Agent` IRI(s) the narrative is currently following — may be solo or a group |
| **Group membership** | If the active agent is in a `holon:Group`, the group IRI and its member list stand in for individual `currentLocation` (see Groups below) |

Everything shown or actionable is derived from these plus the graph
structure and trackable-property state around the focus holon/agent.

---

## Part 1 — Navigation

### The four navigation directions

From any focus holon, a user-agent can move in exactly four directions.
These are always presented together, and only **one holon deep** in
each direction — AM never previews two hops ahead.

| Direction | Target | Notes |
|---|---|---|
| **Up** | The parent holon, along the containment (`holon:isPartOf`) edge toward the root of the holarchy | Always a single holon, even if the current holon has multiple containment trees — see "default focus" in holon-schema-patterns for how the primary parent is chosen. Structural reparenting (moving a holon itself in the tree) is the `moveHolon` verb — see Structural moves below — not something a player does |
| **Back** | The last holon entered | Navigation history, not graph structure — tracked client-side (in-conversation), not stored in the graph |
| **Scene (into)** | The focus holon's direct children (containment) | One row per child. This is where most navigation happens |
| **Connections (peer)** | Non-containment relations from/to the focus holon | Peers, not contents — a holon can connect anywhere in the holarchy, not just its own children |

### Agent travel vs. holon navigation

Two distinct things move in AM, and they're driven differently:

- **The viewer's focus holon** moves per the four directions above —
  purely a display/traversal concept, no graph write, no event.
- **An agent's `holon:currentLocation`** moves when the narrative has
  the agent actually travel somewhere — this **is** a graph write.
  There is currently no dedicated "travel"/"moveAgent" lifecycle verb;
  the established convention from live sessions is a direct property
  replace (`sparql_update` / `push_turtle` DELETE-INSERT on
  `holon:currentLocation`), the same way solo `currentLocation` is
  written when a `formGroup`/`leaveGroup` event doesn't apply. Treat
  this as a real gap, not a settled design — flag it if a cleaner verb
  (e.g. a future `travelAgent`) would remove the ad-hoc SPARQL step.
- When an agent is grouped, `currentLocation` lives on the **group**,
  not the member — see Groups below. Moving a grouped agent means
  moving the group.

---

## Part 2 — Actions

AM's action set is the five flat-graph lifecycle verbs from the 17-verb
schema (`schemas/lifecycle-verbs.schema.json` in `kurtcagle/holon-bridge`
is the source of truth for every param below — re-check it before
relying on exact signatures, this table is a summary, not the contract).

| Verb | Command type | Cap. gate | Use for |
|---|---|---|---|
| `createAgent` | `holon:CreateAgentCommand` | none enforced | Minting a new NPC/PC with baseline trackable properties (health, wealth, etc.), each baseline validated against its governing SHACL shape before anything is written |
| `proposeAgentPropertyUpdate` | `holon:ModelUpdateRequest` | none enforced | Any bounded numeric change to an agent — damage, healing, spending, earning. Validate-before-write: a shape violation throws and leaves no trace, never a partial write |
| `formGroup` | `holon:GroupFormedEvent` | none enforced | Starting a party/vehicle co-location — a tour group, a car's passengers. Purely spatial, not authority (see Groups below for the Group-vs-Team distinction) |
| `joinGroup` | `holon:GroupJoinEvent` | none enforced | Adding a member to an existing group. Never displaces the active member |
| `leaveGroup` | `holon:GroupLeaveEvent` (+ `holon:GroupDissolvedEvent` if it auto-dissolves) | none enforced | Removing a member. Requires `handoffTo` if the leaving member is active and others remain |

None of these five currently call `authorise()` — no capability gate
is enforced on them today, unlike verbs 1–12. Don't assume that's
permanent; don't invent a gate that isn't there either.

`moveHolon` (verb 12) is **not** part of this action set — it reparents
a holon in the containment tree (structural), not an agent within a
scene. See Structural moves below for when it does apply in an AM
context.

### createAgent

Use when the narrative introduces a new agent that needs to persist —
not for a background extra who'll never be referenced again. Requires
`agentIri`, `label`, `agentKind` (`Agent`/`Persona`/`Actor`), and an
optional `trackableProperties` array (`property`, `value`, optional
`capProperty`/`capValue`/`floor`). Omit `capValue` only if there's
truly no cap; if a `capProperty` is given, its current value must be
supplied since there's no live agent yet to query.

### proposeAgentPropertyUpdate

Use for every discrete numeric change during play — a wrench-swing hit,
a purchase, a heal spell. Always pass a human-readable `rationale`
(shows up in the event graph, and doubles as the narrative justification
you'd be writing anyway). `delta` is signed (negative for damage/spend,
positive for heal/earn). Don't hand-roll the new absolute value
yourself — let the verb compute previous + delta, clamp to cap, floor
at `floor` (default 0).

### Groups

`holon:Group` is a **spatial co-location carrier only** — a tour party,
a car's passengers — deliberately distinct from an organizational Team
or Corporation, which is capability/authority and modeled via
`holon:RoleBinding`, not location. Keep this distinction in narration
too: a group dissolving doesn't imply anyone lost authority or
standing, only that they're no longer physically together.

- `formGroup` requires the initiating (active) member to already have
  a `currentLocation` — the group forms there. Every initial member's
  individual `currentLocation` is then removed; the group's location
  becomes the single source of truth while grouped.
- Exactly one initial member is active (`activeMemberIri`); the rest
  join inactive.
- `joinGroup` never displaces the incumbent active member — new joiners
  are always inactive.
- `leaveGroup` restores the leaving member's own `currentLocation` from
  the group's current location. If the leaver is active and others
  remain, `handoffTo` is **required** — leaveGroup never silently picks
  a successor.
- If a group drops to one member, it auto-dissolves (tombstoned, not
  purged): that member's `memberOfGroup` link is removed, their
  independent `currentLocation` restored, and both a
  `GroupLeaveEvent` and `GroupDissolvedEvent` are written.

### Structural moves (moveHolon)

`moveHolon` changes `holon:isPartOf` — it's a containment-tree edit
(re-siting a holon itself, e.g. moving a shop from one district holon
to another as world-building evolves), not something a player action
triggers during ordinary play. It requires `Write` capability and
refuses to move a `holon:rootLocked` holon (registries, corridor
spines, journey indexes) without `force: true`. Reach for this when
Kurt is editing the world's structure, not when narrating a scene.

---

## Part 3 — Widgets

AM surfaces both navigation and actions as HTML+CSS button widgets via
`visualize:show_widget`, never as markdown links or tables. Markdown
links can't call HolonBridge tools; every actionable item is a
`<button>` wired to `sendPrompt(...)`, which sends a chat message that
Claude then interprets and resolves with the appropriate tool call
(`get_holon` for navigation, the relevant lifecycle verb for actions).

### Shared conventions

- **`sendPrompt` payload** is always a plain-language instruction
  carrying the target IRI or verb intent, so it reads sensibly if the
  person edits it before sending, e.g.:
  ```
  sendPrompt('Go to holon https://w3id.org/data/holons/ggsc-repository')
  sendPrompt('Damage Hobart Mercer by 2 HP — wrench slip')
  sendPrompt('Lina leaves the group, hand off to Jane')
  ```
- **Disable, don't hide**, buttons with no valid target (no `Up` at a
  root holon, no `Back` before any navigation, no `leaveGroup` for a
  solo agent).
- Text (narrative color, what's happening) goes in the response before
  the widget call; the widget itself carries only the one-line
  description/status plus button labels — no prose inside it.
- Icons: Tabler outline only, sized 16–20px, picked to fit meaning —
  don't invent new icon names.

### Navigation widget

- **Header row** — holon label (`rdfs:label`), muted `rdf:type` short
  name, leading icon (`ti-map-2` generic/root, `ti-building`
  structures, `ti-sun`/`ti-planet` celestial, `ti-users` groups,
  `ti-user` agents).
- **One-line description** — `holon:description` if present, else
  `rdfs:comment`.
- **Up / Back row** — two buttons side by side.
- **Scene section** — muted label "Scene — direct children", one
  full-width button per child (label + type tag + trailing `↗`).
- **Connections section** — same button style; omit the whole section
  (heading included) if there are no connections.
- Keep it to one screenful. 6+ children is a signal the containment
  model may need an intermediate holon — flag it, don't paginate.

```html
<div style="max-width:680px;">
  <h2 class="sr-only">Navigation widget for [holon name], showing available exits</h2>
  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem;">
    <div style="display:flex; align-items:center; gap:8px;">
      <i class="ti ti-map-2" style="font-size:20px; color:var(--text-accent);" aria-hidden="true"></i>
      <span style="font-size:16px; font-weight:500;">[Holon label]</span>
    </div>
    <span style="font-size:12px; color:var(--text-muted);">[type short name]</span>
  </div>
  <p style="font-size:14px; color:var(--text-secondary); margin:0 0 1.25rem;">[One-line description]</p>
  <div style="display:flex; gap:8px; margin-bottom:1.25rem;">
    <button onclick="sendPrompt('Go to holon [parent IRI]')" style="flex:1;"><i class="ti ti-arrow-up" style="font-size:16px; vertical-align:-3px; margin-right:6px;" aria-hidden="true"></i>Up</button>
    <button onclick="sendPrompt('Go to holon [previous IRI]')" style="flex:1;"><i class="ti ti-corner-up-left" style="font-size:16px; vertical-align:-3px; margin-right:6px;" aria-hidden="true"></i>Back</button>
  </div>
  <div style="font-size:13px; color:var(--text-secondary); margin-bottom:8px;">Scene — direct children</div>
  <div style="display:flex; flex-direction:column; gap:8px;">
    <button onclick="sendPrompt('Go to holon [child IRI]')" style="display:flex; align-items:center; justify-content:space-between; text-align:left; padding:0.75rem 1rem;">
      <span style="display:flex; align-items:center; gap:10px;"><i class="ti ti-[icon]" style="font-size:18px;" aria-hidden="true"></i>[Child label] <span style="font-size:12px; color:var(--text-muted);">[type]</span></span>
      <span aria-hidden="true">↗</span>
    </button>
    <!-- one button per child -->
  </div>
  <!-- Connections section, same button pattern, omitted entirely if empty -->
</div>
```

### Action widget

Render alongside (below) the navigation widget only when there's
something actionable at the current focus — an agent present with
trackable properties, a group that can be joined/left, or a scene
where creating a new agent makes narrative sense. Skip it entirely on
inert scenery holons (a plain waypoint with no agents).

- **Per-agent card** — agent label, icon `ti-user`, one row per
  trackable property showing current value (and cap if present, as
  `current / cap`), each with a compact `+`/`−` delta button pair
  rather than a free-text field — narration supplies the rationale
  text in the `sendPrompt` payload, not a form input.
- **Group actions** — if the focus holon's present agents include a
  group, show `Join group` for ungrouped agents present, `Leave group`
  for grouped ones (grouped members leaving get a target picker for
  `handoffTo` only when they're the active member and others remain —
  otherwise omit that step).
- **Create agent** — a single "New agent" button when the scene
  context suggests it (Kurt introduces a new named character); this
  should be rare enough that it's fine for it to just `sendPrompt` a
  generic "Create a new agent here" and let Claude ask the narrative
  follow-ups conversationally rather than fielding name/kind/property
  inputs in-widget.

```html
<div style="max-width:680px; margin-top:1rem;">
  <h2 class="sr-only">Actions available for [agent/scene name]</h2>
  <div style="display:flex; align-items:center; gap:8px; margin-bottom:0.5rem;">
    <i class="ti ti-user" style="font-size:18px;" aria-hidden="true"></i>
    <span style="font-size:15px; font-weight:500;">[Agent label]</span>
  </div>
  <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:1rem;">
    <div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0.75rem; border:0.5px solid var(--border); border-radius:var(--radius);">
      <span style="font-size:13px; color:var(--text-secondary);">[property label] — [current]/[cap]</span>
      <span style="display:flex; gap:4px;">
        <button onclick="sendPrompt('Damage [agent label] by 1 [property] — [context]')" style="padding:2px 10px;">−</button>
        <button onclick="sendPrompt('Heal [agent label] by 1 [property] — [context]')" style="padding:2px 10px;">+</button>
      </span>
    </div>
    <!-- one row per trackable property -->
  </div>
</div>
```

---

## Session bootstrap for AM

1. Confirm the HolonBridge endpoint is reachable (`get_endpoint`,
   `list_endpoints` if not).
2. Confirm the active dataset matches the world being explored
   (`list_datasets` / `switch_dataset`).
3. Resolve the focus holon — either explicitly stated by Kurt, or
   recovered from the most recent prior AM session (check recent
   chats for the last-known focus/Back-history/active-agent state if
   resuming cold).
4. Render focus-holon narration in prose, then the navigation widget,
   then the action widget if applicable.

---

## Related skills

- **holonbridge** — the MCP tool layer and REST API AM's queries and
  verb calls run through.
- **holon-lifecycle** (`kurtcagle/holon-bridge`, `SKILL.holon-lifecycle.md`)
  — the full 17-verb reference, CommandEvent pipeline, and capability
  model. AM's action set (Part 2) is a curated subset for play; go
  there for the complete contract, including the twelve non-AM
  structural verbs (`createRootHolon`, `addSchema`, `promoteEntity`,
  etc.) that don't apply during ordinary narrative play.
- **holon-schema-patterns** — containment vs. connection modeling
  decisions behind the four navigation directions.
- **sce** — parent architecture (CommandEvent/AssertionEvent pipeline,
  boundary/portal vocabulary) both this skill and holon-lifecycle
  build on.
