import { readFileSync } from "node:fs";
import { validateExternalSchema } from "../core/schema-validator.mjs";

function schema(name) {
  return JSON.parse(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8"));
}

export const contextualSchemas = Object.freeze({
  interpretation: schema("context-interpretation.schema.json"),
  acquisition: schema("context-acquisition.schema.json"),
  sufficiency: schema("context-sufficiency.schema.json"),
  modelRequest: schema("model-context-request.schema.json"),
  modelResponse: schema("model-context-response.schema.json"),
  evaluationPacket: schema("codex-evaluation-context-packet.schema.json"),
  benchmark: schema("context-benchmark.schema.json"),
  report: schema("context-evaluation-report.schema.json"),
});

export function validateContextualContract(name, value) {
  const selected = contextualSchemas[name];
  if (!selected) throw new Error(`Unknown contextual contract ${name}`);
  return validateExternalSchema(selected, value, selected.$id);
}
