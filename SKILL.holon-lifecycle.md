---
name: holon-lifecycle
description: >
  Reference skill for the holon lifecycle verb layer -- eleven commands
  (createRootHolon, addSchema, addEntity, promoteEntity, addProjection,
  modifyEntity, annotateProperty, listHolonContents, editMetadata,
  deleteHolon, designateAgent) built on top of HolonBridge, plus the
  test-only clearHolarchy utility. Load this skill whenever working on the
  holon lifecycle library (lib/lifecycle.js in kurtcagle/holon-bridge),
  its P4 MCP tool group, the holon CLI, entity-to-holon promotion,
  holon:portalPotential / holon:holonEligible, the holon ACL/RoleBinding
  capability model, or holon tombstoning/purging. Also trigger on:
  "holon lifecycle", "portalPotential", "holonEligible", "RoleBinding",
  "promoteEntity", "clearHolarchy", or "lifecycle verb".
---

# Holon Lifecycle Skill

The holon lifecycle layer is a set of eleven command verbs, implemented in
`lib/lifecycle.js` in the `kurtcagle/holon-bridge` repository, that give
CRUD-plus-promotion access to holons over HolonBridge's existing SPARQL/GSP/
SHACL primitives. It is a **command-verb layer, not new infrastructure** --
every verb terminates in the CommandEvent pipeline already documented in the
`sce` skill (`validate -> authorise -> execute -> assert -> log -> update`).

**This skill is intentionally ahead of `sce`/HGA-proper.** It uses the
newly-registered `https://w3id.org/holon/` namespace rather than `sce`'s
`https://ontologist.io/ns/holon#`. That divergence is deliberate -- getting
the namespace right here was judged worth a temporary inconsistency, to be
reconciled (likely via `owl:sameAs` bridging) once w3id stabilises.

---

## Quick orientation

| Need | Go to |
|---|---|
| The eleven verbs and their signatures | [The Eleven Verbs](#the-eleven-verbs) |
| Source of truth for signatures | `schemas/lifecycle-verbs.schema.json` in `holon-bridge` |
| Entity vs. holon boundary | [Lazy Holon Realization](#lazy-holon-realization) |
| Reification approach | [Property Annotation](#property-annotation) |
| Deletion semantics | [Tombstone and Purge](#tombstone-and-purge) |
| ACL / capability model | [Ownership and Capability](#ownership-and-capability) |
| Test-only wipe utility | [clearHolarchy](#clearholarchy-test-only) |
| Where the code actually lives | [Implementation Surface](#implementation-surface) |

---

## Lazy Holon Realization

An entity is not statically "a holon or not." It carries **portal
potential** from the moment it's instantiated, and promotion is a deferred
activation triggered only when something actually crosses through it. This
is what keeps the holarchy from going infinitely deep -- cost is one triple
until crossed, not a cascade of registered holons for every entity that
theoretically could become one.

**Eligibility is declared once, on the schema, not decided per-entity:**

```turtle
@prefix sh:    <http://www.w3.org/ns/shacl#> .
@prefix holon: <https://w3id.org/holon/> .

ex:WardShape a sh:NodeShape ;
    sh:targetClass ex:Ward ;
    holon:holonEligible true ;
    holon:eligibleChildSchema ex:WardHolonRootShape .   # single root shape,
    # NOT a bundled schema graph -- open question, deferred until Datavid
    # gives a real templated-sub-holon test case. If child holons need to
    # come into existence fully-formed with a repeated set of pre-populated
    # entity types, revisit toward the bundle approach.

ex:PatientShape a sh:NodeShape ;
    sh:targetClass ex:Patient ;
    # no holon:holonEligible -- patients are never promotable in this domain
    sh:property [ sh:path ex:patientName ; sh:minCount 1 ] .
```

**`addEntity` (verb 3)** checks the matched shape at instantiation time. If
eligible, it stamps `holon:portalPotential` -- no new named graphs, no
registry entry, no ACL binding yet:

```turtle
:ward-icu-3 a ex:Ward ;
    ex:wardName "ICU 3" ;
    holon:portalPotential ex:WardHolonRootShape .   # unresolved
```

**`promoteEntity` (verb 4)** is the only verb that resolves potential into
an actual `holon:targetHolon` link. It mints the child's schema/scene/event
graphs, seeds the child's root boundary from `eligibleChildSchema`, and
leaves a portal stub in the parent -- the entity is never silently removed
or replaced, it becomes the crossing point. Rejects (does not silently
no-op) if called on an entity with no unresolved potential, or one already
resolved.

Requires the `Promote` capability specifically -- deliberately distinct
from plain `Write`, since spawning a new holon and its attendant
sub-holarchy is a more consequential act than an ordinary property edit.

---

## Property Annotation

**RDF 1.2 / Turtle 1.2 native reification**, not RDF-star quoted triples as
a separate spec, not classic `rdf:Statement` reification. Jena 6.0 Fuseki
supports this natively and it's the right fit given the rest of the stack
is already RDF 1.2 / SHACL 1.2.

```turtle
<< <urn:patient:jane> ex:bedNumber "12" >> a holon:AssertionEvent ;
    holon:note "Reassigned after ICU transfer" ;
    prov:wasGeneratedBy <urn:agent:eva> ;
    holon:receivedAt "2026-07-07T14:00:00Z"^^xsd:dateTime .
```

`annotateProperty` (verb 7) is the only verb that writes this shape. It
does not mutate the underlying triple -- that's `modifyEntity`'s job.
Annotation and modification are deliberately separate verbs: one records
an event *about* a property, the other changes the property's value.

---

## Tombstone and Purge

The event graph is append-only, per the `sce` pipeline design -- deletion
can never touch it. Two distinct operations, not one with a flag:

- **`deleteHolon` (verb 10)**: sets `holon:status` to
  `holon:TombstonedStatus`. Reversible in principle (nothing is destroyed).
  Requires `Owner` capability.
- **`purgeHolon`**: hard-deletes schema/scene graphs of an
  *already-tombstoned* holon. Requires explicit `confirm: true` in addition
  to `Owner`. Scheduling of when purge actually runs (immediate on request
  vs. a periodic GC pass) is **still TBD** -- not yet decided, don't assume
  either.

Neither operation is `clearHolarchy` -- see below.

---

## Ownership and Capability

`holon:RoleBinding` is **anchored at the holon where it was granted**, and
`authorise()` walks `holon:parentHolon` *upward* from the target holon,
stopping at the first binding it finds. This produces subtree ownership by
construction: a binding anchored at `:icu` grants everything at and below
`:icu`, but `authorise()` starting from a sibling ward or from the parent
never reaches it.

Capability set: `Read`, `Write`, `Promote`, `Grant`, `Owner` (implies all
the rest). Two enforced guards, not just documented conventions:

1. **Escalation guard** (`designateAgent`, verb 11): a grantor can only
   issue capabilities that are a subset of their own. A `Write`-only
   delegate cannot further delegate at all, since they lack `Grant`.
2. **Anchor cannot rise**: a delegate's `boundHolon` must be the anchor
   holon or a descendant of the grantor's own anchor -- never an ancestor
   or a sibling.

**`promoteEntity` does not create a new binding by default.** The realized
child inherits the parent's `Owner` binding rather than requiring fresh ACL
bootstrapping on every lazy realization -- otherwise the "cheap until
crossed" property of portal potential would be undercut by an ACL write on
every promotion. Explicit re-assignment is still possible via
`designateAgent` afterward if a different owner is wanted for the subtree.

This is deliberately coarse -- Read/Write/Promote/Grant/Owner, no
delegation chains, no time-bound grants, no cryptographic proof of Role.
Fine-grained VC/profile work belongs to the W3C HCG Identity WG
(`HGA_VC_ACL`, rescoped 2026-07-03) -- this layer should not quietly
duplicate that scope.

---

## clearHolarchy (test-only)

Recursive, unconditional hard delete of a holon and every
`holon:parentHolon`-descendant, including registry records. Exists purely
to recover from a bad test run -- **not part of the eleven-verb surface,
never registered as an MCP tool, no `holon:*Command` type, generates no
event.**

Lives in `test-utils/clear-holarchy.js`, a directory boundary deliberately
separate from `lib/lifecycle.js` so it can never be imported by production
code paths by accident.

Double-gated:
1. `opts.confirm === true`
2. `process.env.ALLOW_HOLARCHY_WIPE === '1'` -- a dedicated variable, not
   `NODE_ENV`, since `NODE_ENV` gets used for unrelated purposes and
   shouldn't double as a destructive-operation safety gate.

CLI-only exposure: `holon test:clear-holarchy --root <iri> --confirm
[--dry-run]`. If you're looking for how to invoke this from an agent
conversation -- you can't, by design.

---

## The Eleven Verbs

Full parameter/return contracts live in
`schemas/lifecycle-verbs.schema.json` in `holon-bridge` -- that JSON Schema
is the source of truth; `lib/lifecycle.js` (plain JS + JSDoc, matching the
existing `auth.js`/`sparql.js`/`shacl.js` convention -- no TypeScript) and
any future Python bindings are both generated-or-hand-written consumers of
it, not independent implementations. Python bindings are deliberately
deferred until Miguel's Datavid task list gives a concrete integration
case to design against, rather than guessing at the shape now.

| # | Verb | Command type | Capability |
|---|---|---|---|
| 1 | `createRootHolon` | `holon:CreateRootHolonCommand` | none |
| 2 | `addSchema` | `holon:AddSchemaCommand` | Write |
| 3 | `addEntity` | `holon:AddEntityCommand` | Write |
| 4 | `promoteEntity` | `holon:PromoteEntityCommand` | Promote |
| 5 | `addProjection` | `holon:AddProjectionCommand` | Write |
| 6 | `modifyEntity` | `holon:ModifyEntityCommand` | Write |
| 7 | `annotateProperty` | `holon:AnnotatePropertyCommand` | Write |
| 8 | `listHolonContents` | *(none -- pure read)* | Read |
| 9 | `editMetadata` | `holon:EditMetadataCommand` | Write |
| 10 | `deleteHolon` / `purgeHolon` | `holon:DeleteHolonCommand` / *(none)* | Owner |
| 11 | `designateAgent` | `holon:DesignateAgentCommand` | Grant |

Every mutating verb is **DataBook-in / DataBook-out** at the boundary --
Turtle/SPARQL/JSON are internal transport only, never returned directly to
callers. Every mutating verb takes an `actor: {iri}` parameter, both for
the `prov:wasGeneratedBy` trail and for the `authorise()` capability check.

---

## Implementation Surface

| Artifact | Location | Purpose |
|---|---|---|
| `lifecycle-verbs.schema.json` | `holon-bridge/schemas/` | Source of truth for the eleven signatures |
| `lib/lifecycle.js` | `holon-bridge/lib/` | Real execution, plain JS/JSDoc, alongside `auth.js`/`sparql.js`/`shacl.js` |
| `test-utils/clear-holarchy.js` | `holon-bridge/test-utils/` | Test-only wipe, isolated by directory boundary |
| `bin/holon.js` | `holon-bridge/bin/` | CLI wrapper, imports `lifecycle.js` directly (same relationship the DataBook CLI has to `push_turtle`/`get_holon`) |
| P4 MCP tool group | `holonbridge-mcp` | Agent-callable wrappers over the same library (not yet built -- next step) |
| This skill | `/mnt/skills/user/holon-lifecycle/` | Design rationale and vocabulary reference |

**Known gaps in the current build** (flagged inline in `lifecycle.js` as
`NOTE`/`TODO` comments, not silently glossed over):
- `promoteEntity`'s resolution step doesn't yet DELETE the resolved
  `holon:portalPotential` triple -- needs a `sparql_update` wrapper in
  `sparql.js`, which doesn't exist yet (only `runQuery`/`runConstruct`/
  `pushToGraph` via GSP do).
- `editMetadata` and `deleteHolon` append new status/title triples via GSP
  POST rather than replacing prior values via DELETE/INSERT -- same
  missing `sparql_update` wrapper dependency.
- `addEntity`'s eligibility-matching SPARQL is a stub -- it detects that
  *a* holon-eligible shape exists in the schema graph but doesn't yet join
  that against the specific entity's asserted `rdf:type` from the pushed
  Turtle.
- The `Promote`-capability-inherits-to-child behavior in `promoteEntity` is
  implemented as "don't write a new binding," which is correct per the
  design decision above, but hasn't been tested against a multi-level
  promotion chain.

These are first-build gaps, not silent shortcuts -- the fix in every case
is the same missing primitive (`sparql_update` in `sparql.js`), so that's
the natural next infrastructure step before the eligibility-matching and
metadata-update gaps can close properly.

---

## Related Skills

- **sce** -- Parent architecture: the nine-stage pipeline, CommandEvent/
  AssertionEvent vocabulary, boundary-vs-portal distinction this skill
  extends.
- **holonbridge** -- The MCP tool layer and REST API this skill's verbs are
  built on (`sparql_select`, `push_turtle`, `validate_turtle`, etc.).
- **databook** -- DataBook format; `buildDataBook`/`DataBook` are this
  skill's serialize/parse pair, mirroring `databook push`/`pull`.
