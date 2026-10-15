import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { AiOsError, invariant } from "../../core/errors.mjs";
import { canonicalJson, iso, parseJson, systemClock } from "../../core/utils.mjs";
import { MEETING_SOURCE_ID, meetingFixtures } from "./fixtures.mjs";

export function meetingSourcePath(instanceRoot) {
  return join(instanceRoot, "meeting-source.sqlite");
}

export class MeetingSource {
  constructor(instanceRoot, { clock = systemClock } = {}) {
    this.path = meetingSourcePath(instanceRoot);
    this.clock = clock;
    try {
      this.db = new DatabaseSync(this.path);
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;");
    } catch (error) {
      throw new AiOsError("SOURCE_STORE_CORRUPT", "Meeting source could not be opened", { path: this.path, cause: error.message });
    }
  }

  close() {
    this.db.close();
  }

  initialize(instanceId) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meetings (
        workspace_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        classification TEXT NOT NULL,
        PRIMARY KEY (workspace_id, meeting_id)
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO source_meta(singleton, instance_id, source_id, schema_version, created_at) VALUES(1, ?, ?, 1, ?)")
      .run(instanceId, MEETING_SOURCE_ID, iso(this.clock));
    const meta = this.db.prepare("SELECT * FROM source_meta WHERE singleton=1").get();
    invariant(meta.instance_id === instanceId && meta.source_id === MEETING_SOURCE_ID, "INSTANCE_MISMATCH", "Meeting source belongs to another instance");
  }

  seed(records = meetingFixtures) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO meetings(workspace_id, meeting_id, version, record_json, updated_at, classification)
      VALUES(?, ?, ?, ?, ?, ?)`);
    for (const meeting of records) {
      insert.run(meeting.workspace_id, meeting.meeting_id, meeting.version, canonicalJson(meeting), meeting.held_at, meeting.classification);
    }
  }

  read(workspaceId, meetingId) {
    const row = this.db.prepare("SELECT record_json FROM meetings WHERE workspace_id=? AND meeting_id=?").get(workspaceId, meetingId);
    return row ? parseJson(row.record_json) : null;
  }

  list(workspaceId) {
    return this.db.prepare("SELECT record_json FROM meetings WHERE workspace_id=? ORDER BY meeting_id").all(workspaceId).map((row) => parseJson(row.record_json));
  }

  integrityCheck() {
    return this.db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  }
}

export function meetingEvidenceIndex(meeting) {
  const index = new Map();
  const add = (evidenceRef, recordType, recordId, value) => {
    if (!index.has(evidenceRef)) index.set(evidenceRef, { evidence_ref: evidenceRef, record_type: recordType, record_id: recordId, value });
  };
  for (const participant of meeting.participants) add(participant.evidence_ref, "participants", participant.participant_id, participant);
  for (const statement of meeting.statements) add(statement.evidence_ref, "statement", statement.statement_id, statement);
  for (const decision of meeting.decisions) add(decision.evidence_ref, "decision", decision.record_id, decision);
  for (const commitment of meeting.commitments) add(commitment.evidence_ref, "commitment", commitment.record_id, commitment);
  for (const question of meeting.open_questions) add(question.evidence_ref, "open_question", question.record_id, question);
  for (const conflict of meeting.conflicts) add(conflict.evidence_ref, "conflict", conflict.record_id, conflict);
  return index;
}
