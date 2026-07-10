---
name: adventure-mode
description: >
  Reference skill for Adventure Mode [AM] — the navigation and narration
  convention for exploring a holon graph through HolonBridge as a
  user-agent moving through space rather than as a client issuing raw
  queries. Load whenever HolonBridge is the active tool/dataset context,
  whenever Kurt enables or refers to "adventure mode," or when narrating
  a focus holon, presenting navigation options, or rendering the
  navigation widget. Also trigger on: "adventure mode", "AM", "focus
  holon", "user-agent" (in the navigation/narrative sense), "portal",
  "holon:description", "navigation widget", "navigation table", "last
  holon entered". This is a living document — expect it to grow. See
  holonbridge for REST/MCP mechanics and holon-schema-patterns for how
  containment/connection predicates are modeled; this skill is about the
  *experience layer* on top of both.
---

# Adventure Mode

Adventure Mode (AM) is a way of presenting a holon graph to a person as
a space they move through, rather than as a set of SPARQL results. It
sits on top of ordinary HolonBridge queries (`get_holon`, `sparql_select`,
etc.) — it doesn't change the data model, it changes how the data is
selected for display and how it's navigated.

---

## Core state

At any point in AM there are exactly two pieces of state:

| State | Meaning |
|---|---|
| **Active dataset** | Which Fuseki dataset/graph is currently being navigated |
| **Focus holon** | The holon the user-agent is currently "at" — the center of the current view |

Everything else (what's shown, what's navigable) is derived from these
two values plus the graph structure around the focus holon.

---

## The four navigation directions

From any focus holon, a user-agent can move in exactly four directions.
These are always presented together, and only **one holon deep** in
each direction — AM never previews two hops ahead.

| Direction | Target | Notes |
|---|---|---|
| **Up** | The parent holon, along the containment (`holon:isPartOf`) edge toward the root of the holarchy | Always a single holon, even if the current holon has multiple containment trees — see "default focus" in holon-schema-patterns for how the primary parent is chosen |
| **Back** | The last holon entered | This is navigation history, not graph structure — tracked client-side (in-conversation), not stored in the graph |
| **Scene (into)** | The focus holon's direct children (containment) | One row per child. This is where most navigation happens |
| **Connections (peer)** | Non-containment relations from/to the focus holon | Peers, not contents — a holon can connect anywhere in the holarchy, not just its own children |

---

## Navigation widget

**Default presentation.** Whenever AM is active and a focus holon is
narrated, render the navigation options as an HTML+CSS button widget
via `visualize:show_widget`, not as a markdown list or table. The
widget is the primary way a person moves through the graph — narration
text describes what's there, buttons are how they act on it.

### Why buttons, not markdown links

Ordinary markdown links can't call HolonBridge tools. Every navigable
holon in the widget is a `<button>` wired to `sendPrompt(...)`, which
sends a chat message that Claude then interprets as a navigation
request and resolves with `get_holon`. Buttons, not `<a href>` — there
is no page to link to, only a conversational action to trigger.

### Convention for the sendPrompt payload

Always phrase it as a plain-language navigation instruction carrying
the target IRI, so it reads sensibly if the person edits it before
sending:

```
sendPrompt('Go to holon https://w3id.org/data/holons/ggsc-repository')
```

Claude receiving that message should call `Holon Bridge 2:get_holon`
on the given IRI, update the focus-holon state, push the previous
focus onto the Back history, and re-render the widget for the new
holon.

### Layout

- **Header row** — holon label (from `rdfs:label`), a small muted tag
  showing its primary `rdf:type` short name, left-aligned icon picked
  to fit the holon's type (`ti-map-2` generic/root, `ti-building` for
  structures, `ti-sun`/`ti-planet` for celestial bodies, `ti-users` for
  groups, `ti-user` for agents — pick the closest Tabler icon rather
  than inventing one).
- **One-line description** directly under the header, from
  `holon:description` if present, otherwise `rdfs:comment`.
- **Up / Back row** — two buttons side by side. Disable (don't hide)
  whichever has no target: no `Up` at a root holon, no `Back` before
  any navigation has happened yet in the session.
- **Scene section** — a small muted section label ("Scene — direct
  children"), then one full-width button per child, each showing the
  child's label plus its type as a trailing muted tag, and a trailing
  `↗` to signal it triggers an action.
- **Connections section** — same button style, only rendered when the
  focus holon actually has connections. Omit the whole section
  (heading included) rather than showing an empty state.
- Keep it to one screenful. If a holon has many children (6+), this is
  a signal the containment model may need an intermediate holon — flag
  it rather than cramming the widget; don't paginate within the widget.

### What stays in prose, not the widget

Narrative color — what the place looks like, what NPCs are doing,
scene-setting — belongs in the response text before the widget call,
per the standard visualizer rule (text outside, visual inside). The
widget itself carries no prose beyond the one-line description and
the button labels.

### Reference implementation

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
    <button onclick="sendPrompt('Go to holon [parent IRI]')" style="flex:1;">
      <i class="ti ti-arrow-up" style="font-size:16px; vertical-align:-3px; margin-right:6px;" aria-hidden="true"></i>Up
    </button>
    <button onclick="sendPrompt('Go to holon [previous IRI]')" style="flex:1;">
      <i class="ti ti-corner-up-left" style="font-size:16px; vertical-align:-3px; margin-right:6px;" aria-hidden="true"></i>Back
    </button>
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

Disable (not hide) `Up`/`Back` buttons with no target: `disabled
style="opacity:0.4; cursor:default;"` and no `onclick`.

---

## Session bootstrap for AM

1. Confirm the HolonBridge endpoint is reachable (`get_endpoint`,
   `list_endpoints` if not).
2. Confirm the active dataset matches the world being explored
   (`list_datasets` / `switch_dataset`).
3. Resolve the focus holon — either explicitly stated by Kurt, or
   recovered from the most recent prior AM session (check recent
   chats for the last-known focus/Back-history if resuming cold).
4. Render focus-holon narration in prose, then call the navigation
   widget.
