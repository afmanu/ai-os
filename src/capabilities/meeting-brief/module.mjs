import { existsSync, readFileSync } from "node:fs";
import { invariant } from "../../core/errors.mjs";
import { MeetingSource, meetingSourcePath } from "./meeting-source.mjs";
import { MEETING_SOURCE_ID } from "./fixtures.mjs";
import { prepareMeetingBrief, readMeeting } from "./handler.mjs";
import { verifyMeetingBrief, verifyMeetingRead } from "./verifier.mjs";

function json(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}

export const meetingBriefModule = {
  manifest: json("./manifest.json"),
  schemas: {
    "MeetingBriefInput@v1": json("./input.schema.json"),
    "MeetingRecord@v1": json("./meeting-record.schema.json"),
    "MeetingBrief@v1": json("./output.schema.json"),
  },
  default_enabled: true,
  initialize({ store, workspaceId, instanceRoot }) {
    const source = new MeetingSource(instanceRoot, { clock: store.clock });
    try {
      source.initialize(store.meta().instance_id);
      source.seed();
    } finally {
      source.close();
    }
    store.registerSource({
      workspaceId,
      sourceId: MEETING_SOURCE_ID,
      kind: "meeting_records",
      authorityScope: ["meeting_record", "explicit_decision", "commitment", "open_question"],
      classification: "synthetic",
    });
  },
  resolve({ input, identity, instanceRoot }) {
    invariant(input.workspace_id === identity.workspace_id, "PERMISSION_DENIED", "Meeting request cannot cross workspace boundaries");
    const source = new MeetingSource(instanceRoot);
    try {
      const meeting = source.read(identity.workspace_id, input.meeting_id);
      invariant(meeting, "MEETING_NOT_FOUND", "Meeting does not exist in this workspace");
      return { source_id: MEETING_SOURCE_ID, resource_ref: meeting.meeting_id, source_version: meeting.version };
    } finally {
      source.close();
    }
  },
  handlers: {
    "meeting:read": readMeeting,
    "meeting:brief.prepare": prepareMeetingBrief,
  },
  verifiers: {
    "meeting:read.verify": verifyMeetingRead,
    "meeting:brief.verify": verifyMeetingBrief,
  },
  validateDependency({ instanceRoot }) {
    if (!instanceRoot || !existsSync(meetingSourcePath(instanceRoot))) return { ok: false, error: "meeting_source_missing" };
    try {
      const source = new MeetingSource(instanceRoot);
      try {
        const integrity = source.integrityCheck();
        return { ok: integrity.every((value) => value === "ok"), integrity };
      } finally {
        source.close();
      }
    } catch (error) {
      return { ok: false, error: error.code || error.message };
    }
  },
};
