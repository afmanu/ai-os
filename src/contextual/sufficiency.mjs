import { validateContextualContract } from "./contracts.mjs";

const usable = new Set(["AVAILABLE"]);

export function assessContextSufficiency({ requestId, target, requirements, acquisition, grant = null, unsupported = false }) {
  const relevant = requirements.filter((requirement) => requirement.critical_for.includes(target));
  const byId = new Map(acquisition.results.map((result) => [result.requirement_id, result]));
  const met = relevant.filter((requirement) => usable.has(byId.get(requirement.requirement_id)?.status)).map((requirement) => requirement.requirement_id);
  const blocked = relevant.filter((requirement) => !usable.has(byId.get(requirement.requirement_id)?.status));
  const denied = blocked.some((requirement) => byId.get(requirement.requirement_id)?.status === "ACCESS_DENIED");
  const authorizationRequired = target === "EXECUTE_AUTHORIZED_ACTION";
  const authorizationPresent = grant?.state === "VALID";
  const scopeMatches = authorizationPresent && grant.scope_matches === true;
  const authorizationBlocks = authorizationRequired && (!authorizationPresent || !scopeMatches);
  const nonBlocking = acquisition.results
    .filter((result) => !relevant.some((requirement) => requirement.requirement_id === result.requirement_id) && !usable.has(result.status))
    .map((result) => ({ requirement_id: result.requirement_id, status: result.status, limitation: result.limitation || "non_critical_context_unavailable" }));

  let decision;
  let next;
  const rationale = [];
  if (unsupported) {
    decision = "UNSUPPORTED";
    next = "UNSUPPORTED";
    rationale.push("INTERPRETATION_UNSUPPORTED");
  } else if (denied) {
    decision = "ACCESS_DENIED";
    next = "DENY";
    rationale.push("READ_SCOPE_DENIED");
  } else if (target !== "ANSWER" && blocked.some((requirement) => ["AMBIGUOUS", "CONFLICTING"].includes(byId.get(requirement.requirement_id)?.status))) {
    decision = "INSUFFICIENT";
    next = "REQUEST_CLARIFICATION";
    rationale.push("AMBIGUOUS_OR_CONFLICTING_CONTEXT");
  } else if (authorizationBlocks) {
    decision = "INSUFFICIENT";
    next = authorizationPresent ? "DENY" : "REQUEST_EXACT_APPROVAL";
    rationale.push(authorizationPresent ? "GRANT_SCOPE_MISMATCH" : "EXACT_GRANT_REQUIRED");
  } else if (blocked.length && target === "ANSWER" && met.length) {
    decision = "PARTIAL_WITH_LIMITS";
    next = "RESPOND_WITH_LIMITS";
    rationale.push("PARTIAL_CONTEXT_ONLY");
  } else if (blocked.length) {
    decision = "INSUFFICIENT";
    const ambiguous = blocked.some((requirement) => ["AMBIGUOUS", "CONFLICTING"].includes(byId.get(requirement.requirement_id)?.status));
    next = ambiguous ? "REQUEST_CLARIFICATION" : "REQUEST_CONTEXT";
    rationale.push(ambiguous ? "AMBIGUOUS_OR_CONFLICTING_CONTEXT" : "CRITICAL_CONTEXT_MISSING");
  } else {
    decision = "SUFFICIENT";
    next = target === "ANSWER" ? "RESPOND" : target === "PREPARE" ? "PREPARE" : target === "EXACT_APPROVAL_REQUEST" ? "REQUEST_EXACT_APPROVAL" : "EXECUTE_AUTHORIZED";
    rationale.push("ALL_TARGET_REQUIREMENTS_MET");
  }

  const blockingIds = blocked.map((requirement) => requirement.requirement_id);
  if (authorizationBlocks) blockingIds.push("AUTHORIZATION");
  const evidenceRefs = acquisition.results.flatMap((result) => result.evidence_refs);
  return validateContextualContract("sufficiency", {
    schema: "ContextSufficiency@v1",
    request_id: requestId,
    target,
    decision,
    met_requirement_ids: [...new Set(met)],
    blocking_requirement_ids: [...new Set(blockingIds)],
    non_blocking_gaps: nonBlocking,
    evidence_refs: [...new Set(evidenceRefs)],
    authorization: {
      required: authorizationRequired,
      present: authorizationPresent,
      scope_matches: scopeMatches,
      grant_ref: authorizationPresent ? grant.grant_ref : null,
    },
    allowed_next_action: next,
    execution_permitted: next === "EXECUTE_AUTHORIZED",
    rationale_codes: rationale,
  });
}
