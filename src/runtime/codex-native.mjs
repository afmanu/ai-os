import { invariant } from "../core/errors.mjs";
import { normalizeRequest } from "../core/normalizer.mjs";
import { authorizeCapture, policyDecisionForEffect } from "../core/policy.mjs";
import { canonicalJson, sha256 } from "../core/utils.mjs";
import { acquireContext } from "../contextual/acquisition.mjs";
import { validateContextualContract } from "../contextual/contracts.mjs";
import { createModelContextRequest, validateModelContextResponse } from "../contextual/model-interface.mjs";
import { requirementsForOperation } from "../contextual/profiles.mjs";
import {
  clarificationForAssessment,
  evidenceGroundingFromAcquisition,
  finalDisposition,
  groundModelClaims,
  requestPartsForAssessment,
  resolveSemanticEntities,
} from "../contextual/semantic-validation.mjs";
import { assessContextSufficiency } from "../contextual/sufficiency.mjs";

const targets = new Set(["ANSWER", "PREPARE", "EXACT_APPROVAL_REQUEST", "EXECUTE_AUTHORIZED_ACTION"]);

function operationRef(operation) {
  return `${operation.capability_id}@${operation.capability_version}/${operation.operation_id}`;
}

function runtimeRequest(options, identity, timestamp) {
  invariant(options.requestId, "RUNTIME_REQUEST_INVALID", "Codex runtime request requires request_id");
  invariant(options.rawRequestRef, "RUNTIME_REQUEST_INVALID", "Codex runtime request requires raw_request_ref");
  return {
    request_id: options.requestId,
    actor_id: identity.actor_id,
    workspace_id: identity.workspace_id,
    raw_request_ref: options.rawRequestRef,
    input_channel: options.inputChannel || "codex",
    timestamp,
  };
}

function operationEffectForTarget(target) {
  if (target === "ANSWER") return "READ";
  if (["PREPARE", "EXACT_APPROVAL_REQUEST"].includes(target)) return "PREPARE";
  return "OPERATIONAL_MUTATION";
}

function allowedEffectsForTarget(target) {
  if (target === "ANSWER") return ["INTERNAL_CAPTURE", "READ"];
  return [operationEffectForTarget(target)];
}

function sourceAccessAllowsOperation(operation, packet, workspaceId, target) {
  if (!packet) return true;
  const authorizedIds = new Set(packet.context.authorized_source_ids);
  const requirements = requirementsForOperation(operation, workspaceId)
    .filter((requirement) => requirement.critical_for.includes(target));
  return requirements.every((requirement) => {
    const declared = packet.context.sources.filter((source) => requirement.eligible_source_types.includes(source.source_type));
    if (!declared.length) return false;
    return declared.some((source) => source.workspace_id === workspaceId
      && source.access === "GRANTED"
      && authorizedIds.has(source.source_id));
  });
}

function eligibleOperations(kernel, scope, capabilitySnapshot, target, packet) {
  const policy = kernel.policies(scope.workspaceId).action;
  const expectedEffect = operationEffectForTarget(target);
  return capabilitySnapshot
    .filter((entry) => entry.enabled)
    .flatMap((entry) => {
      const { manifest } = kernel.capability({
        ...scope,
        capabilityId: entry.capability_id,
        capabilityVersion: entry.capability_version,
      });
      return manifest.operations
        .filter((operation) => operation.effect_class === expectedEffect)
        .filter((operation) => policy.rules[`${entry.capability_ref}/${operation.operation_id}`] === policyDecisionForEffect(operation.effect_class))
        .filter((operation) => sourceAccessAllowsOperation({
          capability_id: manifest.capability_id,
          capability_version: manifest.capability_version,
          operation_id: operation.operation_id,
        }, packet, scope.workspaceId, target))
        .map((operation) => ({
          capability_id: manifest.capability_id,
          capability_version: manifest.capability_version,
          operation_id: operation.operation_id,
          effect_class: operation.effect_class,
          input_schema_id: operation.input.schema_id,
          intents: [...operation.triggers.intents],
          ...(operation.semantics ? { semantics: structuredClone(operation.semantics) } : {}),
        }));
    })
    .sort((left, right) => operationRef(left).localeCompare(operationRef(right)));
}

function validateEntity(entity) {
  if (entity.resolution === "RESOLVED") {
    invariant(typeof entity.entity_ref === "string" && entity.entity_ref.trim().length > 0, "MODEL_ENTITY_INVALID", "Resolved model entity requires entity_ref", { mention: entity.mention });
  } else {
    invariant(entity.entity_ref === null, "MODEL_ENTITY_INVALID", "Unresolved or ambiguous model entity cannot select an entity_ref", { mention: entity.mention });
  }
}

function validateEffectiveDisposition(response, outcome) {
  if (response.disposition === "ACCESS_DENIED") {
    invariant(outcome.disposition === "ACCESS_DENIED", "MODEL_DISPOSITION_INVALID", "A denied model candidate cannot be elevated by the kernel");
  }
  if (outcome.disposition === "READY_FOR_ROUTING") {
    const internalCapture = response.requested_effect === "INTERNAL_CAPTURE"
      && response.candidate_intent === "record_project_event"
      && response.candidate_operation === null;
    invariant(response.candidate_operation || internalCapture, "MODEL_DISPOSITION_INVALID", "Effective routing requires an eligible operation or an internal capture candidate");
  }
}

function evaluationPacket(options, identity, request) {
  if (!options.contextPacket) return null;
  const packet = validateContextualContract("evaluationPacket", structuredClone(options.contextPacket));
  invariant(packet.synthetic_only, "EVALUATION_CONTEXT_INVALID", "Evaluation context must be explicitly synthetic");
  invariant(packet.input.request_id === request.request_id, "EVALUATION_CONTEXT_INVALID", "Evaluation context request_id does not match");
  invariant(packet.input.raw_request_ref === request.raw_request_ref, "EVALUATION_CONTEXT_INVALID", "Evaluation context request_ref does not match");
  invariant(packet.input.actor_id === identity.actor_id, "EVALUATION_CONTEXT_INVALID", "Evaluation context actor does not match the authenticated actor");
  invariant(packet.input.workspace_id === identity.workspace_id, "EVALUATION_CONTEXT_INVALID", "Evaluation context workspace does not match the authenticated workspace");
  if (options.target) invariant(packet.target === options.target, "EVALUATION_CONTEXT_INVALID", "Evaluation context target does not match the assessment target");
  return packet;
}

function freshnessForSource(source) {
  if (source.status === "AVAILABLE") return "FRESH";
  if (source.status === "STALE") return "STALE";
  return "UNKNOWN";
}

function authorizedPacketView(packet, identity) {
  if (!packet) return null;
  const context = packet.context;
  if (!context.identity_authorized || context.workspace_id !== identity.workspace_id) {
    return {
      schema: packet.schema,
      benchmark_id: packet.benchmark_id,
      benchmark_version: packet.benchmark_version,
      case_id: packet.case_id,
      synthetic_only: true,
      entities: [],
      sources: [],
      limitations: [{ code: "IDENTITY_OR_WORKSPACE_SCOPE_DENIED", source_type: null, read_permission: null }],
      instructions_followed_from_sources: false,
    };
  }
  const authorizedIds = new Set(context.authorized_source_ids);
  const sources = [];
  const limitations = [];
  for (const source of context.sources) {
    if (source.workspace_id !== identity.workspace_id) {
      limitations.push({ code: "CROSS_WORKSPACE_SOURCE_HIDDEN", source_type: source.source_type, read_permission: source.read_permission });
      continue;
    }
    if (source.access !== "GRANTED" || !authorizedIds.has(source.source_id)) {
      limitations.push({ code: "SOURCE_READ_NOT_AUTHORIZED", source_type: source.source_type, read_permission: source.read_permission });
      continue;
    }
    sources.push({
      context_ref: `evaluation:${packet.case_id}:${source.source_id}`,
      source_id: source.source_id,
      source_type: source.source_type,
      authority_ref: source.authority_ref,
      read_permission: source.read_permission,
      status: source.status,
      observed_at: source.observed_at,
      valid_until: source.valid_until,
      freshness: freshnessForSource(source),
      fields: [...source.fields],
      evidence_refs: [...source.evidence_refs],
      payload_text: source.payload_text,
    });
  }
  return {
    schema: packet.schema,
    benchmark_id: packet.benchmark_id,
    benchmark_version: packet.benchmark_version,
    case_id: packet.case_id,
    synthetic_only: true,
    entities: structuredClone(context.entities),
    sources,
    limitations,
    instructions_followed_from_sources: false,
  };
}

function authorityDecision(packet, identity, packetView) {
  if (!packet) {
    return {
      decision: "GRANTED",
      actor_authenticated: true,
      workspace_allowed: true,
      authorized_source_count: 0,
      limited_source_count: 0,
    };
  }
  const denied = !packet.context.identity_authorized || packet.context.workspace_id !== identity.workspace_id;
  return {
    decision: denied ? "ACCESS_DENIED" : packetView.limitations.length ? "GRANTED_WITH_LIMITS" : "GRANTED",
    actor_authenticated: true,
    workspace_allowed: !denied,
    authorized_source_count: denied ? 0 : packetView.sources.length,
    limited_source_count: packetView.limitations.length,
  };
}

function targetAcceptsEffect(target, effectClass) {
  if (target === "ANSWER") return ["INTERNAL_CAPTURE", "READ"].includes(effectClass);
  if (["PREPARE", "EXACT_APPROVAL_REQUEST"].includes(target)) return effectClass === "PREPARE";
  return effectClass === "OPERATIONAL_MUTATION";
}

function runtimeAcquisition({ kernel, request, requirements, contextPacket = null }) {
  if (contextPacket) return acquireContext({ request, requirements, context: contextPacket.context });
  const policy = kernel.policies(request.workspace_id).action;
  const results = requirements.map((requirement) => {
    if (requirement.information === "workspace_identity") {
      return {
        requirement_id: requirement.requirement_id,
        status: "AVAILABLE",
        source_id: "codex.runtime.identity",
        source_type: requirement.eligible_source_types[0],
        authority_ref: requirement.authority_needed,
        read_permission: requirement.read_permission,
        observed_at: request.timestamp,
        freshness: "FRESH",
        evidence_refs: [`IDENTITY:${request.actor_id}@${request.workspace_id}`],
        limitation: null,
      };
    }
    if (requirement.information === "action_policy") {
      return {
        requirement_id: requirement.requirement_id,
        status: "AVAILABLE",
        source_id: policy.policy_id,
        source_type: requirement.eligible_source_types[0],
        authority_ref: requirement.authority_needed,
        read_permission: requirement.read_permission,
        observed_at: request.timestamp,
        freshness: "FRESH",
        evidence_refs: [`${policy.policy_id}@${policy.version}`],
        limitation: null,
      };
    }
    return {
      requirement_id: requirement.requirement_id,
      status: "MISSING",
      source_id: null,
      source_type: null,
      authority_ref: null,
      read_permission: requirement.read_permission,
      observed_at: null,
      freshness: "UNKNOWN",
      evidence_refs: [],
      limitation: "not_retrieved_through_a_public_kernel_read",
    };
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

function dispositionAfterAssessment(modelDisposition, sufficiency) {
  if (["NEEDS_CLARIFICATION", "ACCESS_DENIED", "UNSUPPORTED_REQUEST"].includes(modelDisposition)) return modelDisposition;
  if (!sufficiency) return modelDisposition;
  if (sufficiency.decision === "ACCESS_DENIED") return "ACCESS_DENIED";
  if (sufficiency.decision === "UNSUPPORTED") return "UNSUPPORTED_REQUEST";
  if (sufficiency.allowed_next_action === "REQUEST_CLARIFICATION") return "NEEDS_CLARIFICATION";
  if (["REQUEST_CONTEXT", "RESPOND_WITH_LIMITS", "REQUEST_EXACT_APPROVAL"].includes(sufficiency.allowed_next_action)) return "NEEDS_CONTEXT";
  return "READY_FOR_ROUTING";
}

function requestedTarget(target, normalized = null) {
  if (normalized?.requested_effect === "INTERNAL_CAPTURE") return "INTERNAL_CAPTURE";
  if (normalized?.requested_effect === "READ") return "ANSWER";
  if (normalized?.requested_effect) return normalized.requested_effect;
  if (target === "ANSWER") return "ANSWER";
  return operationEffectForTarget(target);
}

function entitySeed(packetView) {
  const values = (type) => [...new Set((packetView?.entities || [])
    .filter((entity) => entity.entity_type === type)
    .map((entity) => entity.entity_ref)
    .filter(Boolean))];
  const projects = values("PROJECT");
  const tasks = values("TASK");
  return {
    projectRef: projects.length === 1 ? projects[0] : null,
    taskRef: tasks.length === 1 ? tasks[0] : null,
    ambiguous: projects.length > 1 || tasks.length > 1,
  };
}

function normalizedEntities(normalized) {
  const entities = [];
  if (normalized.entities.project_ref || normalized.entities.project_name) {
    entities.push({
      entity_type: "PROJECT",
      mention: normalized.entities.project_name || normalized.entities.project_ref,
      entity_ref: normalized.entities.project_ref,
      resolution: normalized.entities.project_ref ? "RESOLVED" : "UNRESOLVED",
      evidence_refs: ["REQUEST_TEXT"],
    });
  }
  if (normalized.entities.task_ref) {
    entities.push({
      entity_type: "TASK",
      mention: normalized.entities.task_ref,
      entity_ref: normalized.entities.task_ref,
      resolution: "RESOLVED",
      evidence_refs: ["REQUEST_TEXT"],
    });
  }
  return entities;
}

function routingDecision({
  mode,
  target,
  normalized = null,
  selectedOperation = null,
  policy = null,
  disposition,
  reasonCodes,
  interpretation = null,
  acquisition = null,
  sufficiency = null,
}) {
  return {
    schema: "RuntimeRoutingDecision@v1",
    mode,
    model_call_required: mode === "DELEGATE_TO_CODEX",
    requested_target: requestedTarget(target, normalized),
    normalization: {
      status: normalized ? "SUCCEEDED" : mode === "ACCESS_DENIED" ? "NOT_ATTEMPTED" : "UNAVAILABLE",
      request: normalized,
    },
    selected_operation: selectedOperation,
    policy,
    disposition,
    reason_codes: [...new Set(reasonCodes)],
    interpretation,
    acquisition,
    sufficiency,
    execution_attempted: false,
    grant_created: false,
    kernel_writes: 0,
  };
}

function deterministicRouting({ kernel, scope, identity, request, requestText, target, packet, packetView, operations }) {
  if (!requestText) {
    return routingDecision({
      mode: "DELEGATE_TO_CODEX",
      target,
      disposition: "NEEDS_CONTEXT",
      reasonCodes: ["REQUEST_TEXT_NOT_AVAILABLE"],
    });
  }

  const seed = entitySeed(packetView);
  if (seed.ambiguous) {
    return routingDecision({
      mode: "NEEDS_CLARIFICATION",
      target,
      disposition: "NEEDS_CLARIFICATION",
      reasonCodes: ["PRINCIPAL_ENTITY_AMBIGUOUS"],
    });
  }

  let normalized;
  try {
    normalized = normalizeRequest({
      text: requestText,
      workspaceId: identity.workspace_id,
      projectRef: seed.projectRef,
      projectName: null,
      taskRef: seed.taskRef,
    });
  } catch (error) {
    return routingDecision({
      mode: "DELEGATE_TO_CODEX",
      target,
      disposition: error.code === "NEEDS_CLARIFICATION" ? "NEEDS_CLARIFICATION" : "NEEDS_CONTEXT",
      reasonCodes: [error.code || "DETERMINISTIC_INTERPRETATION_UNAVAILABLE"],
    });
  }

  if (!targetAcceptsEffect(target, normalized.requested_effect)) {
    return routingDecision({
      mode: "DELEGATE_TO_CODEX",
      target,
      normalized,
      disposition: "NEEDS_CLARIFICATION",
      reasonCodes: ["REQUESTED_TARGET_MISMATCH"],
    });
  }

  const entities = normalizedEntities(normalized);
  const principalType = normalized.intent === "prepare_task_update" ? "TASK" : "PROJECT";
  if (!entities.some((entity) => entity.entity_type === principalType && entity.resolution === "RESOLVED")) {
    return routingDecision({
      mode: "DELEGATE_TO_CODEX",
      target,
      normalized,
      disposition: "NEEDS_CLARIFICATION",
      reasonCodes: ["PRINCIPAL_ENTITY_UNRESOLVED"],
    });
  }

  let selectedOperation = null;
  let profileRef = null;
  let policy = null;
  if (normalized.requested_effect === "INTERNAL_CAPTURE") {
    try {
      const dataPolicy = kernel.policies(identity.workspace_id).data;
      const capture = authorizeCapture({
        policy: dataPolicy,
        normalized,
        identity,
        text: requestText,
        occurredAt: request.timestamp,
      });
      policy = { decision: "ALLOW_CAPTURE", policy_id: capture.policy_id, policy_version: capture.policy_version };
      profileRef = "internal.capture/project_status";
    } catch (error) {
      return routingDecision({
        mode: "ACCESS_DENIED",
        target,
        normalized,
        disposition: "ACCESS_DENIED",
        reasonCodes: [error.code || "CAPTURE_POLICY_DENIED"],
      });
    }
  } else {
    const candidates = operations.filter((operation) => operation.intents.includes(normalized.intent));
    if (!candidates.length) {
      return routingDecision({
        mode: "UNSUPPORTED",
        target,
        normalized,
        disposition: "UNSUPPORTED_REQUEST",
        reasonCodes: ["NO_ELIGIBLE_OPERATION"],
      });
    }
    if (candidates.length > 1) {
      return routingDecision({
        mode: "NEEDS_CLARIFICATION",
        target,
        normalized,
        disposition: "NEEDS_CLARIFICATION",
        reasonCodes: ["MULTIPLE_ELIGIBLE_OPERATIONS"],
      });
    }
    selectedOperation = candidates[0];
    const routeInput = {
      workspace_id: identity.workspace_id,
      project_ref: normalized.entities.project_ref,
      task_ref: normalized.entities.task_ref,
    };
    try {
      kernel.routeCapability({
        ...scope,
        intent: normalized.intent,
        capabilityId: selectedOperation.capability_id,
        capabilityVersion: selectedOperation.capability_version,
        operationId: selectedOperation.operation_id,
        input: routeInput,
      });
    } catch (error) {
      const clarification = error.code === "NEEDS_CLARIFICATION" || error.code === "MISSING_INPUT";
      return routingDecision({
        mode: clarification ? "NEEDS_CLARIFICATION" : "UNSUPPORTED",
        target,
        normalized,
        selectedOperation: null,
        disposition: clarification ? "NEEDS_CLARIFICATION" : "UNSUPPORTED_REQUEST",
        reasonCodes: [error.code || "REGISTRY_ELIGIBILITY_REJECTED"],
      });
    }
    const actionPolicy = kernel.policies(identity.workspace_id).action;
    policy = {
      decision: policyDecisionForEffect(selectedOperation.effect_class),
      policy_id: actionPolicy.policy_id,
      policy_version: actionPolicy.version,
    };
    profileRef = selectedOperation;
  }

  const entityRefs = entities.map((entity) => entity.entity_ref).filter(Boolean);
  const requirements = requirementsForOperation(profileRef, identity.workspace_id, entityRefs);
  const acquisition = runtimeAcquisition({ kernel, request, requirements, contextPacket: packet });
  const sufficiency = assessContextSufficiency({ requestId: request.request_id, target, requirements, acquisition });
  const relevantIds = new Set(requirements.filter((requirement) => requirement.critical_for.includes(target)).map((requirement) => requirement.requirement_id));
  const materialAmbiguity = acquisition.results.some((result) => relevantIds.has(result.requirement_id) && ["AMBIGUOUS", "CONFLICTING"].includes(result.status));

  if (materialAmbiguity) {
    return routingDecision({
      mode: "NEEDS_CLARIFICATION",
      target,
      normalized,
      selectedOperation,
      policy,
      disposition: "NEEDS_CLARIFICATION",
      reasonCodes: ["MATERIAL_CONTEXT_AMBIGUITY"],
      acquisition,
      sufficiency,
    });
  }
  if (sufficiency.decision === "ACCESS_DENIED") {
    return routingDecision({
      mode: "ACCESS_DENIED",
      target,
      normalized,
      selectedOperation: null,
      policy,
      disposition: "ACCESS_DENIED",
      reasonCodes: sufficiency.rationale_codes,
      acquisition,
      sufficiency,
    });
  }
  if (sufficiency.decision !== "SUFFICIENT") {
    return routingDecision({
      mode: sufficiency.decision === "UNSUPPORTED" ? "UNSUPPORTED" : "DELEGATE_TO_CODEX",
      target,
      normalized,
      selectedOperation,
      policy,
      disposition: dispositionAfterAssessment("READY_FOR_ROUTING", sufficiency),
      reasonCodes: sufficiency.rationale_codes,
      acquisition,
      sufficiency,
    });
  }

  const evidenceRefs = [...new Set(acquisition.results.flatMap((result) => result.evidence_refs))];
  const interpretation = validateContextualContract("interpretation", {
    schema: "ContextInterpretation@v1",
    request,
    interpretation: {
      candidate_intent: normalized.intent,
      explicit_user_goal: requestText,
      referenced_entities: entities,
      requested_effect: normalized.requested_effect,
      candidate_operation: selectedOperation ? {
        capability_id: selectedOperation.capability_id,
        capability_version: selectedOperation.capability_version,
        operation_id: selectedOperation.operation_id,
      } : null,
      unresolved_references: [],
      missing_information: normalized.missing_fields,
      ambiguities: [],
      evidence_refs: evidenceRefs,
    },
    retrieval_requirements: requirements,
    disposition: "READY_FOR_ROUTING",
    authority_boundary: "INTERPRETATION_NEVER_AUTHORIZES_POLICY_OR_EXECUTION",
    provenance: { interpreter: "DETERMINISTIC", interpreter_version: "p1-normalizer-fast-path-r2", model_calls: 0 },
  });
  return routingDecision({
    mode: "FAST_PATH",
    target,
    normalized,
    selectedOperation,
    policy,
    disposition: "READY_FOR_ROUTING",
    reasonCodes: ["DETERMINISTIC_CONDITIONS_SATISFIED"],
    interpretation,
    acquisition,
    sufficiency,
  });
}

export class CodexNativeRuntime {
  constructor(kernel, { clock = () => new Date() } = {}) {
    this.kernel = kernel;
    this.clock = clock;
  }

  context(options = {}) {
    const timestamp = options.timestamp || this.clock().toISOString();
    const target = options.target || "ANSWER";
    invariant(targets.has(target), "RUNTIME_TARGET_INVALID", "Unknown contextual target", { target });
    const requestedScope = { principalId: options.principalId, workspaceId: options.workspaceId };
    let identity;
    try {
      identity = this.kernel.identity(requestedScope.principalId, requestedScope.workspaceId);
    } catch (error) {
      if (error.code !== "PERMISSION_DENIED") throw error;
      const request = runtimeRequest(options, { actor_id: "DENIED", workspace_id: "DENIED" }, timestamp);
      const authority = {
        decision: "ACCESS_DENIED",
        actor_authenticated: false,
        workspace_allowed: false,
        authorized_source_count: 0,
        limited_source_count: 0,
      };
      return {
        runtime: "CODEX_NATIVE",
        adapter_version: "1.1.0",
        identity: { actor_id: null, workspace_id: null },
        authority,
        routing: routingDecision({
          mode: "ACCESS_DENIED",
          target,
          disposition: "ACCESS_DENIED",
          reasonCodes: ["AUTHENTICATED_SCOPE_DENIED"],
        }),
        capability_snapshot: [],
        model_request: createModelContextRequest({ request, authorizedContext: [], eligibleOperations: [], allowedEffectClasses: [] }),
        evaluation_context: null,
        authority_boundary: "MODEL_PROPOSES_KERNEL_AUTHORIZES_AND_EXECUTES",
        persistence: { raw_request_stored: false, model_response_stored: false },
      };
    }
    const scope = { principalId: requestedScope.principalId, workspaceId: identity.workspace_id };
    const request = runtimeRequest(options, identity, timestamp);
    const packet = evaluationPacket({ ...options, target }, identity, request);
    const packetView = authorizedPacketView(packet, identity);
    const authority = authorityDecision(packet, identity, packetView);
    const denied = authority.decision === "ACCESS_DENIED";
    const capabilities = denied ? [] : this.kernel.capabilities(scope);
    const operations = denied ? [] : eligibleOperations(this.kernel, scope, capabilities, target, packet);
    const authorizedContext = denied ? [] : [{
      context_ref: request.raw_request_ref,
      source_id: "codex.runtime.request",
      authority_ref: identity.actor_id,
      observed_at: request.timestamp,
      freshness: "FRESH",
      evidence_refs: ["REQUEST_TEXT"],
    }];
    if (!denied && packetView) {
      authorizedContext.push(...packetView.sources.map((source) => ({
        context_ref: source.context_ref,
        source_id: source.source_id,
        source_type: source.source_type,
        authority_ref: source.authority_ref,
        read_permission: source.read_permission,
        status: source.status,
        observed_at: source.observed_at,
        valid_until: source.valid_until,
        freshness: source.freshness,
        fields: [...source.fields],
        evidence_refs: [...source.evidence_refs],
      })));
    }
    const modelRequest = createModelContextRequest({
      request,
      authorizedContext,
      eligibleOperations: operations,
      allowedEffectClasses: denied ? [] : allowedEffectsForTarget(target),
    });
    const routing = denied
      ? routingDecision({ mode: "ACCESS_DENIED", target, disposition: "ACCESS_DENIED", reasonCodes: ["IDENTITY_OR_WORKSPACE_SCOPE_DENIED"] })
      : deterministicRouting({
        kernel: this.kernel,
        scope,
        identity,
        request,
        requestText: options.requestText,
        target,
        packet,
        packetView,
        operations,
      });
    return {
      runtime: "CODEX_NATIVE",
      adapter_version: "1.1.0",
      identity: { actor_id: identity.actor_id, workspace_id: identity.workspace_id },
      authority,
      routing,
      capability_snapshot: capabilities,
      model_request: modelRequest,
      evaluation_context: packetView ? { ...packetView, packet_hash: sha256(canonicalJson(packet)) } : null,
      authority_boundary: "MODEL_PROPOSES_KERNEL_AUTHORIZES_AND_EXECUTES",
      persistence: { raw_request_stored: false, model_response_stored: false },
    };
  }

  assess({ response, target, ...options }) {
    invariant(targets.has(target), "RUNTIME_TARGET_INVALID", "Unknown contextual target", { target });
    const context = this.context({ ...options, target });
    invariant(context.authority.decision !== "ACCESS_DENIED", "MODEL_AUTHORITY_DENIED", "Model output cannot be assessed after the authority gate denied the request");
    const validated = validateModelContextResponse(response, context.model_request);
    validated.referenced_entities.forEach(validateEntity);
    const requestParts = requestPartsForAssessment(validated, options.requestText);
    const supportedPartOperations = requestParts
      .filter((part) => part.status === "SUPPORTED" && part.candidate_operation)
      .map((part) => part.candidate_operation);
    const supportedOperationRefs = [...new Set(supportedPartOperations.map((operation) => operationRef(operation)))];
    const operationFromPart = !validated.candidate_operation && supportedOperationRefs.length === 1
      ? supportedPartOperations[0]
      : null;
    const candidateOperation = validated.candidate_operation || operationFromPart;

    let operationDescriptor = null;
    let profileRef = null;
    if (candidateOperation) {
      operationDescriptor = context.model_request.eligible_operations.find((operation) => operationRef(operation) === operationRef(candidateOperation));
      invariant(operationDescriptor, "MODEL_OPERATION_NOT_ELIGIBLE", "Model selected an operation outside the current runtime scope");
      if (!operationFromPart) {
        invariant(validated.requested_effect === operationDescriptor.effect_class, "MODEL_EFFECT_MISMATCH", "Requested effect does not match the selected operation", {
          requested_effect: validated.requested_effect,
          operation_effect: operationDescriptor.effect_class,
        });
      }
      invariant(targetAcceptsEffect(target, operationDescriptor.effect_class), "MODEL_TARGET_MISMATCH", "Context target does not match the selected operation effect", { target, effect_class: operationDescriptor.effect_class });
      const { manifest } = this.kernel.capability({
        principalId: options.principalId,
        workspaceId: options.workspaceId,
        capabilityId: operationDescriptor.capability_id,
        capabilityVersion: operationDescriptor.capability_version,
      });
      const operation = manifest.operations.find((candidate) => candidate.operation_id === operationDescriptor.operation_id);
      if (validated.candidate_intent && !operationFromPart) {
        invariant(operation.triggers.intents.includes(validated.candidate_intent), "MODEL_INTENT_OPERATION_MISMATCH", "Candidate intent does not belong to the selected operation");
      }
      profileRef = operationDescriptor;
    } else if (validated.requested_effect === "INTERNAL_CAPTURE") {
      invariant(targetAcceptsEffect(target, "INTERNAL_CAPTURE"), "MODEL_TARGET_MISMATCH", "Context target does not allow internal capture", { target });
      invariant(validated.candidate_intent === "record_project_event", "MODEL_INTENT_OPERATION_MISMATCH", "Internal capture requires the registered capture intent");
      invariant(options.requestText, "CAPTURE_REQUEST_TEXT_REQUIRED", "Internal capture assessment requires the original ephemeral request text");
      const project = validated.referenced_entities.find((entity) => entity.entity_type === "PROJECT" && entity.resolution === "RESOLVED");
      const task = validated.referenced_entities.find((entity) => entity.entity_type === "TASK" && entity.resolution === "RESOLVED");
      const captureNormalized = context.routing.normalization.request || {
        entities: { project_ref: project?.entity_ref || null, task_ref: task?.entity_ref || null },
        claims: [],
      };
      authorizeCapture({
        policy: this.kernel.policies(context.identity.workspace_id).data,
        normalized: captureNormalized,
        identity: context.identity,
        text: options.requestText,
        occurredAt: context.model_request.request.timestamp,
      });
      profileRef = "internal.capture/project_status";
    }

    const entityResolution = resolveSemanticEntities({
      responseEntities: validated.referenced_entities,
      responseEvidence: validated.evidence_refs,
      operation: operationDescriptor,
      eligibleOperations: context.model_request.eligible_operations,
      authorizedEntities: context.evaluation_context?.entities || [],
      authorizedSources: context.evaluation_context?.sources || [],
      authorizedEntitiesProvided: context.evaluation_context !== null,
    });
    const resolvedMentions = new Set(entityResolution.resolved_mentions.map((mention) => mention.toLowerCase()));
    const effectiveResponse = {
      ...validated,
      candidate_operation: candidateOperation ? structuredClone(candidateOperation) : null,
      referenced_entities: entityResolution.entities,
      unresolved_references: validated.unresolved_references.filter((reference) => !resolvedMentions.has(reference.toLowerCase())),
    };
    const entityRefs = effectiveResponse.referenced_entities.map((entity) => entity.entity_ref).filter(Boolean);
    const requirements = profileRef ? requirementsForOperation(profileRef, context.identity.workspace_id, entityRefs) : [];
    const knownRequirementIds = new Set(requirements.map((requirement) => requirement.requirement_id));
    const unknownRequirement = effectiveResponse.retrieval_requirement_ids.find((id) => !knownRequirementIds.has(id));
    invariant(!unknownRequirement, "MODEL_REQUIREMENT_INVALID", "Model requested an unknown context requirement", { requirement_id: unknownRequirement });

    const request = {
      request_id: context.model_request.request.request_id,
      actor_id: context.identity.actor_id,
      workspace_id: context.identity.workspace_id,
      raw_request_ref: context.model_request.request.raw_request_ref,
      input_channel: context.model_request.request.input_channel,
      timestamp: context.model_request.request.timestamp,
    };
    const acquisition = requirements.length
      ? runtimeAcquisition({ kernel: this.kernel, request, requirements, contextPacket: options.contextPacket || null })
      : null;
    const sufficiency = acquisition
      ? assessContextSufficiency({ requestId: request.request_id, target, requirements, acquisition })
      : null;
    const groundedClaims = groundModelClaims(effectiveResponse.claims || [], requirements, acquisition);
    const evidenceGrounding = evidenceGroundingFromAcquisition(acquisition);
    const evidenceRefs = [...new Set([
      ...effectiveResponse.evidence_refs,
      ...groundedClaims.flatMap((claim) => claim.evidence_refs),
      ...evidenceGrounding.map((item) => item.evidence_ref),
    ])];
    const outcome = finalDisposition({
      response: effectiveResponse,
      entities: effectiveResponse.referenced_entities,
      entityIssue: entityResolution.issue,
      requestParts,
      acquisition,
      sufficiency,
      groundedClaims,
    });
    validateEffectiveDisposition(effectiveResponse, outcome);
    const clarification = clarificationForAssessment({
      response: effectiveResponse,
      requestParts,
      entityIssue: entityResolution.issue,
      acquisition,
      authorizedSources: context.evaluation_context?.sources || [],
      authorizedEntities: context.evaluation_context?.entities || [],
      disposition: outcome.disposition,
    });
    const interpretation = validateContextualContract("interpretation", {
      schema: "ContextInterpretation@v1",
      request,
      interpretation: {
        candidate_intent: validated.candidate_intent,
        explicit_user_goal: validated.explicit_user_goal,
        referenced_entities: effectiveResponse.referenced_entities,
        requested_effect: effectiveResponse.requested_effect,
        candidate_operation: effectiveResponse.candidate_operation,
        unresolved_references: effectiveResponse.unresolved_references,
        missing_information: effectiveResponse.missing_information,
        ambiguities: effectiveResponse.ambiguities.map((subject) => ({ kind: "REFERENCE", subject, candidate_refs: [], resolution_required: true })),
        evidence_refs: evidenceRefs,
        request_parts: requestParts,
        clarification,
        grounded_claims: groundedClaims,
        evidence_grounding: evidenceGrounding,
      },
      retrieval_requirements: requirements,
      disposition: outcome.disposition,
      response_mode: outcome.response_mode,
      authority_boundary: "INTERPRETATION_NEVER_AUTHORIZES_POLICY_OR_EXECUTION",
      provenance: { interpreter: "MODEL_CANDIDATE", interpreter_version: "codex-native-runtime-v1", model_calls: 1 },
    });
    return {
      runtime: "CODEX_NATIVE",
      adapter_version: "1.1.0",
      identity: context.identity,
      interpretation,
      acquisition,
      sufficiency,
      execution_attempted: false,
      grant_created: false,
      kernel_writes: 0,
    };
  }
}
