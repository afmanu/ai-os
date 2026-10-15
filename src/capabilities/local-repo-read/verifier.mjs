import { canonicalJson, sha256 } from "../../core/utils.mjs";
import { LocalRepoReadAdapter } from "./adapter.mjs";

function evidence(output, identity) {
  const id = sha256(`${identity.workspace_id}:${output.source.source_id}:${output.source.locator}:${output.source.snapshot_hash}`).slice(7, 31).toUpperCase();
  return {
    evidence_id: `EVD-LOCAL-${id}`,
    workspace_id: identity.workspace_id,
    source_id: output.source.source_id,
    locator: `local-repository:${output.source.repository_id}/${output.source.locator}`,
    claims: [{
      subject: output.source.locator,
      predicate: "authorized_source_snapshot_observed",
      value: { kind: output.kind, availability: output.availability, snapshot_hash: output.source.snapshot_hash },
    }],
    authority_kind: "external",
    authority_ref: output.source.source_id,
    observed_at: output.observed_at,
    evidence_hash: output.source.snapshot_hash,
  };
}

function verify(context, expected) {
  const failures = [];
  if (context.output.source.source_id !== context.resource.source_id) failures.push("source_id_mismatch");
  if (context.output.source.snapshot_hash !== context.resource.snapshot_hash) failures.push("snapshot_mismatch");
  if (canonicalJson(context.output) !== canonicalJson(expected)) failures.push("read_back_mismatch");
  const record = evidence(context.output, context.identity);
  return {
    ok: failures.length === 0,
    failures,
    checks: {
      workspace_binding_matches: context.output.source.source_id === context.resource.source_id,
      snapshot_matches: !failures.includes("snapshot_mismatch"),
      independent_read_back: !failures.includes("read_back_mismatch"),
      read_only: true,
    },
    evidence_refs: [record.evidence_id],
    evidence_records: [record],
  };
}

export function verifyLocalRepositoryDocument(context) {
  const adapter = new LocalRepoReadAdapter(context.resource.binding, { clock: context.clock });
  const expected = adapter.document(context.input.repository_id, context.input.path, {
    kind: context.output.kind,
    observedAt: context.output.observed_at,
  });
  return verify(context, expected);
}

export function verifyLocalRepositoryGit(context) {
  const adapter = new LocalRepoReadAdapter(context.resource.binding, { clock: context.clock });
  return verify(context, adapter.git(context.input.repository_id, { observedAt: context.output.observed_at }));
}
