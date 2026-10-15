export function readLocalRepositoryDocument({ resource }) {
  return {
    output: structuredClone(resource.snapshot),
    artifact: null,
    effects: { reads: ["local-repository:document"], writes: [] },
  };
}

export function readLocalRepositoryGit({ resource }) {
  return {
    output: structuredClone(resource.snapshot),
    artifact: null,
    effects: { reads: ["local-repository:git-metadata"], writes: [] },
  };
}
