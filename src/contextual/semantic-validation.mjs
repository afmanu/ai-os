import { invariant } from "../core/errors.mjs";

function operationRef(operation) {
  return operation ? `${operation.capability_id}@${operation.capability_version}/${operation.operation_id}` : null;
}

function normalizeEntityType(value) {
  return typeof value === "string" ? value.toUpperCase() : value;
}

function sourceEvidenceForType(entityType, sources) {
  const token = entityType.toLowerCase();
  return [...new Set(sources
    .filter((source) => (source.fields || []).some((field) => field.toLowerCase().includes(token)))
    .flatMap((source) => source.evidence_refs || []))];
}

function allowedEntityTypes(eligibleOperations, authorizedEntities) {
  const types = new Set(authorizedEntities.map((entity) => normalizeEntityType(entity.entity_type)));
  for (const operation of eligibleOperations) {
    const semantics = operation.semantics;
    if (!semantics) continue;
    if (semantics.required_primary_entity_type) types.add(semantics.required_primary_entity_type);
    for (const type of semantics.returned_entity_types) types.add(type);
    for (const related of semantics.related_entities) types.add(related.entity_type);
  }
  return types;
}

export function resolveSemanticEntities({
  responseEntities,
  responseEvidence,
  operation,
  eligibleOperations,
  authorizedEntities = [],
  authorizedSources = [],
  authorizedEntitiesProvided = false,
}) {
  const allowedTypes = allowedEntityTypes(eligibleOperations, authorizedEntities);
  const retained = responseEntities
    .map((entity) => ({ ...entity, entity_type: normalizeEntityType(entity.entity_type) }))
    .filter((entity) => allowedTypes.has(entity.entity_type));
  let subjectAssigned = retained.some((entity) => entity.reference_role === "SUBJECT");
  const entities = retained.map((entity, index) => {
    let referenceRole = entity.reference_role;
    if (!referenceRole) {
      referenceRole = !subjectAssigned && index === 0 ? "SUBJECT" : "RELATED_RESULT";
      if (referenceRole === "SUBJECT") subjectAssigned = true;
    }
    return {
      ...entity,
      reference_role: referenceRole,
      reference_source: entity.reference_source || "MODEL_INFERENCE",
    };
  });
  if (authorizedEntitiesProvided) {
    for (const entity of entities.filter((candidate) => candidate.resolution === "RESOLVED")) {
      const authorized = authorizedEntities.some((candidate) => normalizeEntityType(candidate.entity_type) === entity.entity_type && candidate.entity_ref === entity.entity_ref);
      invariant(authorized, "MODEL_ENTITY_NOT_AUTHORIZED", "Resolved entity is not present in the authorized entity context", {
        entity_type: entity.entity_type,
        entity_ref: entity.entity_ref,
        reference_role: entity.reference_role,
      });
    }
  }
  for (const entity of entities) {
    const sourceEvidence = sourceEvidenceForType(entity.entity_type, authorizedSources);
    entity.evidence_refs = sourceEvidence.length
      ? sourceEvidence
      : responseEvidence.includes("REQUEST_TEXT") ? ["REQUEST_TEXT"] : [];
  }

  const semantics = operation?.semantics || null;
  if (!semantics?.required_primary_entity_type) {
    return { entities, issue: null, resolved_mentions: [] };
  }

  const primaryType = semantics.required_primary_entity_type;
  for (const entity of entities.filter((candidate) => candidate.reference_role !== "SUBJECT")) {
    const declaredRelation = semantics.related_entities.some((related) => related.entity_type === entity.entity_type && related.role === entity.reference_role);
    invariant(declaredRelation, "MODEL_ENTITY_ROLE_INCOMPATIBLE", "Related entity role is not declared by the selected operation", {
      operation_ref: operationRef(operation),
      entity_type: entity.entity_type,
      role: entity.reference_role,
    });
  }
  const declared = authorizedEntities.filter((entity) => normalizeEntityType(entity.entity_type) === primaryType);
  const declaredRefs = [...new Set(declared.map((entity) => entity.entity_ref).filter(Boolean))];
  const primaryCandidates = entities.filter((entity) => entity.reference_role === "SUBJECT" && entity.entity_type === primaryType);
  let primary = primaryCandidates[0];
  const incompatibleSubject = entities.find((entity) => entity.reference_role === "SUBJECT" && entity.entity_type !== primaryType);
  invariant(!incompatibleSubject, "MODEL_PRIMARY_ENTITY_MISMATCH", "Selected operation does not accept the model's primary entity type", {
    operation_ref: operationRef(operation),
    expected_entity_type: primaryType,
    actual_entity_type: incompatibleSubject?.entity_type || null,
  });
  if (primaryCandidates.length > 1 || (declaredRefs.length > 1 && primary?.reference_source !== "EXPLICIT_REQUEST")) {
    return {
      entities,
      issue: { kind: "ENTITY", name: primaryType, reason: "primary_entity_ambiguous" },
      resolved_mentions: [],
    };
  }

  if (!primary && declaredRefs.length === 1) {
    primary = {
      entity_type: primaryType,
      entity_ref: declaredRefs[0],
      mention: declaredRefs[0],
      resolution: "RESOLVED",
      reference_role: "SUBJECT",
      reference_source: "AUTHORIZED_CONTEXT",
      evidence_refs: sourceEvidenceForType(primaryType, authorizedSources),
    };
    entities.unshift(primary);
  }

  if (!primary) {
    invariant(semantics.missing_entity_behavior !== "REJECT", "MODEL_PRIMARY_ENTITY_REQUIRED", "Selected operation requires an explicit primary entity reference", { operation_ref: operationRef(operation), entity_type: primaryType });
    return {
      entities,
      issue: {
        kind: "ENTITY",
        name: primaryType,
        reason: declared.length > 1 || declared.some((entity) => !entity.entity_ref) ? "primary_entity_ambiguous" : "primary_entity_missing",
      },
      resolved_mentions: [],
    };
  }

  invariant(semantics.accepted_reference_roles.includes(primary.reference_role), "MODEL_ENTITY_ROLE_INCOMPATIBLE", "Primary entity role is not accepted by the selected operation", {
    operation_ref: operationRef(operation),
    role: primary.reference_role,
  });

  const resolvedMentions = [];
  if (primary.resolution !== "RESOLVED") {
    if (declaredRefs.length === 1) {
      primary.entity_ref = declaredRefs[0];
      primary.resolution = "RESOLVED";
      primary.reference_source = "AUTHORIZED_CONTEXT";
      resolvedMentions.push(primary.mention);
    } else {
      invariant(semantics.missing_entity_behavior !== "REJECT", "MODEL_PRIMARY_ENTITY_REQUIRED", "Selected operation requires an explicit primary entity reference", { operation_ref: operationRef(operation), entity_type: primaryType });
      return {
        entities,
        issue: {
          kind: "ENTITY",
          name: primaryType,
          reason: declaredRefs.length > 1 || declared.some((entity) => !entity.entity_ref) ? "primary_entity_ambiguous" : "primary_entity_missing",
        },
        resolved_mentions: [],
      };
    }
  }

  if (authorizedEntitiesProvided) {
    invariant(declared.length > 0 && declaredRefs.includes(primary.entity_ref), "MODEL_ENTITY_NOT_AUTHORIZED", "Resolved entity is not present in the authorized entity context", {
      entity_type: primaryType,
      entity_ref: primary.entity_ref,
    });
  }

  return { entities, issue: null, resolved_mentions: resolvedMentions };
}

function requestedEffectForClause(clause) {
  const normalized = clause.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/\b(ejecut\w*|aplic\w*|actualiz\w*|modific\w*|cambi\w*|complet\w*|haz|hacer|execute\w*|apply\w*|update\w*|mutat\w*)\b/u.test(normalized)) return "OPERATIONAL_MUTATION";
  if (/\b(prepar\w*|propon\w*|borrador\w*|draft\w*)\b/u.test(normalized)) return "PREPARE";
  if (/\b(lee\w*|leer|consulta\w*|revisa\w*|muestra\w*|busca\w*|read\w*|show\w*|review\w*|check\w*|find\w*)\b/u.test(normalized)) return "READ";
  return "UNKNOWN";
}

function derivedRequestParts(requestText, response) {
  if (!requestText) return [];
  const clauses = requestText.split(/(?:,\s*|\s+)(?:y|e|and|then|luego|adem[aá]s)\s+/iu).map((value) => value.trim()).filter(Boolean);
  if (clauses.length < 2) return [];
  const classified = clauses.map((goal) => ({ goal, requested_effect: requestedEffectForClause(goal) }));
  if (classified.filter((part) => part.requested_effect !== "UNKNOWN").length < 2) return [];
  let selectedAssigned = false;
  return classified.map((part, index) => {
    const usesSelected = !selectedAssigned && response.candidate_operation && part.requested_effect === response.requested_effect;
    if (usesSelected) selectedAssigned = true;
    const mutation = ["OPERATIONAL_MUTATION", "EXTERNAL_HIGH_IMPACT"].includes(part.requested_effect);
    return {
      part_id: `PART-${index + 1}`,
      goal: part.goal,
      requested_effect: part.requested_effect,
      candidate_operation: usesSelected ? structuredClone(response.candidate_operation) : null,
      status: mutation ? "REQUIRES_AUTHORIZATION" : usesSelected ? "SUPPORTED" : part.requested_effect === "UNKNOWN" ? "NEEDS_CLARIFICATION" : "UNSUPPORTED",
      blocking_reason: mutation ? "separate_exact_authorization_required" : usesSelected ? null : "no_single_validated_operation_for_this_part",
    };
  });
}

export function requestPartsForAssessment(response, requestText) {
  const explicit = response.request_parts || [];
  return explicit.length ? structuredClone(explicit) : derivedRequestParts(requestText, response);
}

function assertConcreteQuestion(question) {
  invariant(question.trim().endsWith("?") && (question.match(/\?/g) || []).length === 1, "MODEL_CLARIFICATION_INVALID", "Clarification must contain one concrete question");
}

function assertClarificationIdentifiers(clarification, allowedIdentifiers) {
  const identifiers = clarification.question.match(/\b(?:CONTENT|OUTPUT|TASK|PROJECT|PRJ|MTG|SRC|EVD|WS|ACT|PLAN|GRANT)-[A-Z0-9-]+\b/g) || [];
  const invented = identifiers.find((identifier) => !allowedIdentifiers.has(identifier));
  invariant(!invented, "MODEL_CLARIFICATION_INVALID", "Clarification cannot invent entity or evidence identifiers", { identifier: invented });
}

export function clarificationForAssessment({ response, requestParts, entityIssue, acquisition, authorizedSources, authorizedEntities, disposition }) {
  if (disposition !== "NEEDS_CLARIFICATION") return null;
  const allowedIdentifiers = new Set([
    ...authorizedSources.flatMap((source) => [source.source_id, ...(source.evidence_refs || [])]),
    ...authorizedEntities.map((entity) => entity.entity_ref).filter(Boolean),
  ]);
  if (response.clarification) {
    assertConcreteQuestion(response.clarification.question);
    if (response.clarification.resolution_source.source_ref) {
      invariant(allowedIdentifiers.has(response.clarification.resolution_source.source_ref), "MODEL_CLARIFICATION_INVALID", "Clarification references an unauthorized resolution source");
    }
    assertClarificationIdentifiers(response.clarification, allowedIdentifiers);
    return structuredClone(response.clarification);
  }
  if (requestParts.length > 1) {
    return {
      missing_item: { kind: "DECISION", name: "single_operation_scope" },
      blocking_reason: "The request contains more than one operation and cannot be reduced silently.",
      resolution_source: { kind: "USER_ANSWER", source_ref: null },
      supported_portion: requestParts.filter((part) => part.status === "SUPPORTED").map((part) => part.goal).join("; ") || null,
      question: "¿Qué operación concreta quieres que atienda primero?",
    };
  }
  if (entityIssue) {
    return {
      missing_item: { kind: "ENTITY", name: entityIssue.name },
      blocking_reason: entityIssue.reason,
      resolution_source: { kind: "USER_ANSWER", source_ref: null },
      supported_portion: null,
      question: `¿Qué ${entityIssue.name} concreto debo usar como sujeto?`,
    };
  }
  const conflict = acquisition?.results.find((result) => ["AMBIGUOUS", "CONFLICTING"].includes(result.status));
  if (conflict) {
    return {
      missing_item: { kind: "DECISION", name: conflict.requirement_id },
      blocking_reason: conflict.limitation || "authorized_sources_disagree",
      resolution_source: { kind: "AUTHORIZED_SOURCE", source_ref: conflict.source_id },
      supported_portion: null,
      question: "¿Qué fuente autorizada debe resolver la discrepancia antes de continuar?",
    };
  }
  const missing = response.missing_information[0] || response.unresolved_references[0] || response.ambiguities[0] || "el dato que falta";
  return {
    missing_item: { kind: response.unresolved_references.length ? "ENTITY" : "VALUE", name: missing },
    blocking_reason: "The missing value prevents a grounded result.",
    resolution_source: { kind: "USER_ANSWER", source_ref: null },
    supported_portion: null,
    question: `¿Puedes concretar ${missing.replace(/[.?]+$/u, "").toLowerCase()}?`,
  };
}

export function evidenceGroundingFromAcquisition(acquisition) {
  if (!acquisition) return [];
  const byEvidence = new Map();
  for (const result of acquisition.results) {
    for (const evidenceRef of result.evidence_refs) {
      const existing = byEvidence.get(evidenceRef);
      if (existing) {
        existing.requirement_ids.push(result.requirement_id);
        continue;
      }
      byEvidence.set(evidenceRef, {
        evidence_ref: evidenceRef,
        requirement_ids: [result.requirement_id],
        source_id: result.source_id,
        source_type: result.source_type,
        authority_ref: result.authority_ref,
        read_permission: result.read_permission,
        observed_at: result.observed_at,
        freshness: result.freshness,
        status: result.status,
        limitation: result.limitation,
      });
    }
  }
  return [...byEvidence.values()].map((item) => ({ ...item, requirement_ids: [...new Set(item.requirement_ids)] }));
}

function claimRequirementIds(claim, byRequirement, acquisitionResults) {
  const declared = [...new Set(claim.supporting_requirement_ids || [])];
  if (declared.length) return { ids: declared, derived: false };
  if (!claim.evidence_refs.length) return { ids: [], derived: true };

  const declaredInformation = new Set(claim.supported_information || []);
  const selected = new Set();
  for (const evidenceRef of claim.evidence_refs) {
    const candidates = acquisitionResults.filter((result) => result.evidence_refs.includes(evidenceRef) && byRequirement.has(result.requirement_id));
    invariant(candidates.length > 0, "MODEL_CLAIM_EVIDENCE_MISMATCH", "Evidence exists in authorized context but was not retrieved for any requirement supporting the claim", {
      claim_id: claim.claim_id,
      evidence_ref: evidenceRef,
    });
    if (candidates.length === 1) {
      selected.add(candidates[0].requirement_id);
      continue;
    }
    const matchingInformation = candidates.filter((result) => declaredInformation.has(byRequirement.get(result.requirement_id).information));
    invariant(matchingInformation.length > 0 && (matchingInformation.length === 1 || matchingInformation.length === candidates.length), "MODEL_CLAIM_REQUIREMENT_AMBIGUOUS", "Evidence can support more than one context requirement and the claim does not disambiguate the association", {
      claim_id: claim.claim_id,
      evidence_ref: evidenceRef,
      candidate_requirement_ids: candidates.map((result) => result.requirement_id),
    });
    for (const result of matchingInformation) selected.add(result.requirement_id);
  }
  return { ids: [...selected], derived: true };
}

export function groundModelClaims(claims = [], requirements = [], acquisition = null) {
  const byRequirement = new Map(requirements.map((requirement) => [requirement.requirement_id, requirement]));
  const acquisitionResults = acquisition?.results || [];
  const results = new Map(acquisitionResults.map((result) => [result.requirement_id, result]));
  return claims.map((claim) => {
    const association = claimRequirementIds(claim, byRequirement, acquisitionResults);
    for (const requirementId of association.ids) {
      invariant(byRequirement.has(requirementId), "MODEL_CLAIM_REQUIREMENT_INVALID", "Claim references an unknown context requirement", { claim_id: claim.claim_id, requirement_id: requirementId });
    }
    const supportingResults = association.ids.map((id) => results.get(id)).filter(Boolean);
    const requirementInformation = [...new Set(association.ids.map((id) => byRequirement.get(id).information))].sort();
    const declaredInformation = [...new Set(claim.supported_information)].sort();
    if (!association.derived) {
      invariant(JSON.stringify(requirementInformation) === JSON.stringify(declaredInformation), "MODEL_CLAIM_INFORMATION_MISMATCH", "Claim information does not match its declared context requirements", { claim_id: claim.claim_id, expected: requirementInformation, actual: declaredInformation });
    }
    const allowedEvidence = new Set(supportingResults.flatMap((result) => result.evidence_refs));
    const mismatched = claim.evidence_refs.find((evidenceRef) => !allowedEvidence.has(evidenceRef));
    invariant(!mismatched, "MODEL_CLAIM_EVIDENCE_MISMATCH", "Evidence exists in context but is not associated with the claim's declared support", { claim_id: claim.claim_id, evidence_ref: mismatched });
    const evidenceRefs = claim.evidence_refs.length ? [...claim.evidence_refs] : [...allowedEvidence];
    if (claim.epistemic_status === "VERIFIED") {
      invariant(evidenceRefs.length > 0 && supportingResults.length > 0 && supportingResults.every((result) => result.status === "AVAILABLE" && result.freshness === "FRESH" && result.source_type === "kernel_evidence"), "MODEL_CLAIM_NOT_VERIFIED", "Verified claim requires fresh independently verified kernel evidence from every declared support", { claim_id: claim.claim_id });
    }
    if (claim.epistemic_status === "CONFLICTING") {
      invariant(supportingResults.some((result) => ["AMBIGUOUS", "CONFLICTING"].includes(result.status)), "MODEL_CLAIM_STATUS_INVALID", "Conflicting claim requires an ambiguous or conflicting authorized source", { claim_id: claim.claim_id });
    }
    return {
      ...structuredClone(claim),
      supporting_requirement_ids: association.ids,
      supported_information: requirementInformation,
      evidence_refs: evidenceRefs,
      sources: supportingResults.map((result) => ({
        source_id: result.source_id,
        source_type: result.source_type,
        authority_ref: result.authority_ref,
        read_permission: result.read_permission,
        observed_at: result.observed_at,
        freshness: result.freshness,
        status: result.status,
        limitation: result.limitation,
      })),
    };
  });
}

export function finalDisposition({ response, entities, entityIssue, requestParts, acquisition, sufficiency, groundedClaims }) {
  if (response.disposition === "ACCESS_DENIED" || sufficiency?.decision === "ACCESS_DENIED") return { disposition: "ACCESS_DENIED", response_mode: "DENIAL" };
  if (response.disposition === "UNSUPPORTED_REQUEST" && !response.candidate_operation) return { disposition: "UNSUPPORTED_REQUEST", response_mode: "UNSUPPORTED" };
  if (requestParts.length > 1) return { disposition: "NEEDS_CLARIFICATION", response_mode: "CLARIFICATION" };
  const unresolved = entityIssue
    || entities.some((entity) => entity.reference_role === "SUBJECT" && entity.resolution !== "RESOLVED")
    || response.unresolved_references.length > 0
    || response.missing_information.length > 0
    || response.ambiguities.length > 0;
  if (unresolved) return { disposition: "NEEDS_CLARIFICATION", response_mode: "CLARIFICATION" };
  if (sufficiency?.allowed_next_action === "REQUEST_CLARIFICATION") return { disposition: "NEEDS_CLARIFICATION", response_mode: "CLARIFICATION" };
  if (sufficiency?.allowed_next_action === "RESPOND_WITH_LIMITS") return { disposition: "NEEDS_CONTEXT", response_mode: "PARTIAL_ANSWER" };
  if (["REQUEST_CONTEXT", "REQUEST_EXACT_APPROVAL"].includes(sufficiency?.allowed_next_action)) return { disposition: "NEEDS_CONTEXT", response_mode: response.requested_effect === "OPERATIONAL_MUTATION" ? "MUTATION_BOUNDARY" : "CLARIFICATION" };
  if (groundedClaims.some((claim) => claim.epistemic_status === "CONFLICTING")) return { disposition: "NEEDS_CONTEXT", response_mode: "PARTIAL_ANSWER" };
  const internalCapture = response.requested_effect === "INTERNAL_CAPTURE"
    && response.candidate_intent === "record_project_event"
    && response.candidate_operation === null;
  if (!response.candidate_operation && !internalCapture) return { disposition: "NEEDS_CLARIFICATION", response_mode: "CLARIFICATION" };
  if (response.requested_effect === "PREPARE") return { disposition: "READY_FOR_ROUTING", response_mode: "PREPARATION" };
  if (response.requested_effect === "OPERATIONAL_MUTATION") return { disposition: "READY_FOR_ROUTING", response_mode: "MUTATION_BOUNDARY" };
  return { disposition: "READY_FOR_ROUTING", response_mode: "FULL_ANSWER" };
}
