import { AiOsError, invariant } from "./errors.mjs";

export function retrieveAtlasContext({ store, taskSource, workspaceId, projectName = "Atlas", taskRef = null }) {
  const projects = store.findProjects(workspaceId, projectName);
  if (projects.length !== 1) {
    throw new AiOsError("NEEDS_CLARIFICATION", "Project reference is ambiguous or missing", {
      candidate_count: projects.length,
      candidates: projects.map((project) => project.project_id),
    });
  }
  const project = projects[0];
  let tasks;
  if (taskRef) {
    const task = taskSource.readTask(workspaceId, taskRef);
    tasks = task ? [task] : [];
  } else {
    tasks = taskSource.listTasks(workspaceId, project.project_id, "integración");
  }
  invariant(tasks.length > 0, "TASK_NOT_FOUND", "No integration task exists in this workspace/project");
  if (tasks.length !== 1) {
    throw new AiOsError("NEEDS_CLARIFICATION", "More than one integration task is eligible", {
      candidate_count: tasks.length,
      candidates: tasks.map((task) => task.task_id),
    });
  }
  const events = store.getEvents(workspaceId, project.project_id);
  const evidenceRefs = events.map((event) => event.event_id === "EVT-ATLAS-001" ? "EVD-ATLAS-001" : null).filter(Boolean);
  const evidence = store.getEvidence(workspaceId, evidenceRefs.length ? evidenceRefs : null);
  return { project, task: tasks[0], events, evidence };
}
