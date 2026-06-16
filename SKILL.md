---
name: holonbridge
version: 1.1.0
updated: 2026-06-13
description: >
  Reference skill for HolonBridge -- the Node.js/Express server that bridges the
  Holon Graph Architecture (HGA) pipeline to external clients. Load this skill
  whenever working on HolonBridge setup, configuration, endpoint usage, DataBook
  ingestion via the bridge, SPARQL query patterns against a live Fuseki backend,
  SHACL validation through the bridge, or the holonbridge-mcp MCP server.
triggers:
  - HolonBridge
  - holonbridge-mcp
  - Fuseki bridge
  - GSP push
  - nl_query
  - push_turtle
  - get_holon
  - list_graphs
  - validate_turtle
  - holon endpoint
  - ngrok holon
  - RDF 1.2 reification
  - Turtle 1.2
  - named reifier

# -- RDF 1.2 specification references ------------------------------------------
# These specifications are actively under development (Working Drafts as of
# 2026-06-13). The canonical URLs below always resolve to the latest published
# version. On skill load, fetch each URL to obtain the current draft date,
# status, and any syntax changes before generating or validating Turtle/SPARQL.
#
# on_load instruction:
#   For any session involving Turtle serialisation, SPARQL 1.2 UPDATE,
#   SHACL 1.2, or RDF reification, fetch the canonical spec URLs below and
#   note the current publication date and status. If the date has advanced
#   since 2026-06-13, treat any syntax details in this skill as potentially
#   superseded and prefer the fetched spec.

specs:
  rdf12_concepts:
    label: "RDF 1.2 Concepts and Abstract Data Model"
    canonical: "https://www.w3.org/TR/rdf12-concepts/"
    latest_known_wd: "https://www.w3.org/TR/2026/WD-rdf12-concepts-20260612/"
    status: Working Draft
    key_additions:
      - Triple terms as a fourth RDF term kind (used as object of another triple)
      - Reifiers -- IRIs or blank nodes that reify a triple term
      - Directional language-tagged strings
      - Version labels (1.1, 1.2)

  rdf12_turtle:
    label: "RDF 1.2 Turtle -- Terse RDF Triple Language"
    canonical: "https://www.w3.org/TR/rdf12-turtle/"
    latest_known_wd: "https://www.w3.org/TR/2026/WD-rdf12-turtle-20260612/"
    status: Working Draft
    key_syntax:
      version_announcement: 'VERSION "1.2"  or  @version "1.2" .'
      triple_term: "<<( s p o )>>  -- embeds a triple as an object term"
      anonymous_reifier: >
        s p o {| prop1 val1 ; prop2 val2 |} .
        Annotates the triple (s,p,o) with an anonymous reifier.
      named_reifier: >
        s p o ~ :reifierName {| prop1 val1 ; prop2 val2 |} .
        Assigns a named IRI as the reifier and annotates it.
        The ~ token precedes the reifier IRI; the {| |} block is optional.
      reified_triple_shorthand: >
        s p o ~ :r .
        :r prop1 val1 .
        Equivalent to named reifier without inline annotation block.
      prefix_rule: >
        Local names in CURIEs must not contain '/'.
        Use a dedicated prefix: PREFIX person: <https://example.org/person/>
        so that person:JaneYolen is valid, not example:person/JaneYolen.

  rdf12_sparql_update:
    label: "SPARQL 1.2 Update"
    canonical: "https://www.w3.org/TR/sparql12-update/"
    status: Working Draft
    key_additions:
      - INSERT DATA supports {| |} annotation syntax and ~ named reifier
      - Triple term patterns <<( s p o )>> in WHERE clauses
      - Reifier patterns in GRAPH clauses

  rdf12_shacl:
    label: "SHACL 1.2 (Shapes Constraint Language)"
    canonical: "https://www.w3.org/TR/shacl12/"
    status: Working Draft
    notes: >
      SHACL 1.2 adds support for validating RDF 1.2 triple terms and reifiers.
      HolonBridge uses rdf-validate-shacl (N3-based, in-process) which may lag
      behind the spec; Jena 6.0 native SHACL endpoint is the authoritative gate.
---

# HolonBridge Skill

HolonBridge is a **Node.js/Express HTTP bridge** between LLM clients and a
Jena 6.0 Fuseki triplestore. It exposes natural-language query, SHACL-validated
update, and capability discovery endpoints.

Typically runs alongside HolonViewer (port 3031 vs 3000).

> **On skill load:** The RDF 1.2 family of specifications (Turtle, Concepts,
> SPARQL Update, SHACL) are actively under development as Working Drafts.
> Before generating or validating Turtle 1.2 syntax, fetch the canonical URLs
> in the `specs` frontmatter above to confirm the current draft date and check
> for syntax changes since 2026-06-13. Jena 6.0 tracks the WD closely but may
> not yet implement the very latest editorial changes.

---

## Architecture

```
LLM Agent / User
      |
      v
+----------------------------------------------+
| HolonBridge (port 3031)                      |
|                                              |
|  GET  /description  -> capability manifest   |
|  POST /query        -> NL -> SPARQL -> answer  |
|  POST /update       -> SHACL-gated GSP push  |
|  POST /sparql-update -> raw SPARQL UPDATE    |
|  POST /reload       -> reload context        |
|  POST /dataset      -> switch dataset        |
|  GET  /datasets     -> list Fuseki datasets  |
|  GET  /health       -> liveness check        |
+----------------------------------------------+
      | SPARQL / GSP          | Anthropic API
      v                       v
Jena 6.0 Fuseki          claude-sonnet-4-6
(port 3030, internal)
```

**Port assignments:**

| Service | Port | Notes |
|---|---|---|
| Jena 6.0 Fuseki | 3030 | Internal only -- never expose publicly |
| HolonBridge REST API | 3031 | Public-facing; ngrok-exposed if needed |
| holonbridge-mcp | stdio | Claude Code integration; no network port |

---

## RDF 1.2 Turtle Syntax Reference

HolonBridge operates on a Jena 6.0 triplestore with **native RDF 1.2 and
SPARQL 1.2 support**. When generating Turtle for `/update` or `/sparql-update`,
use the following RDF 1.2 conventions.

### Version announcement

```turtle
VERSION "1.2"
```

Include at the top of any Turtle document that uses triple terms, reifiers,
or directional language tags.

### CURIE / prefixed name rule

Local names after the prefix colon **must not contain `/`**. Always define a
dedicated prefix for each IRI path segment:

```turtle
# OK Valid
PREFIX person: <https://w3id.org/ggsc/person/>
person:JaneYolen a foaf:Person .

# X Invalid CURIE -- slash in local name
ggsc:person/JaneYolen a foaf:Person .   # WRONG
```

### Anonymous reifier (annotation block)

Annotates the triple `(s, p, o)` with an anonymous reifier:

```turtle
person:JaneYolen schema:deathDate "2026-06-11"^^xsd:date {|
    a prov:Entity ;
    prov:wasAttributedTo person:KurtCagle ;
    prov:generatedAtTime "2026-06-13T00:00:00Z"^^xsd:dateTime
|} .
```

### Named reifier

The `~` token assigns a named IRI as the reifier, making it queryable and
referenceable independently of the triple:

```turtle
person:JaneYolen schema:deathDate "2026-06-11"^^xsd:date
    ~ ann:JaneYolenDeathDate {|
        a prov:Entity ;
        prov:wasAttributedTo  person:KurtCagle ;
        prov:generatedAtTime  "2026-06-13T00:00:00Z"^^xsd:dateTime ;
        rdfs:label            "Jane Yolen death annotation" ;
        prov:value            "Died 11 June 2026, age 87, Hatfield MA."
    |} .
```

`ann:JaneYolenDeathDate` expands to a full IRI (e.g.
`<https://w3id.org/ggsc/annotation/JaneYolenDeathDate>`) and can be the subject
of further triples outside the annotation block.

### Triple term (explicit)

When you need to assert a triple term as an object (rather than using the
annotation shorthand):

```turtle
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

ann:JaneYolenDeathDate
    rdf:reifies <<( person:JaneYolen schema:deathDate "2026-06-11"^^xsd:date )>> .
```

### SPARQL 1.2 UPDATE with named reifier

Jena 6.0 accepts the `~` syntax directly in `INSERT DATA`:

```sparql
PREFIX person: <https://w3id.org/ggsc/person/>
PREFIX ann:    <https://w3id.org/ggsc/annotation/>
PREFIX schema: <https://schema.org/>
PREFIX prov:   <http://www.w3.org/ns/prov#>
PREFIX xsd:    <http://www.w3.org/2001/XMLSchema#>

INSERT DATA {
  GRAPH <https://w3id.org/un/ggsc/persons> {
    person:JaneYolen schema:deathDate "2026-06-11"^^xsd:date
        ~ ann:JaneYolenDeathDate {|
            a prov:Entity ;
            prov:wasAttributedTo person:KurtCagle ;
            prov:generatedAtTime "2026-06-13T00:00:00Z"^^xsd:dateTime
        |} .
  }
}
```

---

## Setup

### Prerequisites

- Node.js ? 18.0.0
- Jena 6.0 Fuseki running locally (or remote endpoint)
- Anthropic API key (for NL -> SPARQL translation)

### Install and start

```bash
npm install
npm start
# or with auto-restart:
npm run dev
```

### Dataset selection

| Method | Example |
|---|---|
| `-d` / `--dataset` CLI flag | `node server.js -d my-project` |
| `JENA_DATASET` env var | `JENA_DATASET=my-project npm start` |
| `POST /dataset` at runtime | `{ "dataset": "ggsc" }` |
| Default | `ds` |

### Context directory layout

Context is partitioned by server and dataset. Files are merged alphabetically
and watched for changes -- any save triggers an automatic reload:

```
context/
  localhost-3030/
    ds/
      01-prefixes.databook.md
      02-classes.databook.md
      03-named-queries.databook.md
    ggsc/
      01-prefixes.databook.md
      ...
  kurtcagle.ngrok.io/
    ds/
      01-prefixes.databook.md
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `JENA_BASE` | `http://localhost:3030` | Jena Fuseki host |
| `JENA_DATASET` | `ds` | Dataset name |
| `SHACL_GRAPH` | `urn:{dataset}:shacl` | Named graph holding SHACL shapes |
| `PORT` | `3031` | Bridge service port |
| `MAX_RETRIES` | `2` | SPARQL correction retries |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model for NL pipeline |
| `LOG_SPARQL` | `false` | Print SPARQL to console |
| `LOG_PROMPTS` | `false` | Print LLM prompts to console |

---

## API Reference

### GET /description

Returns a full capability manifest for LLM consumption. Call once at agent
session start.

### POST /query

Natural language -> SPARQL -> interpreted English answer.

```json
{ "nl": "Which GNSS observatories are operated by IGS?" }
{ "queryId": "list-observatories" }
{ "nl": "...", "format": "databook" }
```

### POST /update

SHACL-gated Turtle push. Both gates must pass: (1) SHACL shapes graph must be
non-empty in Jena; (2) incoming Turtle must conform. Supports RDF 1.2 Turtle
including `{| |}` annotation blocks and `~ name` named reifiers.

```json
{ "turtle": "...", "graph": "http://...", "mode": "append|replace" }
```

HTTP status: 200 success ? 409 SHACL gate failure ? 422 validation failure.

### POST /sparql-update

Raw SPARQL 1.2 UPDATE -- no SHACL gate. For administrative use.

```json
{ "update": "INSERT DATA { GRAPH <...> { ... } }" }
```

### POST /reload

Reload context DataBooks and rediscover named graphs without restart.

### POST /dataset

Switch active Fuseki dataset at runtime. Restarts the filesystem watcher on
the new context directory. Rolls back on context load failure.

```json
{ "dataset": "ggsc" }
```

### GET /datasets

List all datasets on the Fuseki server via the admin API. Marks the active one.

### GET /health

Liveness check. Returns version, dataset, endpoints, model.

---

## Named Query Catalog

Include a `named-queries` block in a context DataBook file:

```json
[
  {
    "id":          "list-observatories",
    "description": "List all GNSS observatories with their labels",
    "sparql":      "SELECT ?obs ?label WHERE { ?obs a ggsc:Observatory ; rdfs:label ?label }"
  }
]
```

Invoke via `POST /query` with `{ "queryId": "list-observatories" }`.

---

## SHACL Validation Gate

Before any `/update` is accepted:

1. HolonBridge queries Jena to confirm the SHACL shapes graph is non-empty.
2. Runs `rdf-validate-shacl` (N3 in-process) against the incoming Turtle.
3. Only if both pass does it push via GSP.

```bash
databook push --dataset ds --graph urn:ds:shacl shapes.ttl
```

Note: `rdf-validate-shacl` is an RDF 1.1 library and may not validate RDF 1.2
triple terms or reifiers. For RDF 1.2 payloads, prefer the Jena native SHACL
endpoint or bypass with `/sparql-update`.

---

## ngrok Exposure

```bash
ngrok http --url=<your-subdomain>.ngrok.io 3031
```

Never expose Fuseki (:3030) directly.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Connection refused :3031 | HolonBridge not running | `npm start` |
| Connection refused :3030 | Fuseki not running | `fuseki-server --update --mem /ds` |
| `/update` returns 409 | SHACL shapes graph empty | Push shapes first |
| `/update` returns 422 | SHACL validation failed | Inspect `violations[].message` |
| `sparql-update` returns 400 | Malformed SPARQL | Check PREFIXes; SELECT ? UPDATE |
| Context not reloading | chokidar not watching | Check `context/{server}/{dataset}/` exists |
| CURIE parse error in Turtle | Slash in local name | Define dedicated prefix per path segment |
| `~` syntax rejected | Jena version < 6.0 | Upgrade Jena; RDF 1.2 requires Jena 6.0+ |

---

## Relationship to Other Skills and Specs

| Skill / Spec | Relationship |
|---|---|
| **sce** | Parent architecture. HolonBridge implements the HGA Server component. |
| **databook** | DataBook format is HolonBridge's primary data unit. |
| **holonbridge-mcp** | MCP layer wrapping HolonBridge for Claude Code (stdio). |
| RDF 1.2 Turtle | Syntax reference for all Turtle payloads -- see `specs.rdf12_turtle` above. |
| RDF 1.2 Concepts | Defines triple terms, reifiers, version labels -- see `specs.rdf12_concepts`. |
| SPARQL 1.2 Update | Governs `INSERT DATA` syntax including `~` and `{| |}` -- see `specs.rdf12_sparql_update`. |

---

## Version History

| Version | Changes |
|---|---|
| 2.2.0 | Partitioned context dirs (`context/{server}/{dataset}/`); chokidar auto-reload |
| 2.1.0 | `POST /dataset`, `GET /datasets`; named reifier `~` support |
| 2.0.0 | Initial HolonBridge REST API; Jena 6.0; ngrok exposure |

*Skill v1.1.0 -- Added RDF 1.2 spec references (Turtle, Concepts, SPARQL Update,
SHACL), named reifier syntax guide, CURIE rules, and on_load fetch instruction.*
