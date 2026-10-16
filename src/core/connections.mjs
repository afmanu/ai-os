import { invariant } from "./errors.mjs";
import { validateSchema } from "./schema-validator.mjs";
import { canonicalJson, sha256 } from "./utils.mjs";

export const connectionTransitions = new Map([
  ["DRAFT", new Set(["PREVIEWED"])],
  ["PREVIEWED", new Set(["APPROVED"])],
  ["APPROVED", new Set(["ACTIVE", "ERROR"])],
  ["ACTIVE", new Set(["REVOKED", "ERROR"])],
  ["ERROR", new Set(["REVOKED"])],
]);

export function normalizeConnectionConfig(config) {
  const normalized = {
    ...structuredClone(config || {}),
    schema: config?.schema || "ExternalConnectionConfig@v1",
    resources: Array.isArray(config?.resources)
      ? [...config.resources].sort((left, right) => left.resource_ref.localeCompare(right.resource_ref))
      : config?.resources,
    access_mode: config?.access_mode || "READ_ONLY",
    retention: config?.retention || { mode: "MINIMAL_REFERENCES", raw_content: "DENY" },
  };
  validateSchema("connectionConfig", normalized);
  const refs = normalized.resources.map((resource) => resource.resource_ref);
  invariant(new Set(refs).size === refs.length, "CONNECTION_INVALID", "Connection resources must have unique resource_ref values");
  return normalized;
}

export function buildConnectionPreview(connection) {
  const preview = {
    schema: "ExternalConnectionPreview@v1",
    connection_id: connection.connection_id,
    source_id: connection.source_id,
    actor_id: connection.actor_id,
    workspace_id: connection.workspace_id,
    provider_id: connection.config.provider_id,
    provider_version: connection.config.provider_version,
    runtime: connection.config.runtime,
    access_mode: connection.config.access_mode,
    resources: connection.config.resources,
    retention: connection.config.retention,
    policy_id: connection.policy_id,
    policy_version: connection.policy_version,
    credentials_stored_by_ai_os: false,
    raw_content_stored_by_ai_os: false,
  };
  return { ...preview, preview_hash: sha256(canonicalJson(preview)) };
}

export function assertConnectionReadScope(connection, resourceRef) {
  invariant(connection.state === "ACTIVE", "CONNECTION_NOT_ACTIVE", "External connection is not active", { connection_id: connection.connection_id, state: connection.state });
  invariant(connection.config.access_mode === "READ_ONLY", "PERMISSION_DENIED", "External connection is not read-only");
  const resource = connection.config.resources.find((candidate) => candidate.resource_ref === resourceRef);
  invariant(resource?.permission === "READ", "RESOURCE_NOT_AUTHORIZED", "Resource is outside the approved connection scope", { connection_id: connection.connection_id, resource_ref: resourceRef });
  return resource;
}

export function validateConnectionEvidence(connection, evidence) {
  const value = validateSchema("connectionReadEvidence", structuredClone(evidence));
  invariant(value.connection_id === connection.connection_id, "CONNECTION_EVIDENCE_INVALID", "Evidence is bound to another connection");
  invariant(value.provider_id === connection.config.provider_id && value.provider_version === connection.config.provider_version, "CONNECTION_EVIDENCE_INVALID", "Evidence provider does not match the approved connection");
  const resource = assertConnectionReadScope(connection, value.resource_ref);
  return { value, resource };
}
