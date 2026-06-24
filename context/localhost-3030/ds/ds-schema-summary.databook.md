---
id: https://w3id.org/un/ggsc/databooks/schema-summary-v1
title: "GGSC Schema Summary — NL-to-SPARQL Bridge Context"
type: databook
version: 1.3.0
created: 2026-05-26
updated: 2026-05-30
  alignment: https://w3id.org/un/ggsc/alignment
  changelog: v1.3.0 — LANG filter broadened to include untagged literals
description: >
  Condensed schema summary of the UN-GGSC ontology and SHACL shapes graph,
  optimised for use as grounding context in the NL-to-SPARQL query bridge service.
  Derived from ggsc-ontology.ttl (v1.1) and ggsc-shacl-all.ttl (v1.1).
  Contains: prefix registry, class index, property index, annotation pattern,
  SPARQL query templates, and NL-to-graph mapping hints.
  NOT a validation graph — constraint machinery stripped. Query navigation only.
tags:
  - ggsc
  - schema-summary
  - nl-to-sparql
  - query-bridge
  - llm-context
author:
  - name: Kurt Cagle
    iri: https://holongraph.com/people/kurt-cagle
    role: orchestrator
  - name: Chloe Shannon
    iri: https://holongraph.com/people/chloe-shannon
    role: transformer
process:
  transformer: "claude-sonnet-4-6"
  transformer_type: llm
  transformer_iri: https://api.anthropic.com/v1/models/claude-sonnet-4-6
  timestamp: 2026-05-30T00:00:00Z
  inputs:
    - iri: https://drive.google.com/file/d/1JjFxYrknbWGXDXvrCm0VXL2mlh5CuKXn
      role: source
      description: ggsc-ontology.ttl v1.1
    - iri: https://drive.google.com/file/d/1U4Ow_DT2cIciAXn4LsjWNlQ8K-VnmpW9
      role: source
      description: ggsc-shacl-all.ttl v1.1
  agent:
    name: Chloe Shannon
    iri: https://holongraph.com/people/chloe-shannon
    role: transformer
---

# GGSC Schema Summary — NL-to-SPARQL Bridge Context

This DataBook provides a condensed, query-oriented view of the UN Global Geodesy
Supply Chain (GGSC) ontology. It is designed to be loaded as grounding context
for an LLM generating SPARQL queries against a Jena 6.0 Fuseki endpoint.

The full `ggsc-shacl-all.ttl` (78KB, ~20K tokens) is reduced here to approximately
2,800 tokens. Constraint machinery is stripped; what remains is what an LLM needs
to navigate the graph: types, properties, controlled vocabularies, and query patterns.

---

## Block Index

| Block ID | Content | Use when… |
|---|---|---|
| `prefix-registry` | All `@prefix` declarations | Every query |
| `class-index` | Class hierarchy with labels, descriptions, instance namespaces | Mapping NL nouns to graph types |
| `property-index` | Per-class queryable properties with ranges | Mapping NL predicates to graph properties |
| `controlled-vocabularies` | Enumerated values for key string properties | Generating `FILTER` or `VALUES` clauses |
| `annotation-pattern` | RDF 1.2 reification syntax for GGSC | Queries involving provenance annotations |
| `query-templates` | Parameterised SPARQL for high-frequency question types | Template-based query construction |
| `nl-hints` | NL term → class/property mappings | Resolving ambiguous natural language |

---

<!-- databook:id: prefix-registry -->
```turtle
# GGSC Canonical Prefix Registry
@prefix rdf:        <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:       <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl:        <http://www.w3.org/2002/07/owl#> .
@prefix xsd:        <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms:    <http://purl.org/dc/terms/> .
@prefix skos:       <http://www.w3.org/2004/02/skos/core#> .
@prefix prov:       <http://www.w3.org/ns/prov#> .
@prefix foaf:       <http://xmlns.com/foaf/0.1/> .
@prefix org:        <http://www.w3.org/ns/org#> .
@prefix geo:        <http://www.w3.org/2003/01/geo/wgs84_pos#> .
@prefix geosparql:  <http://www.opengis.net/ont/geosparql#> .
@prefix bacm:       <http://omg.org/spec/BACM/> .
@prefix commons:    <https://www.omg.org/spec/Commons/> .
@prefix cco:        <http://www.ontologyrepository.com/CommonCoreOntologies/> .
@prefix coo:        <http://www.ontologyrepository.com/CommonCoreOntologies/CapabilityOntology/> .
@prefix ggsc:       <http://un-ggce.org/ggsc/> .
@prefix ggsc-cap:   <http://un-ggce.org/ggsc/capability/> .
@prefix ggsc-org:   <http://un-ggce.org/ggsc/organization/> .
@prefix ggsc-obs:   <http://un-ggce.org/ggsc/observatory/> .
@prefix ggsc-agent: <http://un-ggce.org/ggsc/agent/> .
@prefix ggsc-vs:    <http://un-ggce.org/ggsc/valuestream/> .
@prefix ggsc-sh:    <http://un-ggce.org/ggsc/shapes/> .
@prefix holon:      <https://ontologist.io/ns/holon#> .
# ── UN-GGCE Supply Chain Workflow Prefixes ────────────────────────────────────
@prefix ggce:     <https://w3id.org/un/ggce/> .
@prefix ggcewf:   <https://w3id.org/un/ggce/workflow/> .
@prefix ggcetier: <https://w3id.org/un/ggce/tier/> .
@prefix ggcecap:  <https://w3id.org/un/ggce/capability/> .
@prefix ggceinst: <https://w3id.org/un/ggce/institution/> .
@prefix ggcewa:   <https://w3id.org/un/ggce/wa/> .
@prefix schema:   <https://schema.org/> .
```

---

<!-- databook:id: class-index -->
```yaml
# GGSC Class Index — query navigation view
# Fields: class (CURIE), label, description, superclass, instance-ns, notes

classes:

  - class: ggsc:Capability
    label: "GGSC Capability"
    description: >
      A discrete, bounded ability within the Global Geodesy Supply Chain.
      Organised in a three-level hierarchy (L1 domain → L2 sub-domain → L3 operational).
      Every capability carries exactly one MaturityAssessment (PPTD scores).
    superclass: bacm:Capability
    instance-ns: ggsc-cap
    key: true

  - class: ggsc:Level1Capability
    label: "Level 1 (Domain) Capability"
    description: >
      Top-level domain capability. No parent. Six canonical instances only.
    superclass: ggsc:Capability
    instance-ns: ggsc-cap
    canonical-instances:
      - ggsc-cap:EngagementCollaboration
      - ggsc-cap:GovernanceStrategy
      - ggsc-cap:DataManagement
      - ggsc-cap:AssetInfrastructure
      - ggsc-cap:ProductsServices
      - ggsc-cap:InnovationDevelopment

  - class: ggsc:Level2Capability
    label: "Level 2 (Sub-Domain) Capability"
    description: Sub-domain capability. Must have exactly one L1 parent.
    superclass: ggsc:Capability
    instance-ns: ggsc-cap

  - class: ggsc:Level3Capability
    label: "Level 3 (Operational) Capability"
    description: Specific operational capability. Must have exactly one L2 parent.
    superclass: ggsc:Capability
    instance-ns: ggsc-cap

  - class: ggsc:MaturityAssessment
    label: "Maturity Assessment"
    description: >
      PPTD (People/Process/Technology/Data) maturity assessment attached to a capability.
      Carries four decimal scores in [0.0, 5.0] and a derived average score.
    superclass: cco:MeasurementInformationContentEntity
    note: "Always queried via its parent capability, not directly."

  - class: ggsc:Observatory
    label: "Observatory"
    description: >
      A geodetic observation station forming part of the global geodetic infrastructure.
      Supports one or more observation technique types (VLBI, SLR, GNSS, DORIS, Gravity).
      Has a physical location (WGS84 coordinates).
    superclass: geosparql:Feature
    instance-ns: ggsc-obs
    key: true

  - class: ggsc:ObservatoryStub
    label: "Observatory Stub"
    description: >
      A partially characterised observatory from the ITRF DOMES registry.
      May lack coordinates and operator. Subclass of Observatory.
    superclass: ggsc:Observatory
    instance-ns: ggsc-obs

  - class: ggsc:ProcessingCentre
    label: "Processing Centre"
    description: >
      A data processing or analysis facility contributing to the GGSC through
      analysis, combination, or orbit determination — not a physical observation station.
      Uses ggsc:functionType rather than ggsc:observationType.
    superclass: ggsc:InternalNode
    instance-ns: ggsc-obs
    note: "Distinct from Observatory — no coordinates expected."

  - class: ggsc:Centre
    label: "Centre"
    description: >
      An IGS or GGSC service centre providing coordination, data archival,
      or information infrastructure. Includes IGS Central Bureau, Regional Data Centres,
      coordination nodes. Not a physical observation station.
    superclass: ggsc:InternalNode
    instance-ns: ggsc-obs

  - class: bacm:Organization
    label: "Organisation"
    description: >
      A national or international body participating in the GGSC.
      Classified by type (Government Agency, Scientific Association, etc.)
      and contribution model (Funded, In-kind, etc.).
    instance-ns: ggsc-org
    key: true
    equivalent: holon:Organisation
    note: "holon:Organisation owl:equivalentClass bacm:Organization (see alignment graph). Scenario graphs use holon:Organisation; capabilities graph uses bacm:Organization. Always query BOTH — see sparql-generation-rules. Use LANG(?label) = \"en\" || LANG(?label) = \"\" to catch untagged literals."

  - class: cco:Agent
    label: "Agent / Stakeholder"
    description: >
      An individual stakeholder affiliated with a GGSC organisation.
      Carries a role, organisation membership, and capability support links.
      Individuals are co-typed as foaf:Person. Query using EITHER type:
        ?p a foaf:Person  OR  ?p a cco:Agent
    instance-ns: ggsc-agent
    person-graph: https://w3id.org/un/ggsc/persons
    note: "Person records live in GRAPH <https://w3id.org/un/ggsc/persons>"

  - class: bacm:ValueStream
    label: "Value Stream"
    description: >
      An end-to-end flow of activities that creates value in the GGSC.
      Six canonical value streams. Carries criticality level, typical latency,
      and input/output data levels.
    instance-ns: ggsc-vs
    key: true
    canonical-instances:
      - ggsc-vs:ObservationToReference
      - ggsc-vs:ReferenceToApplication
      - ggsc-vs:RealTimeOperations
      - ggsc-vs:InfrastructureSustainment
      - ggsc-vs:CapacityDevelopment
      - ggsc-vs:StandardsDevelopment

  - class: ggsc:DataLevel
    label: "Data Level"
    description: >
      Classification of geodetic data processing level.
      Three instances: Level0Data (raw), Level1Data (processed), Level2Data (application-ready).
    canonical-instances:
      - ggsc:Level0Data
      - ggsc:Level1Data
      - ggsc:Level2Data

  # ── UN-GGCE Supply Chain Workflow Classes ─────────────────────────────────────

  - class: ggce:Workflow
    label: "Geodetic Supply Chain Workflow"
    description: >
      A geodetic supply chain workflow (EOP, ICRF, ITRF, Satellite Orbits, Gravity).
      Each workflow has 5 tiers (T0-T4) scored for risk.
    instance-ns: ggcewf
    canonical-instances:
      - ggcewf:eop
      - ggcewf:icrf
      - ggcewf:itrf
      - ggcewf:satellite_orbits
      - ggcewf:gravity
    key: true

  - class: ggce:WorkflowTier
    label: "Workflow Tier"
    description: >
      A tier (0-4) within a workflow, scored for supply chain risk.
      IRI pattern: ggcetier:{workflow_id}_t{tier_number} e.g. ggcetier:eop_t1.
      Carries tierRiskScore (0-25), pptdGap, criticalityScore, riskClassification.
    instance-ns: ggcetier
    key: true

  - class: ggce:CapabilityScore
    label: "PPTD Capability Score"
    description: >
      A PPTD maturity score for a specific capability at a specific tier.
      IRI pattern: ggcecap:{tier_id}_{capability_slug}.
      Carries peopleScore, processScore, technologyScore, dataScore, weightedAvg.
    instance-ns: ggcecap

  - class: ggce:GuidingPrinciple
    label: "Guiding Architectural Principle"
    description: >
      One of six architectural principles (P1-P6) for geodetic infrastructure resilience.
    canonical-instances:
      - ggce:P1_GeographicDistribution
      - ggce:P2_PoliticalResilience
      - ggce:P3_CentralisedAccountability
      - ggce:P4_TechnicalInteroperability
      - ggce:P5_MinimumCapabilityMaturity
      - ggce:P6_TransparencyAccountability

  - class: ggce:RiskClassification
    label: "Risk Classification"
    description: "One of four risk bands: Critical (16-20), High (11-15.99), Significant (6-10.99), Minor (0-5.99)."
    canonical-instances:
      - ggce:risk_Critical
      - ggce:risk_High
      - ggce:risk_Significant
      - ggce:risk_Minor

  - class: ggce:TierRiskAssessment
    label: "Tier Risk Assessment"
    description: "A scored risk assessment for a specific workflow tier with full PPTD capability breakdown."

  - class: ggce:InvestmentRubric
    label: "Investment Rubric"
    description: "The PPTD scoring framework document (ggcewa:1b_investment_rubric)."
```

---

<!-- databook:id: property-index -->
```yaml
# GGSC Property Index — queryable properties per domain class
# Fields: property (CURIE), label, domain, range, key (true = commonly queried)

properties:

  # --- Capability properties ---
  - property: ggsc:hasParentCapability
    label: "has parent capability"
    domain: ggsc:Capability
    range: ggsc:Capability
    key: true
    note: "L2→L1, L3→L2. L1 has no parent."

  - property: ggsc:hasMaturityAssessment
    label: "has maturity assessment"
    domain: ggsc:Capability
    range: ggsc:MaturityAssessment
    key: true

  - property: ggsc:contributesToValueStream
    label: "contributes to value stream"
    domain: ggsc:Capability
    range: bacm:ValueStream
    key: true

  # --- MaturityAssessment properties ---
  - property: ggsc:hasPeopleScore
    label: "people maturity score"
    domain: ggsc:MaturityAssessment
    range: xsd:decimal
    note: "Range [0.0, 5.0]. PPTD People axis."

  - property: ggsc:hasProcessScore
    label: "process maturity score"
    domain: ggsc:MaturityAssessment
    range: xsd:decimal
    note: "Range [0.0, 5.0]. PPTD Process axis."

  - property: ggsc:hasTechnologyScore
    label: "technology maturity score"
    domain: ggsc:MaturityAssessment
    range: xsd:decimal
    note: "Range [0.0, 5.0]. PPTD Technology axis."

  - property: ggsc:hasDataScore
    label: "data maturity score"
    domain: ggsc:MaturityAssessment
    range: xsd:decimal
    note: "Range [0.0, 5.0]. PPTD Data axis."

  - property: ggsc:hasAverageScore
    label: "average maturity score"
    domain: ggsc:MaturityAssessment
    range: xsd:decimal
    key: true
    note: "Derived average of the four PPTD scores. Range [0.0, 5.0]."

  # --- Observatory / ProcessingCentre / Centre properties ---
  - property: ggsc:observationType
    label: "observation type"
    domain: ggsc:Observatory
    range: xsd:string
    key: true
    note: "Enum: VLBI | SLR | GNSS | DORIS | Gravity. Only on Observatory, not ProcessingCentre."

  - property: ggsc:functionType
    label: "function type"
    domain: "ggsc:ProcessingCentre OR ggsc:Centre"
    range: xsd:string
    key: true
    note: "Enum: GNSS Analysis | GNSS Combination | GNSS Combination Backup | Analysis | Data Archive | Orbit Determination | Coordination & Information System (CBIS) | Coordination | Management"

  - property: ggsc:operatedBy
    label: "operated by"
    domain: "ggsc:Observatory OR ggsc:ProcessingCentre OR ggsc:Centre"
    range: bacm:Organization
    key: true

  - property: ggsc:contributesToCapability
    label: "contributes to capability"
    domain: "ggsc:Observatory OR ggsc:ProcessingCentre OR ggsc:Centre"
    range: ggsc:Capability
    key: true
    note: "Derived by rule from observationType for Observatories when not asserted."

  - property: ggsc:operationalStatus
    label: "operational status"
    domain: "ggsc:Observatory OR ggsc:ProcessingCentre OR ggsc:Centre"
    range: xsd:string
    note: "Enum: Active | Inactive | Planned | Maintenance | Decommissioned | Campaign | Intermittent"

  - property: geo:lat
    label: "WGS84 latitude"
    domain: ggsc:Observatory
    range: xsd:decimal

  - property: geo:long
    label: "WGS84 longitude"
    domain: ggsc:Observatory
    range: xsd:decimal

  - property: geosparql:hasGeometry
    label: "has geometry"
    domain: ggsc:Observatory
    range: geosparql:Geometry
    note: "WKT point via geosparql:asWKT on the geometry node."

  # --- Organisation properties ---
  - property: ggsc:supportsCapability
    label: "supports capability"
    domain: "bacm:Organization OR cco:Agent"
    range: ggsc:Capability
    key: true

  - property: ggsc:role
    label: "role"
    domain: "bacm:Organization OR cco:Agent"
    range: xsd:string

  - property: ggsc:contributionModel
    label: "contribution model"
    domain: bacm:Organization
    range: xsd:string
    note: "Enum: Funded | In-kind | Coordination | Commercial | Research"

  - property: ggsc:operatesObservatoryType
    label: "operates observatory type"
    domain: bacm:Organization
    range: xsd:string
    note: "Enum: VLBI | SLR | GNSS | DORIS | Gravity"

  - property: org:classification
    label: "organisation classification"
    domain: bacm:Organization
    range: xsd:string
    note: "Enum: Government Agency | International Organization | UN Organization | Scientific Association | Scientific Service | Scientific Organization | University | Research Institute | Private Company"

  - property: foaf:homepage
    label: "homepage"
    domain: bacm:Organization
    range: IRI

  - property: foaf:name
    label: "full name"
    domain: foaf:Person
    range: xsd:string

  # --- Agent properties ---
  - property: org:memberOf
    label: "member of"
    domain: cco:Agent
    range: bacm:Organization
    key: true
    note: "Uses org:memberOf (W3C Org ontology), NOT ggsc:memberOf."

  - property: prov:wasDerivedFrom
    label: "was derived from"
    domain: foaf:Person
    range: IRI
    note: "Source URL for agent data. Named reifier carries dcterms:date."

  # --- Value Stream properties ---
  - property: ggsc:criticalityLevel
    label: "criticality level"
    domain: bacm:ValueStream
    range: xsd:string
    key: true
    note: "Enum: Critical | High | Medium | Low"

  - property: ggsc:typicalLatency
    label: "typical latency"
    domain: bacm:ValueStream
    range: xsd:string

  - property: ggsc:inputDataLevel
    label: "input data level"
    domain: bacm:ValueStream
    range: ggsc:DataLevel

  - property: ggsc:outputDataLevel
    label: "output data level"
    domain: bacm:ValueStream
    range: ggsc:DataLevel

  # --- Cross-graph linkage ---
  - property: ggsc:projectsTo
    label: "projects to"
    domain: ggsc:InternalNode
    range: ggsc:ProjectionNode
    note: "Maps an operational (internal graph) entity to its standardised projection."
  # ── UN-GGCE Supply Chain Risk Properties ─────────────────────────────────────

  - property: ggce:tierRiskScore
    label: "tier risk score"
    domain: ggce:WorkflowTier
    range: xsd:decimal
    key: true
    note: "Range 0-25. Formula: PPTD Gap x Step Criticality. High = 11+."

  - property: ggce:pptdGap
    label: "PPTD gap"
    domain: ggce:WorkflowTier
    range: xsd:decimal
    note: "= 5 minus weighted average PPTD maturity score."

  - property: ggce:criticalityScore
    label: "criticality score"
    domain: ggce:WorkflowTier
    range: xsd:integer
    note: "1-5 step criticality. 5 = single point of failure."

  - property: ggce:riskClassification
    label: "risk classification"
    domain: ggce:WorkflowTier
    range: ggce:RiskClassification
    key: true

  - property: ggce:jdpPhase
    label: "JDP phase"
    domain: ggce:WorkflowTier
    range: xsd:integer
    note: "1 = Immediate Action, 2 = Near-Term, 3 = Optimisation."

  - property: ggce:hasTier
    label: "has tier"
    domain: ggce:Workflow
    range: ggce:WorkflowTier
    key: true

  - property: ggce:workflow
    label: "workflow"
    domain: ggce:WorkflowTier
    range: ggce:Workflow
    key: true

  - property: ggce:tier
    label: "tier number"
    domain: ggce:WorkflowTier
    range: xsd:integer
    note: "0-4."

  - property: ggce:relatedPrinciples
    label: "related principles"
    domain: ggce:WorkflowTier
    range: ggce:GuidingPrinciple
    key: true
    note: "Links a tier to the guiding principles it violates."

  - property: ggce:hasCapabilityScore
    label: "has capability score"
    domain: ggce:WorkflowTier
    range: ggce:CapabilityScore

  - property: ggce:peopleScore
    label: "people score"
    domain: ggce:CapabilityScore
    range: xsd:decimal
    note: "PPTD People axis, range 1-5."

  - property: ggce:processScore
    label: "process score"
    domain: ggce:CapabilityScore
    range: xsd:decimal
    note: "PPTD Process axis, range 1-5."

  - property: ggce:technologyScore
    label: "technology score"
    domain: ggce:CapabilityScore
    range: xsd:decimal
    note: "PPTD Technology axis, range 1-5."

  - property: ggce:dataScore
    label: "data score"
    domain: ggce:CapabilityScore
    range: xsd:decimal
    note: "PPTD Data axis, range 1-5."

  - property: ggce:weightedAvg
    label: "weighted average"
    domain: ggce:CapabilityScore
    range: xsd:decimal
    key: true

  - property: ggce:boosted
    label: "boosted"
    domain: ggce:CapabilityScore
    range: xsd:boolean
    note: "True if 1.2x boost applied because People or Process score <= 2."

  - property: schema:jobTitle
    label: "job title"
    domain: foaf:Person
    range: xsd:string
```

---

<!-- databook:id: annotation-pattern -->
```turtle
# GGSC RDF 1.2 Annotation Pattern (Turtle 1.2 / SPARQL 1.2)
# Jena 6.0 Fuseki — T03 annotation pattern confirmed operational (canary 2026-05-14)
#
# Pattern: named reifier on a triple carrying provenance metadata
# Used in GGSC for:
#   (a) prov:wasDerivedFrom on agent records — source URL traceability
#   (b) maturity score assertions — assessment date + attributing organisation
#
# Turtle 1.2 write syntax (named reifier):
#
#   ?subject ?predicate ?object ~ reifier:Name {|
#       dcterms:date "2026-01-15"^^xsd:date ;
#       prov:wasAttributedTo ggsc-org:SomeOrg
#   |} .
#
# Example — agent provenance:
ggsc-agent:johnSmith prov:wasDerivedFrom <https://igs.org/people/john-smith>
    ~ ggsc-agent:johnSmith-Prov {|
        dcterms:date "2026-04-01"^^xsd:date
    |} .

# Example — maturity score annotation:
ggsc-cap:DataManagement-MA1 ggsc:hasPeopleScore "3.5"^^xsd:decimal
    ~ ggsc-cap:DataManagement-MA1-peopleScore-2026 {|
        dcterms:date "2026-01-15"^^xsd:date ;
        prov:wasAttributedTo ggsc-org:IGS
    |} .
```

```sparql
# SPARQL 1.2 T03 annotation pattern query form (canonical)
# Retrieves annotated triples with their reifier metadata

PREFIX ggsc:    <http://un-ggce.org/ggsc/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX prov:    <http://www.w3.org/ns/prov#>

SELECT ?subject ?predicate ?object ?assessmentDate ?assessedBy
FROM <{{namedGraph}}>
WHERE {
    ?subject ?predicate ?object {|
        dcterms:date ?assessmentDate
    |} .
    OPTIONAL { ?subject ?predicate ?object {| prov:wasAttributedTo ?assessedBy |} }
}
ORDER BY ?subject ?predicate
```

---

<!-- databook:id: query-templates -->
```sparql
# GGSC SPARQL Query Template Library
# Slot syntax: {{paramName}} — replace before execution
# All queries target Jena 6.0 Fuseki with SPARQL 1.2
#
# Named graph usage — CRITICAL RULES:
#   ALWAYS use GRAPH <graphIRI> { ... } inside the WHERE clause.
#   NEVER combine FROM <graphIRI> with GRAPH <graphIRI> { } in the same query —
#   this causes aggregate functions (COUNT, AVG, GROUP_CONCAT) to return zero rows.
#   NEVER use FROM alone without a GRAPH clause when targeting named graphs.
#
#   Correct pattern:
#     SELECT ?x WHERE { GRAPH <iri> { ?x a Type } }
#   Correct COUNT pattern:
#     SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { GRAPH <iri> { ?x a Type } }
#   WRONG — causes COUNT=0:
#     SELECT (COUNT(?x) AS ?n) FROM <iri> WHERE { GRAPH <iri> { ?x a Type } }
#
# The bridge service injects available named graph IRIs into the builder
# context at startup via SELECT DISTINCT ?g WHERE { GRAPH ?g { } }.

# ── T1: Capability hierarchy for a given Level 1 domain ──────────────────────
# NL: "What capabilities does [domain] contain?"
# Params: {{l1CapIRI}}, {{graphIRI}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?l2 ?l2Label ?l3 ?l3Label
WHERE {
  GRAPH <{{graphIRI}}> {
    ?l2 a ggsc:Level2Capability ;
        ggsc:hasParentCapability {{l1CapIRI}} ;
        rdfs:label ?l2Label .
    OPTIONAL {
        ?l3 a ggsc:Level3Capability ;
            ggsc:hasParentCapability ?l2 ;
            rdfs:label ?l3Label .
    }
    FILTER(LANG(?l2Label) = "en" || LANG(?l2Label) = "")
  }
}
ORDER BY ?l2Label ?l3Label

# ── T2: Maturity assessment for a capability ─────────────────────────────────
# NL: "What is the maturity of [capability]?" / "Show PPTD scores for..."
# Params: {{capIRI}}, {{graphIRI}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?capLabel ?peopleScore ?processScore ?techScore ?dataScore ?avgScore
WHERE {
  GRAPH <{{graphIRI}}> {
    {{capIRI}} rdfs:label ?capLabel ;
               ggsc:hasMaturityAssessment ?ma .
    ?ma ggsc:hasPeopleScore     ?peopleScore ;
        ggsc:hasProcessScore    ?processScore ;
        ggsc:hasTechnologyScore ?techScore ;
        ggsc:hasDataScore       ?dataScore .
    OPTIONAL { ?ma ggsc:hasAverageScore ?avgScore }
    FILTER(LANG(?capLabel) = "en" || LANG(?capLabel) = "")
  }
}

# ── T3: Observatories by technique type ──────────────────────────────────────
# NL: "Which GNSS / VLBI / SLR observatories exist?"
# Params: {{techniqueType}} — one of: VLBI | SLR | GNSS | DORIS | Gravity
#         {{graphIRI}}

PREFIX ggsc:     <http://un-ggce.org/ggsc/>
PREFIX rdfs:     <http://www.w3.org/2000/01/rdf-schema#>
PREFIX geo:      <http://www.w3.org/2003/01/geo/wgs84_pos#>

SELECT ?obs ?obsLabel ?operator ?operatorLabel ?lat ?long ?status
WHERE {
  GRAPH <{{graphIRI}}> {
    ?obs a ggsc:Observatory ;
         rdfs:label ?obsLabel ;
         ggsc:observationType "{{techniqueType}}" .
    OPTIONAL { ?obs ggsc:operatedBy ?operator .
               ?operator rdfs:label ?operatorLabel }
    OPTIONAL { ?obs geo:lat ?lat ; geo:long ?long }
    OPTIONAL { ?obs ggsc:operationalStatus ?status }
    FILTER(LANG(?obsLabel) = "en" || LANG(?obsLabel) = "")
  }
}
ORDER BY ?obsLabel

# ── T4: Organisation capabilities and contribution model ─────────────────────
# NL: "What does [organisation] do?" / "Which organisations support [capability]?"
# Params: {{orgIRI}}, {{graphIRI}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
PREFIX org:   <http://www.w3.org/ns/org#>

SELECT ?org ?orgLabel ?classification ?contribution ?cap ?capLabel
WHERE {
  GRAPH <{{graphIRI}}> {
    {{orgIRI}} rdfs:label ?orgLabel ;
               org:classification ?classification ;
               ggsc:contributionModel ?contribution .
    OPTIONAL {
        {{orgIRI}} ggsc:supportsCapability ?cap .
        ?cap rdfs:label ?capLabel .
        FILTER(LANG(?capLabel) = "en" || LANG(?capLabel) = "")
    }
    FILTER(LANG(?orgLabel) = "en" || LANG(?orgLabel) = "")
    BIND({{orgIRI}} AS ?org)
  }
}

# ── T5: Value stream → capability → observatory chain ────────────────────────
# NL: "Which observatories contribute to [value stream]?"
# Params: {{vsIRI}}, {{graphIRI}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?obs ?obsLabel ?cap ?capLabel ?technique
WHERE {
  GRAPH <{{graphIRI}}> {
    ?cap ggsc:contributesToValueStream {{vsIRI}} ;
         rdfs:label ?capLabel .
    ?obs a ggsc:Observatory ;
         ggsc:contributesToCapability ?cap ;
         rdfs:label ?obsLabel .
    OPTIONAL { ?obs ggsc:observationType ?technique }
    FILTER(LANG(?capLabel) = "en" || LANG(?capLabel) = "")
    FILTER(LANG(?obsLabel) = "en" || LANG(?obsLabel) = "")
  }
}
ORDER BY ?capLabel ?obsLabel

# ── T6: Average maturity scores across all L1 domains ────────────────────────
# NL: "What is the overall maturity across all domains?" / "Summary of GGSC maturity"
# Params: {{graphIRI}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?l1 ?l1Label (AVG(?avg) AS ?domainAvg) (COUNT(?cap) AS ?capCount)
WHERE {
  GRAPH <{{graphIRI}}> {
    ?l1 a ggsc:Level1Capability ;
        rdfs:label ?l1Label .
    ?cap ggsc:hasParentCapability+ ?l1 ;
         ggsc:hasMaturityAssessment ?ma .
    ?ma ggsc:hasAverageScore ?avg .
    FILTER(LANG(?l1Label) = "en" || LANG(?l1Label) = "")
  }
}
GROUP BY ?l1 ?l1Label
ORDER BY DESC(?domainAvg)

# ── T7: Cross-graph comparison (multi-FROM) ───────────────────────────────────
# NL: "Compare maturity between [graph1] and [graph2]"
# Params: {{graphIRI1}}, {{graphIRI2}}

PREFIX ggsc:  <http://un-ggce.org/ggsc/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?capLabel
       ?avgA ?avgB
       (?avgB - ?avgA AS ?delta)
WHERE {
  GRAPH <{{graphIRI1}}> {
    ?cap a ggsc:Capability ;
         rdfs:label ?capLabel ;
         ggsc:hasMaturityAssessment ?maA .
    ?maA ggsc:hasAverageScore ?avgA .
  }
  GRAPH <{{graphIRI2}}> {
    ?cap ggsc:hasMaturityAssessment ?maB .
    ?maB ggsc:hasAverageScore ?avgB .
  }
  FILTER(LANG(?capLabel) = "en" || LANG(?capLabel) = "")
}
ORDER BY DESC(ABS(?delta))

# ── T8: All workflow tier risk scores ────────────────────────────────────────
# NL: "What are the highest risk tiers?" / "Show tier risk scores"
# Prefix: ggce: = https://w3id.org/un/ggce/

PREFIX ggce:  <https://w3id.org/un/ggce/>
PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?wfLabel ?tier ?tierLabel ?score ?classifLabel
WHERE {
  GRAPH ?g {
    ?wf a ggce:Workflow ; rdfs:label ?wfLabel ; ggce:hasTier ?t .
    ?t ggce:tier ?tier ; ggce:tierRiskScore ?score ; rdfs:label ?tierLabel .
    OPTIONAL { ?t ggce:riskClassification ?rc . ?rc rdfs:label ?classifLabel . }
  }
}
ORDER BY DESC(?score)

# ── T9: Tiers by guiding principle violation ─────────────────────────────────
# NL: "Which tiers violate P2?" / "Show tiers related to political resilience"

PREFIX ggce:    <https://w3id.org/un/ggce/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?wfLabel ?tierLabel ?score ?principleId
WHERE {
  GRAPH ?g {
    ?t a ggce:WorkflowTier ; rdfs:label ?tierLabel ;
       ggce:tierRiskScore ?score ;
       ggce:relatedPrinciples ?p ;
       ggce:workflow ?wf .
    ?wf rdfs:label ?wfLabel .
    ?p dcterms:identifier ?principleId .
  }
}
ORDER BY ?principleId DESC(?score)

# ── T10: Capabilities below maturity threshold ───────────────────────────────
# NL: "Which capabilities are below 2.5 maturity?" / "Show weak capabilities"

PREFIX ggce: <https://w3id.org/un/ggce/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?tierLabel ?capLabel ?avg
WHERE {
  GRAPH ?g {
    ?t a ggce:WorkflowTier ; rdfs:label ?tierLabel ;
       ggce:hasCapabilityScore ?cap .
    ?cap rdfs:label ?capLabel ; ggce:weightedAvg ?avg .
    FILTER(?avg < 2.5)
  }
}
ORDER BY ?avg

# ── T11: Persons with job title and organisation ──────────────────────────────
# NL: "List all persons" / "Who are the ontologists?"

PREFIX foaf:   <http://xmlns.com/foaf/0.1/>
PREFIX schema: <https://schema.org/>
PREFIX org:    <http://www.w3.org/ns/org#>
PREFIX rdfs:   <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?givenName ?familyName ?jobTitle ?affiliation
WHERE {
  GRAPH <https://w3id.org/ggsc/chloe/persons> {
    ?person a foaf:Person ;
            foaf:givenName ?givenName ; foaf:familyName ?familyName ;
            schema:jobTitle ?jobTitle ; org:memberOf ?org .
    ?org rdfs:label ?affiliation .
  }
}
ORDER BY ?familyName ?givenName
```

---

<!-- databook:id: nl-hints -->
```yaml
# NL-to-Graph Mapping Hints
# Maps natural language terms/phrases to GGSC graph concepts
# Used by the query builder to resolve ambiguous or informal language

entity-hints:
  # Observatories / stations
  - terms: [observatory, station, monitoring station, geodetic station, site, DOMES site]
    maps-to: ggsc:Observatory
    note: "Use ggsc:ObservatoryStub if context implies incomplete/stub record"

  - terms: [processing centre, analysis centre, combination centre, data centre,
            GNSS analysis, orbit determination, archive]
    maps-to: ggsc:ProcessingCentre
    note: "Distinct from Observatory — no coordinates"

  - terms: [central bureau, coordination centre, information system, service centre, IGS centre]
    maps-to: ggsc:Centre

  # Organisations
  - terms: [organisation, organization, agency, body, institute, bureau, service,
            national agency, space agency, mapping agency, IGS member]
    maps-to: bacm:Organization
    equivalent: holon:Organisation
    instance-ns: ggsc-org
    note: "ALWAYS query both types. Scenario graphs use holon:Organisation; use VALUES or UNION — see sparql-generation-rules."

  # Agents / people
  - terms: [agent, stakeholder, person, expert, representative, contact]
    maps-to: cco:Agent
    instance-ns: ggsc-agent

  # Capabilities
  - terms: [capability, capacity, ability, skill, function, what can they do]
    maps-to: ggsc:Capability
    note: "Clarify level if possible: domain (L1), sub-domain (L2), operational (L3)"

  - terms: [engagement, collaboration, partnerships]
    maps-to: ggsc-cap:EngagementCollaboration

  - terms: [governance, strategy, policy, management, coordination]
    maps-to: ggsc-cap:GovernanceStrategy

  - terms: [data management, data, information management, data sharing, archiving]
    maps-to: ggsc-cap:DataManagement

  - terms: [infrastructure, assets, equipment, instruments, hardware, network]
    maps-to: ggsc-cap:AssetInfrastructure

  - terms: [products, services, outputs, geodetic products, deliverables]
    maps-to: ggsc-cap:ProductsServices

  - terms: [innovation, development, R&D, research, new technology]
    maps-to: ggsc-cap:InnovationDevelopment

  # Value streams
  - terms: [value stream, workflow, supply chain flow, end-to-end process]
    maps-to: bacm:ValueStream
    instance-ns: ggsc-vs

  - terms: [observation to reference, raw to reference frame, ITRF production]
    maps-to: ggsc-vs:ObservationToReference

  - terms: [reference to application, derived products, applications]
    maps-to: ggsc-vs:ReferenceToApplication

  - terms: [real time, real-time, NRT, near-real-time operations]
    maps-to: ggsc-vs:RealTimeOperations

  - terms: [infrastructure sustainment, maintenance, sustaining, upkeep]
    maps-to: ggsc-vs:InfrastructureSustainment

  - terms: [capacity development, training, capacity building, developing countries]
    maps-to: ggsc-vs:CapacityDevelopment

  - terms: [standards, standards development, norms, international standards]
    maps-to: ggsc-vs:StandardsDevelopment

  # Maturity / PPTD
  - terms: [maturity, maturity score, PPTD, assessment, how mature, readiness]
    maps-to: ggsc:MaturityAssessment
    via: ggsc:hasMaturityAssessment
    note: "Always accessed via a Capability. Scores are 0.0–5.0."

  - terms: [people, human capacity, workforce, staff, expertise, skills]
    maps-to: ggsc:hasPeopleScore

  - terms: [process, procedures, workflows, processes, methodology]
    maps-to: ggsc:hasProcessScore

  - terms: [technology, tools, systems, software, hardware, instruments]
    maps-to: ggsc:hasTechnologyScore

  - terms: [data quality, data maturity, data management score, information]
    maps-to: ggsc:hasDataScore

property-hints:
  - terms: [operated by, operates, run by, managed by, responsible for]
    maps-to: ggsc:operatedBy

  - terms: [contributes to, supports, linked to, associated with capability]
    maps-to: ggsc:contributesToCapability

  - terms: [type, technique, what type of station, observation technique]
    maps-to: ggsc:observationType
    note: "For observatories. Use ggsc:functionType for ProcessingCentre/Centre."

  - terms: [status, active, operational, currently operating, offline]
    maps-to: ggsc:operationalStatus

  - terms: [location, where, coordinates, lat, lon, latitude, longitude, where is]
    maps-to: [geo:lat, geo:long]

  - terms: [criticality, how critical, importance, priority]
    maps-to: ggsc:criticalityLevel

  - terms: [member of, affiliated with, works for, part of organisation]
    maps-to: org:memberOf

graph-routing:
  # Maps entity types to the named graphs that contain their instances.
  # ALWAYS include the appropriate GRAPH clause when querying these types.

  - entity: [foaf:Person, cco:Agent, person, agent, stakeholder, contact, representative]
    graph: https://w3id.org/un/ggsc/persons
    sparql-pattern: "GRAPH <https://w3id.org/un/ggsc/persons> { ?p a foaf:Person ; foaf:name ?name }"
    note: "All person records live exclusively in this graph. Never omit GRAPH clause."

  - entity: [ggsc:Capability, ggsc:MaturityAssessment, capability, maturity, PPTD]
    graph: https://w3id.org/ggsc/geodesy/capabilities-v1
    sparql-pattern: "GRAPH <https://w3id.org/ggsc/geodesy/capabilities-v1> { ?cap a ggsc:Capability }"

  - entity: [ggsc:Observatory, ggsc:ProcessingCentre, ggsc:Centre, observatory, station]
    graph: https://w3id.org/ggsc/geodesy/capabilities-v1
    sparql-pattern: "GRAPH <https://w3id.org/ggsc/geodesy/capabilities-v1> { ?obs a ggsc:Observatory }"

  - entity: [bacm:Organization, organisation, agency, body]
    graph: https://w3id.org/ggsc/geodesy/capabilities-v1
    sparql-pattern: "GRAPH <https://w3id.org/ggsc/geodesy/capabilities-v1> { ?org a bacm:Organization }"

  - entity: [bacm:ValueStream, value stream]
    graph: https://w3id.org/ggsc/geodesy/capabilities-v1
    sparql-pattern: "GRAPH <https://w3id.org/ggsc/geodesy/capabilities-v1> { ?vs a bacm:ValueStream }"

  - entity: [scenario scene, scene graph]
    graph-pattern: "https://w3id.org/un/ggsc/scenario/s{N}/scene  where N = 1..7"
    sparql-pattern: "GRAPH <https://w3id.org/un/ggsc/scenario/s1/scene> { ?s ?p ?o }"

  - entity: [scenario events, event graph]
    graph-pattern: "https://w3id.org/un/ggsc/scenario/s{N}/events  where N = 1..7"

  - entity: [scenario agent]
    graph-pattern: "https://w3id.org/un/ggsc/scenario/s{N}/agent-{role}  where N=1..7"
    note: "s1-s4: alpha/beta/gamma; s5: navigator; s6: governance/quality/technical; s7: architect/qa/researcher"

  - entity: [alignment, vocabulary mapping, cross-vocabulary, equivalentClass]
    graph: https://w3id.org/un/ggsc/alignment
    note: "Contains owl:equivalentClass and rdfs:subClassOf alignments between holon: and bacm:/cco: vocabularies"

sparql-generation-rules:
  - rule: "ALWAYS use GRAPH <iri> { } inside WHERE — never FROM <iri> alone"
    rationale: >
      FROM combined with GRAPH causes COUNT, AVG and GROUP_CONCAT to return zero
      rows in Jena 6.0. Use GRAPH { } exclusively for named graph access.
    correct:   "SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { GRAPH <https://w3id.org/un/ggsc/persons> { ?p a foaf:Person } }"
    incorrect: "SELECT (COUNT(?p) AS ?n) FROM <https://w3id.org/un/ggsc/persons> WHERE { GRAPH <...> { ?p a foaf:Person } }"

  - rule: "Use DISTINCT in COUNT when counting entity instances"
    correct:   "SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { GRAPH <iri> { ?p a Type } }"
    incorrect: "SELECT (COUNT(?p) AS ?n) WHERE { GRAPH <iri> { ?p a Type } }"

  - rule: "For cross-graph queries, use multiple GRAPH clauses — not FROM + GRAPH"
    correct:   "WHERE { GRAPH <g1> { ?cap ?p1 ?o1 } GRAPH <g2> { ?cap ?p2 ?o2 } }"
    incorrect: "FROM <g1> FROM NAMED <g2> WHERE { ... GRAPH <g2> { } }"

  - rule: "When querying organisations, include BOTH holon:Organisation and bacm:Organization types"
    rationale: >
      Scenario graphs (s1-s7) type organisations as holon:Organisation.
      The capabilities graph and persons graph use bacm:Organization.
      owl:equivalentClass is declared in the alignment graph but Jena does not
      apply OWL reasoning by default — explicit UNION or VALUES is required.
    correct: |
      WHERE {
        GRAPH ?g {
          ?org a ?type .
          VALUES ?type { <https://ontologist.io/ns/holon#Organisation>
                         <http://omg.org/spec/BACM/Organization> }
          OPTIONAL { ?org rdfs:label ?label }
        }
      }
    also-correct: |
      WHERE {
        { GRAPH ?g { ?org a holon:Organisation } }
        UNION
        { GRAPH ?g { ?org a bacm:Organization } }
        OPTIONAL { GRAPH ?g { ?org rdfs:label ?label } }
      }

  # ── UN-GGCE Supply Chain Workflow terms ──────────────────────────────────────

  - terms: [workflow, supply chain workflow, geodetic workflow, EOP, ICRF, ITRF, satellite orbits, gravity, earth gravity]
    maps-to: ggce:Workflow
    instance-ns: ggcewf
    note: "CRITICAL: use ggce: prefix (https://w3id.org/un/ggce/), NOT ggsc: or holon:"

  - terms: [tier, workflow tier, supply chain tier, tier 0, tier 1, tier 2, tier 3, tier 4]
    maps-to: ggce:WorkflowTier
    instance-ns: ggcetier
    note: "IRI pattern: ggcetier:{workflow}_t{n}. Use GRAPH ?g wrapper."

  - terms: [tier risk score, risk score, risk, score, how risky, riskiest, highest risk]
    maps-to: ggce:tierRiskScore
    note: "xsd:decimal 0-25. High = 11+. Highest = Satellite Orbits T3 at 15.70."

  - terms: [guiding principle, principle, P1, P2, P3, P4, P5, P6, political resilience, centralised accountability, geographic distribution, technical interoperability, minimum capability maturity, transparency accountability]
    maps-to: ggce:GuidingPrinciple
    via: ggce:relatedPrinciples
    note: "Use dcterms:identifier to match P1-P6 strings."

  - terms: [PPTD, people score, process score, technology score, data score, weighted average, capability score]
    maps-to: ggce:CapabilityScore
    via: ggce:hasCapabilityScore
    note: "Properties: ggce:peopleScore, processScore, technologyScore, dataScore, weightedAvg."

  - terms: [risk classification, Critical, High, Significant, Minor, risk band]
    maps-to: ggce:RiskClassification
    via: ggce:riskClassification

graph-routing-ggce:
  - entity: [ggce:Workflow, ggce:WorkflowTier, ggce:CapabilityScore, workflow, tier, risk score]
    graph-pattern: "https://w3id.org/un/ggce/databook/{id}"
    graphs: [eop-workflow-v3, icrf-workflow-v3, itrf-workflow-v3, satellite-orbits-workflow-v2, gravity-workflow-v3]
    sparql-pattern: "GRAPH ?g { ?wf a ggce:Workflow ; ggce:hasTier ?t . ?t ggce:tierRiskScore ?score }"
    note: "Always use GRAPH ?g wildcard to query across all workflow named graphs."

  - entity: [ggce:GuidingPrinciple, P1, P2, P3, P4, P5, P6]
    graph: https://w3id.org/un/ggce/databook/investment-rubric-v2

namespace-critical:
  - rule: "Supply chain workflow data uses ggce: (https://w3id.org/un/ggce/), NOT ggsc: or holon:"
  - rule: "Always use GRAPH ?g wrapper for ggce: workflow queries"
  - rule: "ggce:Workflow hasTier ggce:WorkflowTier which has ggce:tierRiskScore (decimal 0-25)"
```
