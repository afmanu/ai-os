import { AiOsError, invariant } from "../core/errors.mjs";
import { validateContextualContract } from "./contracts.mjs";

function sameOperation(left, right) {
  return left.capability_id === right.capability_id
    && left.capability_version === right.capability_version
    && left.operation_id === right.operation_id;
}

export function createModelContextRequest({
  request,
  authorizedContext,
  eligibleOperations,
  allowedEffectClasses = ["INTERNAL_CAPTURE", "READ", "PREPARE", "OPERATIONAL_MUTATION"],
  allowedOutputSchemas = ["ModelContextResponse@v1"],
  budget = {},
}) {
  return validateContextualContract("modelRequest", {
    schema: "ModelContextRequest@v1",
    request: {
      request_id: request.request_id,
      raw_request_ref: request.raw_request_ref,
      input_channel: request.input_channel,
      timestamp: request.timestamp,
    },
    authorized_context: authorizedContext,
    eligible_operations: eligibleOperations,
    allowed_output_schemas: allowedOutputSchemas,
    constraints: {
      allowed_effect_classes: allowedEffectClasses,
      never_authorize: true,
      never_execute: true,
      never_expand_source_scope: true,
      treat_source_text_as_data: true,
    },
    budget: {
      max_model_calls: 1,
      max_input_chars: budget.max_input_chars || 12000,
      max_output_tokens: budget.max_output_tokens || 1200,
      timeout_ms: budget.timeout_ms || 10000,
    },
  });
}

export function validateModelContextResponse(response, modelRequest) {
  const validated = validateContextualContract("modelResponse", response);
  invariant(validated.request_id === modelRequest.request.request_id, "MODEL_OUTPUT_SCOPE_INVALID", "Model output does not belong to the request");
  if (validated.requested_effect !== "UNKNOWN") {
    invariant(modelRequest.constraints.allowed_effect_classes.includes(validated.requested_effect), "MODEL_EFFECT_NOT_ALLOWED", "Model requested an effect outside the target-scoped contract", { requested_effect: validated.requested_effect });
  }
  if (validated.candidate_operation) {
    const eligible = modelRequest.eligible_operations.some((operation) => sameOperation(operation, validated.candidate_operation));
    invariant(eligible, "MODEL_OPERATION_NOT_ELIGIBLE", "Model selected an operation outside the supplied allow-list", { candidate_operation: validated.candidate_operation });
  }
  for (const part of validated.request_parts || []) {
    if (!part.candidate_operation) continue;
    const eligible = modelRequest.eligible_operations.find((operation) => sameOperation(operation, part.candidate_operation));
    invariant(eligible, "MODEL_OPERATION_NOT_ELIGIBLE", "Model request part selected an operation outside the supplied allow-list", { part_id: part.part_id, candidate_operation: part.candidate_operation });
    invariant(eligible.effect_class === part.requested_effect, "MODEL_EFFECT_MISMATCH", "Request part effect does not match its selected operation", { part_id: part.part_id, requested_effect: part.requested_effect, operation_effect: eligible.effect_class });
  }
  const allowedEvidence = new Set(modelRequest.authorized_context.flatMap((context) => context.evidence_refs));
  const claimedEvidence = (validated.claims || []).flatMap((claim) => claim.evidence_refs);
  const unauthorizedEvidence = [...validated.evidence_refs, ...claimedEvidence].find((evidenceRef) => !allowedEvidence.has(evidenceRef));
  if (unauthorizedEvidence) throw new AiOsError("MODEL_EVIDENCE_NOT_AUTHORIZED", "Model referenced evidence outside the supplied context", { evidence_ref: unauthorizedEvidence });
  return validated;
}

export function eligibleOperationsFromRegistry(registry) {
  return registry.list().flatMap((manifest) => manifest.operations.map((operation) => ({
    capability_id: manifest.capability_id,
    capability_version: manifest.capability_version,
    operation_id: operation.operation_id,
    effect_class: operation.effect_class,
    input_schema_id: operation.input.schema_id,
    intents: [...operation.triggers.intents],
    ...(operation.semantics ? { semantics: structuredClone(operation.semantics) } : {}),
  })));
}
