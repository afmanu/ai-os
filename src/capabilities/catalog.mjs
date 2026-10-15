import { CapabilityRegistry } from "../core/registry.mjs";
import { meetingBriefModule } from "./meeting-brief/module.mjs";
import { contentOsReadModule } from "./content-os-read/module.mjs";
import { localRepoReadModule } from "./local-repo-read/module.mjs";

export function createApplicationRegistry({ modules = [meetingBriefModule, contentOsReadModule, localRepoReadModule], availableDependencies = ["kernel-record-store", "task-source", "meeting-source", "content-os-filesystem", "local-git-filesystem"] } = {}) {
  const refs = new Set(modules.map((module) => `${module.manifest.capability_id}@${module.manifest.capability_version}`));
  const rules = {
    ...(refs.has("cap.meeting-brief@0.1.0") ? {
      "cap.meeting-brief@0.1.0/meeting.read": "ALLOW_READ",
      "cap.meeting-brief@0.1.0/meeting.brief.prepare": "ALLOW_PREPARE",
    } : {}),
    ...(refs.has("cap.content-os-read@0.1.0") ? {
      "cap.content-os-read@0.1.0/content.summary.read": "ALLOW_READ",
      "cap.content-os-read@0.1.0/content.item.read": "ALLOW_READ",
      "cap.content-os-read@0.1.0/content.output.read": "ALLOW_READ",
    } : {}),
    ...(refs.has("cap.local-repo-read@0.1.0") ? {
      "cap.local-repo-read@0.1.0/repository.document.read": "ALLOW_READ",
      "cap.local-repo-read@0.1.0/repository.decisions.read": "ALLOW_READ",
      "cap.local-repo-read@0.1.0/repository.git.read": "ALLOW_READ",
    } : {}),
  };
  return new CapabilityRegistry({
    modules,
    availableDependencies,
    policyRules: rules,
  });
}

export const applicationRegistry = createApplicationRegistry();
