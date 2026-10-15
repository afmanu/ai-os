import { validateSchema } from "./schema-validator.mjs";
import { iso, systemClock } from "./utils.mjs";

export function buildSituation(context, { clock = systemClock } = {}) {
  const eventClaims = context.events.flatMap((event) => event.payload.claims || []);
  const evidenceRefs = context.evidence.map((item) => item.evidence_id);
  const declaredPostponed = eventClaims.some((claim) => claim.predicate === "integration_timing" && claim.value === "postponed");
  const declaredPermissions = eventClaims.some((claim) => claim.predicate === "blocker_category" && claim.value === "permissions");
  const unknowns = eventClaims.filter((claim) => claim.epistemic_status === "unknown").map((claim) => claim.predicate);
  const discrepancy = declaredPostponed && context.task.status === "in_progress" && !context.task.blocker
    ? [{
        field: "task.status/blocker",
        human_declaration: "postponed_by_permissions",
        task_source: "in_progress/no_blocker",
        classification: "not_a_proven_factual_contradiction",
        evidence_refs: evidenceRefs,
      }]
    : [];
  const situation = {
    schema: "SituationModel@v1",
    workspace_id: context.task.workspace_id,
    as_of: iso(clock),
    project: {
      project_id: context.project.project_id,
      name: context.project.name,
      status: context.project.status,
      version: context.project.version,
    },
    objective: context.project.objective,
    active_matters: [{ task_ref: context.task.task_id, status: context.task.status, source_version: context.task.version }],
    blockers: declaredPermissions
      ? [{ category: "permissions", epistemic_status: "declared", evidence_refs: evidenceRefs }]
      : context.task.blocker
        ? [{ category: "task_source", value: context.task.blocker, epistemic_status: "observed", evidence_refs: [] }]
        : [],
    commitments: [],
    unknowns,
    source_discrepancies: discrepancy,
    factual_contradictions: [],
    evidence_refs: evidenceRefs,
    possible_next_actions: [{
      action: "identify_required_permission_and_owner",
      recommendation: "Identificar el permiso exacto y su owner",
      effect_class: "PREPARE",
      requires_approval_for_mutation: true,
    }],
    claims: [
      ...eventClaims.map((claim) => ({ ...claim, freshness: "event_based", evidence_refs: evidenceRefs, authority_ref: context.evidence[0]?.authority_ref || null })),
      {
        subject: context.task.task_id,
        predicate: "task_status",
        value: context.task.status,
        epistemic_status: "observed",
        freshness: "fresh",
        evidence_refs: [`${context.task.task_id}@v${context.task.version}`],
        authority_ref: "SRC-ATLAS-TASKS",
      },
    ],
  };
  return validateSchema("situation", situation);
}
