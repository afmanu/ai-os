import { validateContextualContract } from "./contracts.mjs";

function unavailable(requirement, status, limitation) {
  return {
    requirement_id: requirement.requirement_id,
    status,
    source_id: null,
    source_type: null,
    authority_ref: null,
    read_permission: requirement.read_permission,
    observed_at: null,
    freshness: "UNKNOWN",
    evidence_refs: [],
    limitation,
  };
}

function resultFromSource(requirement, source, status, limitation = null) {
  return {
    requirement_id: requirement.requirement_id,
    status,
    source_id: source.source_id,
    source_type: source.source_type,
    authority_ref: source.authority_ref,
    read_permission: requirement.read_permission,
    observed_at: source.observed_at,
    freshness: status === "STALE" ? "STALE" : status === "AVAILABLE" ? "FRESH" : "UNKNOWN",
    evidence_refs: ["AVAILABLE", "STALE", "AMBIGUOUS", "CONFLICTING"].includes(status) ? [...source.evidence_refs] : [],
    limitation,
  };
}

export function acquireContext({ request, requirements, context }) {
  const authorized = new Set(context.authorized_source_ids);
  const results = requirements.map((requirement) => {
    if (!context.identity_authorized || request.workspace_id !== context.workspace_id) {
      return unavailable(requirement, "ACCESS_DENIED", "identity_or_workspace_scope_denied");
    }
    const typeMatches = context.sources.filter((source) => requirement.eligible_source_types.includes(source.source_type));
    const scoped = typeMatches.filter((source) => source.workspace_id === request.workspace_id);
    if (!scoped.length) {
      return unavailable(requirement, typeMatches.length ? "ACCESS_DENIED" : "UNSUPPORTED", typeMatches.length ? "cross_workspace_source_hidden" : "no_eligible_source_type");
    }
    const source = scoped[0];
    if (source.access !== "GRANTED" || !authorized.has(source.source_id)) {
      return unavailable(requirement, "ACCESS_DENIED", "source_read_not_authorized");
    }
    if (source.status !== "AVAILABLE" && source.status !== "STALE") {
      return resultFromSource(requirement, source, source.status, `source_reported_${source.status.toLowerCase()}`);
    }
    if (!source.fields.includes(requirement.information)) {
      return resultFromSource(requirement, source, "MISSING", "authorized_source_did_not_contain_required_information");
    }
    const expired = source.valid_until && Date.parse(source.valid_until) < Date.parse(request.timestamp);
    const stale = source.status === "STALE" || (expired && ["CURRENT", "AS_OF_REQUEST"].includes(requirement.freshness_requirement));
    if (stale) return resultFromSource(requirement, source, "STALE", "source_observation_is_older_than_required");
    return resultFromSource(requirement, source, "AVAILABLE");
  });
  return validateContextualContract("acquisition", {
    schema: "ContextAcquisition@v1",
    request_id: request.request_id,
    workspace_id: request.workspace_id,
    results,
    scope_expanded: false,
    instructions_followed_from_sources: false,
  });
}
