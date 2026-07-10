---
name: holon-schema-patterns
description: >
  Design patterns for extending the holon data model with new domain
  schemas — containment vs. connection, when to split a predicate by
  scale vs. when dual-assertion is fine, marking cross-cutting facets
  vs. primary taxonomy, and how a holon can be a connection-peer in one
  tree while also being the containment root of its own. Load whenever
  adding a new geo:/sol:/domain class or property to
  urn:{dataset}:ontology, whenever a relationship doesn't obviously fit
  isPartOf or an existing connection predicate, or when checking whether
  a model change will actually be visible to get_holon. Modeling-pattern
  skill, not an API reference — see holonbridge for REST/MCP mechanics
  and sce for the broader HGA/SCE architecture. Also trigger on: "holon
  role discovery", "isPartOf vs isConnectedTo", "containment vs
  connection", "composition facet", "administrativePartOf",
  "subPropertyOf holon", "holon:Home", "default focus", "multi-tree
  containment".
---

# Holon Schema Patterns

This skill captures how the holon data model (as implemented by
`lib/holon.js` in `kurtcagle/holon-bridge`) is meant to be *extended* —
the decisions a schema designer makes when adding a new domain, not how
the bridge's REST API works day to day (see the **holonbridge** skill for
that) or how HGA/SCE fits together architecturally (see **sce**).

The single load-bearing idea behind everything here:

> **`lib/holon.js` hardcodes exactly two predicate names —
> `holon:isPartOf` and `holon:isConnectedTo` — and nothing else. It
> discovers every other participating predicate at query time via
> `rdfs:subPropertyOf*`. A schema opts into holon traversal purely by
> declaring `myPredicate rdfs:subPropertyOf holon:isPartOf` (or
> `holon:isConnectedTo`) — never by editing the traversal code.**

This works with zero RDFS/OWL reasoner: `rdfs:subPropertyOf*` is a
SPARQL property path, evaluated as pure graph traversal over asserted
triples, not model-theoretic entailment. That's what makes the pattern
functionally real rather than semantically-true-but-inert documentation.

**A subproperty declaration alone changes nothing you can see.** It has
to be paired with actually asserting the new predicate on instance data,
*and* the declaration has to exist in some graph the dataset's traversal
queries reach (graph-agnostic — any named graph works, no special
"ontology graph" is required by the code, though keeping one canonical
`urn:{dataset}:ontology` per dataset is the convention this project
follows). Declaring the subproperty relationship and then forgetting to
use it, or using it while assuming the traversal already knows about it,
is the single most common way this pattern silently fails to do
anything — verify with a live `get_holon` call, not just by reading the
ontology triples back.

---

## Decision 1: containment or connection?

Every new relationship between two holons is one or the other. Ask:

> **Does X occupy one scale-slot under Y, roughly exhaustively and
> exclusively?**

- **Yes → containment.** Declare `rdfs:subPropertyOf holon:isPartOf`.
  A child has (at most) one parent via a given containment chain; a
  parent's children are its scale-decomposition, one hop down.
- **No → connection.** Declare `rdfs:subPropertyOf holon:isConnectedTo`.
  Peers, not scene contents. A holon may have any number of connections,
  to holons anywhere in the graph, and connections don't imply exclusive
  ownership in either direction.

Worked example: a sea borders the continents around it but is not
contained by any of them — `geo:borders rdfs:subPropertyOf
holon:isConnectedTo`, not `isPartOf`. A country sits inside exactly one
continent (administratively, if imperfectly) — `geo:administrativePartOf
rdfs:subPropertyOf holon:isPartOf`.

**Getting this wrong is a real failure mode, not just an aesthetic one.**
Forcing a many-to-many or non-exclusive relationship into containment
means `fetchHolonProjection()`'s parent query (`LIMIT 1`) silently drops
every candidate parent but one — there's no error, just quietly wrong
data. If a relationship might legitimately point at more than one holon,
or might not imply exclusive ownership, it's a connection, full stop.

### Connections are checked in both directions — asymmetric relations included

Containment is directional by convention (a child points at its parent).
Connections are queried in **both** directions, because the schema
designer might assert `A geo:borders B` or `B geo:borders A` — nothing
forces one direction, symmetric property or not. This also means
genuinely asymmetric connection predicates (e.g. `geo:nextJunction`, a
directional "next stop on a route" relation) work correctly with zero
special-casing: querying from the source shows the target `outbound`;
querying from the target shows the source `inbound`. Don't build a
separate "previous" predicate for the reverse direction — the
bidirectional connections query already reconstructs it.

---

## Decision 2: does this predicate need a scale split?

The overload smell: one predicate is being asked to mean two genuinely
different facts depending on which kind of holon is the subject.

Concretely: `Europe geo:borders Mediterranean` (a whole continent's
coastal exposure) and `France geo:borders Mediterranean` (one country's
specific coastline) are **not the same kind of fact**, even though both
would naturally collapse onto one `geo:borders` predicate. The fix:
declare scale-specific subproperties under the shared parent —

```turtle
geo:continentalCoastline rdfs:subPropertyOf geo:borders .
geo:nationalCoastline    rdfs:subPropertyOf geo:borders .
```

— both still transitively discoverable as `holon:isConnectedTo` (since
`rdfs:subPropertyOf*` chains through multiple hops), but now
distinguishable when it matters. Migrate existing over-generic triples
with a scoped `DELETE`/`INSERT` `WHERE` rather than leaving the generic
predicate half-populated:

```sparql
DELETE { GRAPH <g> { ?s geo:borders ?o } }
INSERT { GRAPH <g> { ?s geo:continentalCoastline ?o } }
WHERE  { GRAPH <g> { ?s geo:borders ?o . FILTER(?s = <specific-continent>) } }
```

### When *not* to split: same fact, different granularity

Contrast with a river: `Seine geo:crosses France` and `Seine geo:crosses
Paris` are **the same underlying fact** (the river's path) asserted at
two nested granularities, not two competing accounts of a border. Both
are simply true, simultaneously, no conflict. Dual-assert at every
relevant level rather than inventing `geo:crossesCountryScale` /
`geo:crossesCityScale` — that would be over-engineering a distinction
that doesn't actually exist in the underlying reality. The test: **do
the two assertions ever disagree about what's true?** If yes, split the
predicate. If they're just the same fact viewed at different zoom, don't.

### A third relation kind: deliberate construction, not incidental passage

`geo:crosses` (natural feature incidentally spanning territory) and
`geo:borders` (passive water adjacency) don't cover everything. A tunnel
or bridge is neither — it's a **deliberate, point-to-point link between
exactly two named endpoints**, built specifically to join them. That's
a third sibling under `holon:isConnectedTo`:

```turtle
geo:connects a owl:ObjectProperty , owl:SymmetricProperty ;
    rdfs:subPropertyOf holon:isConnectedTo ;
    rdfs:comment "Direct, deliberate, point-to-point link via constructed infrastructure — distinct from geo:crosses (incidental) and geo:borders (passive adjacency)." .
```

Don't reach for `crosses` just because something spans two regions —
check whether the relationship is incidental (crosses), passive
(borders), or purpose-built (connects) before picking a predicate.

---

## Decision 3: is this a primary type or a cross-cutting facet?

RDF's multi-`rdf:type` mechanism lets one instance carry several
classes at once — but nothing about that syntax distinguishes "this is
what kind of thing you fundamentally are" from "this is an additional
property that happens to also be modeled as a type." Both look
identical in a plain `rdf:type` listing, and that ambiguity is a real
trap for anyone (human or automated) reading the data cold.

Fix: declare **meta-classes** marking each axis, using OWL punning (a
class that is itself an instance of another class):

```turtle
sol:CelestialBodyKind a owl:Class ;
    rdfs:comment "Meta-class for the primary Star/Planet/Moon taxonomy — mutually exclusive, exactly one per instance." .

sol:CompositionFacet a owl:Class ;
    rdfs:comment "Meta-class for cross-cutting composition classifications — zero or more per instance, layered on top of the primary kind." .

sol:Planet a sol:CelestialBodyKind .
sol:IcyBody a sol:CompositionFacet .
```

Now any tool can separate the two axes with a query that names zero
domain-specific classes:

```sparql
SELECT ?type ?axis WHERE {
  <holon> a ?type .
  { ?type a sol:CelestialBodyKind . BIND("primary" AS ?axis) }
  UNION
  { ?type a sol:CompositionFacet . BIND("facet" AS ?axis) }
}
```

This is the class-level twin of the property-level `isPartOf`/
`isConnectedTo` split above — same idea, one level down. If you're
adding a new class that's genuinely a sibling of an existing taxonomy
(a new planet type), mark it against the `*Kind` meta-class. If it's a
property some instances have and others don't, independent of their
primary type (icy, has-rings, is-tidally-locked), mark it as a facet.

### When the composition question needs more than a boolean

A meta-class facet is right for a yes/no property (icy or not). It's
wrong the moment you need *degree* — "how icy," "what fraction rock vs.
gas," a ranking, or interaction between multiple graded properties.
That's the point to introduce a real object/datatype property
(`sol:composition` with a literal fraction, or pointing at a controlled
vocabulary) instead of stretching a boolean facet to carry information
it can't honestly hold. Don't build that machinery pre-emptively —
build it when a real question needs it.

### Introducing a missing tier

Real-world hierarchies sometimes have a level your two-tier model didn't
anticipate — e.g. constituent countries (England, Wales, Scotland,
Northern Ireland) sitting between sovereign country and city. Don't
force them into `Country` (factually wrong — they're not directly
`administrativePartOf` a continent) or `City` (wrong scale). Add the
missing class:

```turtle
geo:ConstituentCountry a owl:Class ;
    rdfs:subClassOf geo:GeographicRegion ;
    rdfs:comment "A nation/state that is itself part of a larger sovereign country — a genuine third tier between Country and City." .
```

---

## Decision 4: can a holon be a connection-peer in one tree and the root of its own?

Yes, and nothing in `lib/holon.js` assumes otherwise — it never assumed
a single containment tree rooted at one node. A holon can simultaneously:

- Be a **connection-peer** in the "main" geographic/domain tree (e.g. a
  highway `geo:crosses` two countries), *and*
- Be the **containment root** of an entirely separate tree of its own
  (e.g. that highway's junctions, via a dedicated route-scoped
  containment predicate)

```turtle
geo:isPartOfRoute rdfs:subPropertyOf holon:isPartOf ;
    rdfs:comment "Containment for a route's own internal segments — a third sense of 'part of', distinct from geo:administrativePartOf and orbital holon:isPartOf." .
```

The two trees connect only through the highway holon's own `geo:crosses`
edges — there is no requirement that every containment relationship in
a dataset ultimately trace back to one universal root.

### Ordered paths fall out of the same connection mechanism — no new machinery needed

A sequence (route stops, pipeline stages, any ordered chain) doesn't
need `rdf:List`, a sequence-number-only scheme, or bespoke ordering
logic. A directional connection predicate *is* a path:

```turtle
geo:nextJunction rdfs:subPropertyOf holon:isConnectedTo ;
    rdfs:comment "Directional adjacency between consecutive stops — NOT symmetric." .
```

Reconstruct the full ordered chain from any starting point with one
property-path query — the same SPARQL feature (`propertyPath*`) that
powers role discovery itself, applied to a chain instead of a taxonomy:

```sparql
SELECT ?stop WHERE {
  <start> geo:nextJunction* ?stop .
}
```

A parallel `geo:sequenceNumber` integer literal is a reasonable
redundant convenience for simple `ORDER BY` sorting, but the `next*`
chain is the actual source of truth — if the two ever disagree, trust
the chain and treat the sequence numbers as stale.

---

## Decision 5: is this a Place, or an occupant of one?

A sharper, class-level generalization of Decision 1, for the recurring
case of non-geographic entities (organizations, agents) that have a
location but aren't themselves locations.

> **`holon:isPartOf` (and every subproperty of it in the geographic
> branch) only ever relates two `geo:GeographicRegion` instances.**

`geo:GeographicRegion` is this holarchy's "Place" class — the class
that answers *"Where?"* and has physical extent: Country, City,
Continent, GeoFeature, Infrastructure. If either side of a candidate
containment edge isn't `GeographicRegion`, the answer is connection,
full stop — no case-by-case reasoning needed, it's a type check.

**Organizations and Agents are occupants, never Places.** An
organization doesn't sit *inside* a country the way a city does — it's
*located in* one, a materially different relationship even though both
might loosely be described as "in Germany." The tell: an org can be
headquartered in one place but maintain facilities in several (multi-
campus institutions, multi-site agencies) — the moment a relationship
can legitimately point at more than one target, Decision 1 already
rules out containment. Occupancy is a connection:

```turtle
bacm:Organization owl:disjointWith geo:GeographicRegion .
holon:Agent        owl:disjointWith geo:GeographicRegion .

ggsc:basedInRegion rdfs:subPropertyOf holon:isConnectedTo ;
    rdfs:domain bacm:Organization ;
    rdfs:comment "Connects a GGSC organisation to the country/region it is based in." .
```

The same shape covers `holon:Agent`'s `holon:currentLocation` — an
agent occupies a place, is never contained by one. Worth naming the
Group/Team split from the Adventure Mode context as the same move one
level up: `holon:Group` is deliberately spatial-only (co-location) and
deliberately *not* modeled via containment either, for the identical
reason — an occupant relationship, not a scale-decomposition.

**Applying this to a whole class of instances at once, not per-record.**
When this question came up for 26 already-live GGSC organization
holons, the right fix wasn't checking or migrating 26 individual
records — it was verifying the class-level property declaration
(`ggsc:basedInRegion rdfs:subPropertyOf holon:isConnectedTo`, already
correct) and then asserting the disjointness once, on the classes. Every
instance inherits the guarantee for free. Reach for per-instance
migration (Decision 2's scoped `DELETE`/`INSERT`) only when the
predicate itself was wrong on some instances, not when you're
formalizing a rule the data already happens to satisfy.

**A facility is not a new class.** The temptation when this question
comes up is to invent `ggsc:Facility` as a hybrid entity-and-place
class. Don't — a facility is just `geo:Infrastructure` (already a
`GeographicRegion`, already containment-eligible) with an organization
connected to it: `SomeOrg ggsc:hasFacility SomeBuildingHolon`. The
organization stays a pure occupant; the building stays a pure Place;
the connection between them carries the fact that would otherwise have
tempted a conflated class.

### Known related smell, not yet resolved: `geo:Infrastructure` is currently overloaded

While applying Decision 5, a pre-existing Decision-2-shaped problem
surfaced in `geo:Infrastructure` itself: its class comment describes it
as "non-holonic... related via `geo:connects`, never containment" (true
for bridges/tunnels/corridors — Ponte Sant'Angelo, Tower Bridge, the
Channel Tunnel), but live instance data also uses `Infrastructure` for
landmark buildings that genuinely are `administrativePartOf` a
neighborhood (the Pantheon, the Colosseum, St. Peter's Basilica,
Shakespeare's Globe) — the opposite containment behavior on the same
class. This is the same "one predicate/class asked to mean two things"
smell Decision 2 names for properties, just found at the class level
instead. Likely fix, not yet applied: split into two classes (e.g.
`geo:ConnectingInfrastructure` for point-to-point links,
`geo:SiteInfrastructure` or reuse `geo:Facility`-as-Infrastructure-kind
for landmarks/buildings) under a shared `geo:Infrastructure` parent, the
same meta-class-per-axis move as Decision 3. Flagged here rather than
fixed inline — it's a separate design decision from the one this
session actually resolved.

---

## Default focus: `holon:Home` and persisted "last focus"

Two distinct, complementary concepts, easy to conflate:

- **`holon:Home`** — the canonical, cross-dataset-stable landing point.
  Same class (`holon:Home`, in the shared `holon:` namespace) in every
  dataset; exactly one instance expected per dataset (not currently
  enforced at the bridge level — worth a SHACL shape if this becomes
  load-bearing). This is "where an agent starts from" when there's
  nothing else to go on.
- **Persisted focus** — "where the agent actually is," remembered
  per-dataset across restarts via the bridge's session-state
  write-through mechanism (see the **holonbridge** skill for the
  mechanics). Every successful `GET /holon` call updates it.

Resolution order when no explicit IRI is given: **persisted focus, then
`holon:Home`, then nothing (404)**. Get this order backwards and every
navigation resets to the same starting point instead of resuming —
defeating the entire purpose of persisting it.

**Scoping trap to watch for:** persisted focus must be stored per
dataset (`focusByDataset: { data: "...", geo: "..." }`), not as one flat
value, and updates must read-merge into that map rather than overwriting
it wholesale — a naive write silently clobbers every other dataset's
remembered focus on every navigation in any dataset. This is exactly
the kind of bug that only shows up once a second dataset exists, so test
cross-dataset isolation explicitly, not just single-dataset navigation.

---

## Open / unresolved

**`lib/lifecycle.js` implements a different, newer holon model** under
the `w3id.org/holon` namespace (`holon:parentHolon` rather than
`isPartOf`, a three-graph-per-holon layout, RoleBinding ACL). It is not
reconciled with the `ontologist.io/ns/holon#` model this skill describes,
and no holon currently in Fuseki uses the `w3id.org/holon` namespace.
Everything in this skill targets the model actually populated — that is
a pragmatic choice about what's live today, **not** a claim that the
reconciliation question is settled. Don't let this skill's existence be
read as an answer to that question.

---

## Relationship to other skills

| Skill | Relationship |
|---|---|
| **holonbridge** | REST/MCP API mechanics, setup, auth, session-state persistence. This skill assumes that layer works and focuses on schema design decisions on top of it. |
| **sce** | Broader HGA/SCE pipeline architecture. Holons are one piece of that larger picture. |
| **databook** | DataBook is the document format holons and ontology triples travel in/out via `push_turtle`/`get_holon`. |

## Version history

| Version | Changes |
|---|---|
| v1.0.0 | Initial capture from the solar-system + European-geography holarchy build session: role discovery, containment/connection decision test, predicate scale-splitting, meta-class facet pattern, multi-tree containment, ordered-path-via-connection pattern, holon:Home + persisted focus. |
| v1.1.0 | Added Decision 5 (Place vs. occupant — organizations/agents are never GeographicRegion, always connect to one). Flagged the geo:Infrastructure connecting-vs-site conflation as a related, unresolved smell. |
