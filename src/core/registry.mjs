import { readFileSync } from "node:fs";
import { AiOsError, invariant } from "./errors.mjs";
import { checkSchema, validateExternalSchema, validateSchema } from "./schema-validator.mjs";

const builtInManifests = JSON.parse(readFileSync(new URL("../contracts/capabilities.json", import.meta.url), "utf8"));

export function capabilityRef(capabilityId, capabilityVersion) {
  return `${capabilityId}@${capabilityVersion}`;
}

function operationRef(manifest, operation) {
  return `${capabilityRef(manifest.capability_id, manifest.capability_version)}/${operation.operation_id}`;
}

function dependencyIds(manifest) {
  return [
    ...manifest.dependencies.runtime,
    ...manifest.dependencies.sources,
    ...manifest.dependencies.capabilities,
  ];
}

function expectedPolicyDecision(effectClass) {
  if (effectClass === "READ") return "ALLOW_READ";
  if (effectClass === "PREPARE") return "ALLOW_PREPARE";
  if (effectClass === "OPERATIONAL_MUTATION") return "REQUIRE_EXPLICIT_APPROVAL";
  if (effectClass === "INTERNAL_CAPTURE") return "ALLOW_CAPTURE";
  return null;
}

function manifestRecord(manifest, module, availableDependencies) {
  const checked = checkSchema("capability", manifest);
  if (!checked.ok) {
    return {
      ref: `${manifest?.capability_id || "invalid"}@${manifest?.capability_version || "invalid"}`,
      manifest: structuredClone(manifest),
      module,
      base_state: "INVALID_CONTRACT",
      errors: checked.errors,
      missing_dependencies: [],
    };
  }
  const missingDependencies = dependencyIds(manifest).filter((dependency) => !availableDependencies.has(dependency));
  return {
    ref: capabilityRef(manifest.capability_id, manifest.capability_version),
    manifest: validateSchema("capability", structuredClone(manifest)),
    module,
    base_state: missingDependencies.length ? "MISSING_DEPENDENCY" : "AVAILABLE",
    errors: [],
    missing_dependencies: missingDependencies,
  };
}

export class CapabilityRegistry {
  constructor({ manifests = builtInManifests, modules = [], availableDependencies = ["kernel-record-store", "task-source"], policyRules = {} } = {}) {
    this.availableDependencies = new Set(availableDependencies);
    this.policyRules = structuredClone(policyRules);
    this.records = [];
    for (const manifest of manifests) this.records.push(manifestRecord(manifest, null, this.availableDependencies));
    for (const module of modules) this.records.push(manifestRecord(module.manifest, module, this.availableDependencies));
    const validRefs = this.records.filter((record) => record.base_state !== "INVALID_CONTRACT").map((record) => record.ref);
    const collision = validRefs.find((ref, index) => validRefs.indexOf(ref) !== index);
    invariant(!collision, "CAPABILITY_COLLISION", "Capability ID and version must be unique", { capability_ref: collision });
    for (const record of this.records.filter((candidate) => candidate.module && candidate.base_state !== "INVALID_CONTRACT")) {
      this.#validateModule(record);
    }
    for (const [key, decision] of Object.entries(this.policyRules)) {
      const split = key.lastIndexOf("/");
      const ref = key.slice(0, split);
      const operationId = key.slice(split + 1);
      const record = this.records.find((candidate) => candidate.ref === ref && candidate.base_state !== "INVALID_CONTRACT");
      const operation = record?.manifest.operations.find((candidate) => candidate.operation_id === operationId);
      invariant(operation && expectedPolicyDecision(operation.effect_class) === decision, "POLICY_CONFIGURATION_INVALID", "Instance policy rule does not match an available operation effect class", { key, decision });
    }
  }

  #validateModule(record) {
    const module = record.module;
    if (typeof module.resolve !== "function") {
      record.base_state = "INVALID_CONTRACT";
      record.errors.push({ message: "Trusted capability module must expose a resource resolver" });
    }
    for (const operation of record.manifest.operations) {
      const handler = module.handlers?.[operation.execution.entrypoint];
      const verifier = module.verifiers?.[operation.verification.entrypoint];
      if (typeof handler !== "function" || typeof verifier !== "function") {
        record.base_state = "INVALID_CONTRACT";
        record.errors.push({ message: `Trusted entrypoint is missing for ${operationRef(record.manifest, operation)}` });
        continue;
      }
      const inputSchema = module.schemas?.[operation.input.schema_id];
      const outputSchema = module.schemas?.[operation.output.schema_id];
      if (!inputSchema || !outputSchema) {
        record.base_state = "INVALID_CONTRACT";
        record.errors.push({ message: `Input or output schema is missing for ${operationRef(record.manifest, operation)}` });
        continue;
      }
      try {
        validateExternalSchema(inputSchema, {}, operation.input.schema_id);
      } catch (error) {
        if (error.code !== "SCHEMA_INVALID" || !error.details?.errors) {
          record.base_state = "INVALID_CONTRACT";
          record.errors.push({ message: error.message });
        }
      }
      try {
        validateExternalSchema(outputSchema, {}, operation.output.schema_id);
      } catch (error) {
        if (error.code !== "SCHEMA_INVALID" || !error.details?.errors) {
          record.base_state = "INVALID_CONTRACT";
          record.errors.push({ message: error.message });
        }
      }
    }
    if (module.configuration_schema) {
      if (typeof module.configure !== "function") {
        record.base_state = "INVALID_CONTRACT";
        record.errors.push({ message: "Capability with a configuration schema must expose configure" });
      }
      try {
        validateExternalSchema(module.configuration_schema, {}, module.configuration_schema.$id || `${record.ref}:configuration`);
      } catch (error) {
        if (error.code !== "SCHEMA_INVALID" || !error.details?.errors) {
          record.base_state = "INVALID_CONTRACT";
          record.errors.push({ message: error.message });
        }
      }
    }
  }

  list() {
    return this.records
      .filter((record) => record.base_state !== "INVALID_CONTRACT")
      .map((record) => structuredClone(record.manifest));
  }

  discovery({ store = null, workspaceId = null } = {}) {
    return this.records.map((record) => {
      const activation = store && workspaceId ? store.getCapabilityActivation(workspaceId, record.ref) : null;
      let state = record.base_state;
      if (state === "AVAILABLE" && activation?.enabled === 0) state = "DISABLED";
      return {
        capability_ref: record.ref,
        capability_id: record.manifest?.capability_id || null,
        capability_version: record.manifest?.capability_version || null,
        state,
        enabled: state === "AVAILABLE",
        operations: record.manifest?.operations?.map((operation) => operation.operation_id) || [],
        missing_dependencies: [...record.missing_dependencies],
        errors: structuredClone(record.errors),
      };
    });
  }

  syncInstance(store, workspaceId) {
    for (const record of this.records) {
      store.registerCapability({
        workspaceId,
        capabilityRef: record.ref,
        capabilityId: record.manifest?.capability_id || "invalid",
        capabilityVersion: record.manifest?.capability_version || "invalid",
        contractState: record.base_state,
        defaultEnabled: record.base_state === "AVAILABLE" && record.module?.default_enabled !== false,
        errors: record.errors,
      });
    }
    return this.discovery({ store, workspaceId });
  }

  initializeInstance({ store, workspaceId, instanceRoot, identity, actionPolicyId, actionPolicyVersion }) {
    this.syncInstance(store, workspaceId);
    for (const record of this.records) {
      if (record.base_state !== "AVAILABLE" || !record.module) continue;
      const activation = store.getCapabilityActivation(workspaceId, record.ref);
      if (!activation?.enabled) continue;
      if (typeof record.module.initialize === "function") {
        record.module.initialize({ store, workspaceId, instanceRoot, identity });
      }
    }
    this.applyPolicyRules(store, workspaceId, actionPolicyId, actionPolicyVersion);
    return this.discovery({ store, workspaceId });
  }

  applyPolicyRules(store, workspaceId, actionPolicyId, actionPolicyVersion) {
    if (!Object.keys(this.policyRules).length) return null;
    return store.mergePolicyRules(workspaceId, actionPolicyId, actionPolicyVersion, this.policyRules);
  }

  get(capabilityId, capabilityVersion) {
    const ref = capabilityRef(capabilityId, capabilityVersion);
    const record = this.records.find((candidate) => candidate.ref === ref);
    if (!record) throw new AiOsError("CAPABILITY_NOT_FOUND", "Capability version is unavailable", { capabilityId, capabilityVersion });
    if (record.base_state === "INVALID_CONTRACT") throw new AiOsError("INVALID_CONTRACT", "Capability contract is invalid", { capability_ref: ref, errors: record.errors });
    if (record.base_state === "MISSING_DEPENDENCY") throw new AiOsError("MISSING_DEPENDENCY", "Capability dependencies are unavailable", { capability_ref: ref, missing: record.missing_dependencies });
    return structuredClone(record.manifest);
  }

  operation(capabilityId, capabilityVersion, operationId) {
    const capability = this.get(capabilityId, capabilityVersion);
    const operation = capability.operations.find((candidate) => candidate.operation_id === operationId);
    if (!operation) throw new AiOsError("OPERATION_NOT_FOUND", "Operation is not declared by this capability", { capabilityId, capabilityVersion, operationId });
    return structuredClone(operation);
  }

  module(capabilityId, capabilityVersion, { store = null, workspaceId = null } = {}) {
    const ref = capabilityRef(capabilityId, capabilityVersion);
    const record = this.records.find((candidate) => candidate.ref === ref);
    this.get(capabilityId, capabilityVersion);
    const activation = store && workspaceId ? store.getCapabilityActivation(workspaceId, ref) : null;
    if (activation?.enabled === 0) throw new AiOsError("CAPABILITY_DISABLED", "Capability is disabled in this workspace", { capability_ref: ref });
    if (!record.module) throw new AiOsError("CAPABILITY_IMPLEMENTATION_MISSING", "Capability is not exposed through the generic invocation interface", { capability_ref: ref });
    return record.module;
  }

  validateInput(capabilityId, capabilityVersion, operationId, input) {
    const operation = this.operation(capabilityId, capabilityVersion, operationId);
    const module = this.module(capabilityId, capabilityVersion);
    return validateExternalSchema(module.schemas[operation.input.schema_id], input, operation.input.schema_id);
  }

  validateOutput(capabilityId, capabilityVersion, operationId, output) {
    const operation = this.operation(capabilityId, capabilityVersion, operationId);
    const module = this.module(capabilityId, capabilityVersion);
    return validateExternalSchema(module.schemas[operation.output.schema_id], output, operation.output.schema_id);
  }

  runtime(capabilityId, capabilityVersion, operationId, scope = {}) {
    const operation = this.operation(capabilityId, capabilityVersion, operationId);
    const module = this.module(capabilityId, capabilityVersion, scope);
    return {
      operation,
      handler: module.handlers[operation.execution.entrypoint],
      verifier: module.verifiers[operation.verification.entrypoint],
      initialize: module.initialize,
      validateDependency: module.validateDependency,
      resolve: module.resolve,
    };
  }

  configure({ capabilityId, capabilityVersion, store, identity, instanceRoot, config }) {
    const ref = capabilityRef(capabilityId, capabilityVersion);
    const record = this.records.find((candidate) => candidate.ref === ref);
    this.get(capabilityId, capabilityVersion);
    invariant(record?.module?.configuration_schema && typeof record.module.configure === "function", "CAPABILITY_NOT_CONFIGURABLE", "Capability does not expose workspace configuration", { capability_ref: ref });
    const validated = validateExternalSchema(record.module.configuration_schema, config, record.module.configuration_schema.$id || `${ref}:configuration`);
    return record.module.configure({ store, identity, instanceRoot, config: validated, capabilityRef: ref });
  }

  validateDependencies({ store = null, workspaceId = null, instanceRoot = null } = {}) {
    return this.records
      .filter((record) => record.base_state === "AVAILABLE" && record.module?.validateDependency)
      .filter((record) => !store || !workspaceId || store.getCapabilityActivation(workspaceId, record.ref)?.enabled)
      .map((record) => ({ capability_ref: record.ref, ...record.module.validateDependency({ store, instanceRoot, workspaceId }) }));
  }

  select(intent) {
    const candidates = this.records
      .filter((record) => record.base_state === "AVAILABLE")
      .flatMap((record) => record.manifest.operations
        .filter((operation) => operation.triggers.intents.includes(intent))
        .map((operation) => ({
          capability_id: record.manifest.capability_id,
          capability_version: record.manifest.capability_version,
          operation_id: operation.operation_id,
        })))
      .sort((a, b) => `${a.capability_id}/${a.operation_id}`.localeCompare(`${b.capability_id}/${b.operation_id}`));
    if (!candidates.length) {
      if (intent === "record_project_event") return null;
      throw new AiOsError("NEEDS_CLARIFICATION", "No deterministic capability route exists for the request", { intent });
    }
    if (candidates.length > 1) throw new AiOsError("NEEDS_CLARIFICATION", "More than one deterministic capability route exists", { intent, candidates });
    return candidates[0];
  }

  route({ intent = null, capabilityId = null, capabilityVersion = null, operationId = null, input = {}, context = {}, policy = null, store = null, workspaceId = null } = {}) {
    if (capabilityId || capabilityVersion || operationId) {
      invariant(capabilityId && capabilityVersion && operationId, "NEEDS_CLARIFICATION", "Explicit invocation requires capability ID, version and operation");
      const manifest = this.get(capabilityId, capabilityVersion);
      const operation = this.operation(capabilityId, capabilityVersion, operationId);
      this.#assertEligible({ manifest, operation, input, context, policy, store, workspaceId });
      return { capability_id: capabilityId, capability_version: capabilityVersion, operation_id: operationId };
    }

    const candidates = [];
    for (const record of this.records) {
      if (record.base_state !== "AVAILABLE") continue;
      for (const operation of record.manifest.operations) {
        if (!operation.triggers.intents.includes(intent)) continue;
        try {
          this.#assertEligible({ manifest: record.manifest, operation, input, context, policy, store, workspaceId });
          candidates.push({ capability_id: record.manifest.capability_id, capability_version: record.manifest.capability_version, operation_id: operation.operation_id });
        } catch (error) {
          if (!["CAPABILITY_DISABLED", "MISSING_INPUT", "SCHEMA_INVALID", "PERMISSION_DENIED"].includes(error.code)) throw error;
        }
      }
    }
    candidates.sort((a, b) => `${a.capability_id}@${a.capability_version}/${a.operation_id}`.localeCompare(`${b.capability_id}@${b.capability_version}/${b.operation_id}`));
    if (!candidates.length) throw new AiOsError("NO_ELIGIBLE_CAPABILITY", "No eligible capability operation matches the request", { intent });
    if (candidates.length > 1) throw new AiOsError("NEEDS_CLARIFICATION", "More than one capability operation is equally eligible", { candidates });
    return candidates[0];
  }

  #assertEligible({ manifest, operation, input, context, policy, store, workspaceId }) {
    const ref = capabilityRef(manifest.capability_id, manifest.capability_version);
    const activation = store && workspaceId ? store.getCapabilityActivation(workspaceId, ref) : null;
    if (activation?.enabled === 0) throw new AiOsError("CAPABILITY_DISABLED", "Capability is disabled in this workspace", { capability_ref: ref });
    const requiredValues = { ...context, ...input };
    const missing = operation.input.required_context.filter((field) => requiredValues[field] === undefined || requiredValues[field] === null || requiredValues[field] === "");
    if (missing.length) {
      const code = operation.input.missing_input_behavior === "NEEDS_CLARIFICATION" ? "NEEDS_CLARIFICATION" : "MISSING_INPUT";
      throw new AiOsError(code, "Capability input is missing required context", { missing });
    }
    const record = this.records.find((candidate) => candidate.ref === ref);
    if (record?.module) this.validateInput(manifest.capability_id, manifest.capability_version, operation.operation_id, input);
    if (policy) {
      const key = `${ref}/${operation.operation_id}`;
      const expected = expectedPolicyDecision(operation.effect_class);
      if (!expected || policy.rules?.[key] !== expected) {
        throw new AiOsError("PERMISSION_DENIED", "Policy does not make this operation eligible", { operation_ref: key, expected });
      }
    }
  }
}

export const defaultRegistry = new CapabilityRegistry();
