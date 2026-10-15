import { ContentOsReadAdapter } from "./adapter.mjs";

function effects(includeArtifacts) {
  return { reads: includeArtifacts ? ["content-os:state", "content-os:artifacts"] : ["content-os:state"], writes: [] };
}

export function readContentOsSummary({ resource, clock }) {
  const adapter = new ContentOsReadAdapter(resource.binding, { clock });
  return {
    output: adapter.readSummary({ expectedSnapshot: resource.snapshot_hash }),
    artifact: null,
    effects: effects(true),
  };
}

export function readContentOsItem({ input, resource, clock }) {
  const includeArtifacts = input.include_artifacts === true;
  const adapter = new ContentOsReadAdapter(resource.binding, { clock });
  return {
    output: adapter.readContent(input.content_id, { includeArtifacts, expectedSnapshot: resource.snapshot_hash }),
    artifact: null,
    effects: effects(includeArtifacts),
  };
}

export function readContentOsOutput({ input, resource, clock }) {
  const includeArtifact = input.include_artifact === true;
  const adapter = new ContentOsReadAdapter(resource.binding, { clock });
  return {
    output: adapter.readOutput(input.output_id, { includeArtifact, expectedSnapshot: resource.snapshot_hash }),
    artifact: null,
    effects: effects(includeArtifact),
  };
}
