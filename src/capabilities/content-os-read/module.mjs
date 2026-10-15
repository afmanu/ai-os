import { readFileSync } from "node:fs";
import { invariant } from "../../core/errors.mjs";
import { canonicalJson, sha256 } from "../../core/utils.mjs";
import { CONTENT_OS_CAPABILITY_REF, ContentOsReadAdapter, validateContentOsBinding } from "./adapter.mjs";
import { readContentOsItem, readContentOsOutput, readContentOsSummary } from "./handler.mjs";
import { verifyContentOsItem, verifyContentOsOutput, verifyContentOsSummary } from "./verifier.mjs";

function json(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}

export const contentOsReadModule = {
  manifest: json("./manifest.json"),
  configuration_schema: json("./binding.schema.json"),
  schemas: {
    "ContentOsSummaryInput@v1": json("./summary-input.schema.json"),
    "ContentOsItemInput@v1": json("./content-input.schema.json"),
    "ContentOsOutputInput@v1": json("./output-input.schema.json"),
    "ContentOsReadResult@v1": json("./result.schema.json"),
  },
  default_enabled: false,
  configure({ store, identity, config, capabilityRef }) {
    const validated = validateContentOsBinding(config);
    store.registerSource({
      workspaceId: identity.workspace_id,
      sourceId: validated.config.source_id,
      kind: "content_os_filesystem",
      authorityScope: ["CONTENT", "OUTPUT", "authorized_artifact_reference", "source_declared_status"],
      classification: "synthetic",
    });
    const binding = store.saveSourceBinding({
      workspaceId: identity.workspace_id,
      capabilityRef,
      sourceId: validated.config.source_id,
      adapterKind: "content_os_read_only_v1",
      config: validated.config,
    });
    return {
      workspace_id: identity.workspace_id,
      capability_ref: capabilityRef,
      source_id: binding.source_id,
      source_instance_id: validated.config.source_instance_id,
      core_version: validated.config.core_version,
      state_schema_version: validated.config.state_schema_version,
      snapshot_hash: validated.snapshot_hash,
      content_count: validated.content_count,
      output_count: validated.output_count,
      read_only: true,
    };
  },
  resolve({ input, identity, operation, store }) {
    invariant(input.workspace_id === identity.workspace_id, "ACCESS_DENIED", "Content OS request cannot cross workspace boundaries");
    const binding = store.getSourceBinding(identity.workspace_id, CONTENT_OS_CAPABILITY_REF);
    invariant(binding, "NOT_CONFIGURED", "No Content OS instance is explicitly linked to this AI OS workspace");
    invariant(binding.config_hash === sha256(canonicalJson(binding.config)), "SOURCE_BINDING_INVALID", "Stored source binding failed integrity validation");
    const adapter = new ContentOsReadAdapter(binding.config);
    return adapter.resolve(operation.operation_id, input);
  },
  handlers: {
    "content-os:summary.read": readContentOsSummary,
    "content-os:item.read": readContentOsItem,
    "content-os:output.read": readContentOsOutput,
  },
  verifiers: {
    "content-os:summary.verify": verifyContentOsSummary,
    "content-os:item.verify": verifyContentOsItem,
    "content-os:output.verify": verifyContentOsOutput,
  },
  validateDependency({ store, workspaceId }) {
    const binding = store?.getSourceBinding(workspaceId, CONTENT_OS_CAPABILITY_REF);
    if (!binding) return { ok: false, error: "NOT_CONFIGURED" };
    try {
      const validated = validateContentOsBinding(binding.config);
      return { ok: true, snapshot_hash: validated.snapshot_hash, content_count: validated.content_count, output_count: validated.output_count };
    } catch (error) {
      return { ok: false, error: error.code || "SOURCE_UNAVAILABLE" };
    }
  },
};
