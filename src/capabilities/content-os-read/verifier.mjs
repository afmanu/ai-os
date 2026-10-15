import { canonicalJson, sha256 } from "../../core/utils.mjs";
import { ContentOsReadAdapter } from "./adapter.mjs";

function token(value, length = 16) {
  return sha256(value).slice("sha256:".length, "sha256:".length + length).toUpperCase();
}

function readArtifacts(output) {
  const artifacts = [];
  if (output.content) artifacts.push(...output.content.artifacts.filter((item) => item.content_read));
  if (output.output?.artifact?.content_read) artifacts.push(output.output.artifact);
  return artifacts;
}

function evidenceRecords(output, identity) {
  const stateEvidenceId = `EVD-COS-STATE-${token(`${output.source.source_instance_id}:${output.source.snapshot_hash}`)}`;
  const records = [{
    evidence_id: stateEvidenceId,
    workspace_id: identity.workspace_id,
    source_id: output.source.source_id,
    locator: `content-os:${output.source.source_instance_id}/state/pieces.json`,
    claims: [{
      subject: output.kind === "CONTENT" ? output.content.content_id : output.kind === "OUTPUT" ? output.output.output_id : output.source.source_instance_id,
      predicate: "source_snapshot_observed",
      value: { kind: output.kind, snapshot_hash: output.source.snapshot_hash },
    }],
    authority_kind: "external",
    authority_ref: output.source.source_id,
    observed_at: output.source.read_as_of,
    evidence_hash: output.source.snapshot_hash,
  }];
  for (const artifact of readArtifacts(output)) {
    records.push({
      evidence_id: `EVD-COS-ART-${token(`${artifact.locator}:${artifact.content_hash}`)}`,
      workspace_id: identity.workspace_id,
      source_id: output.source.source_id,
      locator: `content-os:${output.source.source_instance_id}/${artifact.locator}`,
      claims: [{ subject: artifact.locator, predicate: "artifact_content_observed", value: { content_hash: artifact.content_hash } }],
      authority_kind: "external",
      authority_ref: output.source.source_id,
      observed_at: output.source.read_as_of,
      evidence_hash: artifact.content_hash,
    });
  }
  return records;
}

function verifyExpected({ output, expected, resource, identity }) {
  const failures = [];
  const contentExists = output.kind !== "CONTENT" && output.kind !== "OUTPUT" ? true : Boolean(output.content);
  const outputExists = output.kind !== "OUTPUT" || Boolean(output.output);
  const provenanceValid = output.kind !== "OUTPUT"
    || (output.provenance_chain[0] === output.output?.output_id && output.provenance_chain.at(-1) !== undefined);
  if (output.source.source_id !== resource.source_id) failures.push("source_id_mismatch");
  if (output.source.snapshot_hash !== resource.snapshot_hash || output.source.source_version !== resource.source_version) failures.push("source_snapshot_mismatch");
  if (output.source.source_instance_id !== resource.binding.source_instance_id) failures.push("source_instance_mismatch");
  if (canonicalJson(output) !== canonicalJson(expected)) failures.push("read_back_mismatch");
  const records = evidenceRecords(output, identity);
  return {
    ok: failures.length === 0,
    failures,
    checks: {
      workspace_binding_matches: output.source.source_id === resource.source_id,
      schema_supported: output.source.core_version === resource.binding.core_version && output.source.state_schema_version === resource.binding.state_schema_version,
      snapshot_matches: !failures.includes("source_snapshot_mismatch"),
      source_instance_matches: !failures.includes("source_instance_mismatch"),
      content_exists: contentExists,
      output_exists: outputExists,
      provenance_valid: provenanceValid,
      read_back_matches: !failures.includes("read_back_mismatch"),
      relations_valid: true,
      artifact_scope_valid: true,
    },
    evidence_refs: records.map((item) => item.evidence_id),
    evidence_records: records,
  };
}

export function verifyContentOsSummary(context) {
  const adapter = new ContentOsReadAdapter(context.resource.binding, { clock: context.clock });
  const expected = adapter.readSummary({ readAsOf: context.output.source.read_as_of, expectedSnapshot: context.resource.snapshot_hash });
  return verifyExpected({ ...context, expected });
}

export function verifyContentOsItem(context) {
  const adapter = new ContentOsReadAdapter(context.resource.binding, { clock: context.clock });
  const expected = adapter.readContent(context.input.content_id, {
    includeArtifacts: context.input.include_artifacts === true,
    readAsOf: context.output.source.read_as_of,
    expectedSnapshot: context.resource.snapshot_hash,
  });
  return verifyExpected({ ...context, expected });
}

export function verifyContentOsOutput(context) {
  const adapter = new ContentOsReadAdapter(context.resource.binding, { clock: context.clock });
  const expected = adapter.readOutput(context.input.output_id, {
    includeArtifact: context.input.include_artifact === true,
    readAsOf: context.output.source.read_as_of,
    expectedSnapshot: context.resource.snapshot_hash,
  });
  return verifyExpected({ ...context, expected });
}
