import { readFileSync } from "node:fs";
import { invariant } from "../../core/errors.mjs";
import { canonicalJson, sha256 } from "../../core/utils.mjs";
import { LOCAL_REPO_CAPABILITY_REF, LocalRepoReadAdapter, validateLocalRepoBinding } from "./adapter.mjs";
import { readLocalRepositoryDocument, readLocalRepositoryGit } from "./handler.mjs";
import { verifyLocalRepositoryDocument, verifyLocalRepositoryGit } from "./verifier.mjs";

function json(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}

export const localRepoReadModule = {
  manifest: json("./manifest.json"),
  configuration_schema: json("./binding.schema.json"),
  schemas: {
    "LocalRepositoryDocumentInput@v1": json("./document-input.schema.json"),
    "LocalRepositoryGitInput@v1": json("./git-input.schema.json"),
    "LocalRepositoryReadResult@v1": json("./result.schema.json"),
  },
  default_enabled: false,
  configure({ store, identity, config, capabilityRef }) {
    const validated = validateLocalRepoBinding(config);
    store.registerSource({
      workspaceId: identity.workspace_id,
      sourceId: validated.source_id,
      kind: "local_repository_collection",
      authorityScope: ["explicit_repository_bindings"],
      classification: "private",
    });
    for (const repository of validated.repositories) {
      store.registerSource({
        workspaceId: identity.workspace_id,
        sourceId: repository.source_id,
        kind: "local_git_repository",
        authorityScope: ["allowlisted_documents", "git_status", "git_history"],
        classification: "private",
      });
    }
    const binding = store.saveSourceBinding({
      workspaceId: identity.workspace_id,
      capabilityRef,
      sourceId: validated.source_id,
      adapterKind: "local_git_read_only_v1",
      config: validated,
    });
    return {
      workspace_id: identity.workspace_id,
      capability_ref: capabilityRef,
      source_id: binding.source_id,
      repositories: validated.repositories.map((repository) => ({
        repository_id: repository.repository_id,
        source_id: repository.source_id,
        documents: [...repository.documents],
      })),
      read_only: true,
      discovery: "DISABLED",
    };
  },
  resolve({ input, identity, operation, store }) {
    invariant(input.workspace_id === identity.workspace_id, "ACCESS_DENIED", "Local repository request cannot cross workspace boundaries");
    const binding = store.getSourceBinding(identity.workspace_id, LOCAL_REPO_CAPABILITY_REF);
    invariant(binding, "NOT_CONFIGURED", "No local Git repository is explicitly linked to this workspace");
    invariant(binding.config_hash === sha256(canonicalJson(binding.config)), "SOURCE_BINDING_INVALID", "Stored source binding failed integrity validation");
    return new LocalRepoReadAdapter(binding.config).resolve(operation.operation_id, input);
  },
  handlers: {
    "local-repo:document.read": readLocalRepositoryDocument,
    "local-repo:decisions.read": readLocalRepositoryDocument,
    "local-repo:git.read": readLocalRepositoryGit,
  },
  verifiers: {
    "local-repo:document.verify": verifyLocalRepositoryDocument,
    "local-repo:decisions.verify": verifyLocalRepositoryDocument,
    "local-repo:git.verify": verifyLocalRepositoryGit,
  },
  validateDependency({ store, workspaceId }) {
    const binding = store?.getSourceBinding(workspaceId, LOCAL_REPO_CAPABILITY_REF);
    if (!binding) return { ok: false, error: "NOT_CONFIGURED" };
    try {
      const validated = validateLocalRepoBinding(binding.config);
      return { ok: true, repository_count: validated.repositories.length };
    } catch (error) {
      return { ok: false, error: error.code || "SOURCE_UNAVAILABLE" };
    }
  },
};
