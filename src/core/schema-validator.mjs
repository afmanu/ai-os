import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { AiOsError } from "./errors.mjs";

const schemaFiles = {
  capability: "capability-contract.schema.json",
  normalizedRequest: "normalized-request.schema.json",
  situation: "situation-model.schema.json",
  frozenPlan: "frozen-plan.schema.json",
  grant: "grant.schema.json",
  executionResult: "execution-result.schema.json",
  capabilityResult: "capability-result.schema.json",
};

const schemasDirectory = fileURLToPath(new URL("../../schemas/", import.meta.url));
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map();
const externalValidators = new Map();

for (const [name, filename] of Object.entries(schemaFiles)) {
  const schema = JSON.parse(readFileSync(new URL(`../../schemas/${filename}`, import.meta.url), "utf8"));
  validators.set(name, ajv.compile(schema));
}

export function validateSchema(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new AiOsError("SCHEMA_NOT_FOUND", `Unknown schema ${name}`);
  if (!validate(value)) {
    throw new AiOsError("SCHEMA_INVALID", `${name} validation failed`, {
      schema: name,
      errors: validate.errors,
    });
  }
  return value;
}

export function checkSchema(name, value) {
  try {
    validateSchema(name, value);
    return { ok: true, errors: [] };
  } catch (error) {
    if (error instanceof AiOsError && error.code === "SCHEMA_INVALID") {
      return { ok: false, errors: error.details.errors };
    }
    throw error;
  }
}

export function compileExternalSchema(schema, schemaId = schema?.$id) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new AiOsError("SCHEMA_INVALID", "External schema must be a JSON object", { schema_id: schemaId || null });
  }
  const key = JSON.stringify(schema);
  if (externalValidators.has(key)) return externalValidators.get(key);
  try {
    const validate = ajv.compile(schema);
    externalValidators.set(key, validate);
    return validate;
  } catch (error) {
    throw new AiOsError("SCHEMA_INVALID", "External schema could not be compiled", {
      schema_id: schemaId || null,
      cause: error.message,
    });
  }
}

export function validateExternalSchema(schema, value, schemaId = schema?.$id) {
  const validate = compileExternalSchema(schema, schemaId);
  if (!validate(value)) {
    throw new AiOsError("SCHEMA_INVALID", `${schemaId || "external schema"} validation failed`, {
      schema: schemaId || null,
      errors: validate.errors,
    });
  }
  return value;
}

export { schemasDirectory };
