import { canonicalJson, sha256 } from "../../core/utils.mjs";
import { MeetingSource, meetingEvidenceIndex } from "./meeting-source.mjs";

function expectedOverview(meeting) {
  return `La reunión documenta ${meeting.decisions.length} decisión(es), ${meeting.commitments.length} compromiso(s), ${meeting.open_questions.length} asunto(s) pendiente(s) y ${meeting.conflicts.length} conflicto(s) explícito(s).`;
}

function expectedReadable(brief) {
  const lines = [
    `# ${brief.title}`,
    "",
    `Fecha: ${brief.held_at}`,
    "",
    brief.overview.text,
    "",
    "## Decisiones documentadas",
    ...(brief.decisions.length ? brief.decisions.map((item) => `- ${item.text} [${item.evidence_refs.join(", ")}]`) : ["- No constan decisiones explícitas."]),
    "",
    "## Compromisos",
    ...(brief.commitments.length
      ? brief.commitments.map((item) => `- ${item.text} — responsable: ${item.owner_ref || "no consta"}; fecha: ${item.due_at || "no consta"} [${item.evidence_refs.join(", ")}]`)
      : ["- No constan compromisos."]),
    "",
    "## Asuntos pendientes",
    ...(brief.open_matters.length ? brief.open_matters.map((item) => `- ${item.text} [${item.evidence_refs.join(", ")}]`) : ["- No constan asuntos pendientes."]),
    "",
    "## Información ausente",
    ...(brief.unknowns.length ? brief.unknowns.map((item) => `- ${item.field} en ${item.ref}: ${item.reason} [${item.evidence_refs.join(", ")}]`) : ["- No se detectaron ausencias en los campos verificados."]),
    "",
    "## Conflictos explícitos",
    ...(brief.conflicts.length ? brief.conflicts.map((item) => `- ${item.text} [${item.evidence_refs.join(", ")}]`) : ["- No constan conflictos explícitos."]),
  ];
  return lines.join("\n");
}

function evidenceRecords(meeting, identity) {
  return [...meetingEvidenceIndex(meeting).values()].map((record) => ({
    evidence_id: record.evidence_ref,
    workspace_id: identity.workspace_id,
    source_id: "SRC-MEETINGS-SYNTHETIC",
    locator: `meeting:${meeting.meeting_id}/${record.record_type}:${record.record_id}`,
    claims: [{ subject: record.record_id, predicate: record.record_type, value: record.value }],
    authority_kind: "external",
    authority_ref: "SRC-MEETINGS-SYNTHETIC",
    observed_at: meeting.held_at,
    evidence_hash: sha256(canonicalJson(record)),
  }));
}

function withMeeting({ input, identity, instanceRoot }, fn) {
  const source = new MeetingSource(instanceRoot);
  try {
    const meeting = source.read(identity.workspace_id, input.meeting_id);
    return fn(meeting);
  } finally {
    source.close();
  }
}

export function verifyMeetingRead(context) {
  return withMeeting(context, (meeting) => {
    const failures = [];
    if (!meeting) failures.push("meeting_not_found");
    if (meeting && canonicalJson(context.output) !== canonicalJson(meeting)) failures.push("source_record_mismatch");
    if (meeting?.version !== context.resource.source_version) failures.push("source_version_mismatch");
    return {
      ok: failures.length === 0,
      failures,
      checks: { source_record_matches: !failures.includes("source_record_mismatch"), source_version_matches: !failures.includes("source_version_mismatch") },
      evidence_refs: meeting?.provenance_refs || [],
      evidence_records: meeting ? evidenceRecords(meeting, context.identity) : [],
    };
  });
}

export function verifyMeetingBrief(context) {
  return withMeeting(context, (meeting) => {
    const { output, artifact, resource } = context;
    const failures = [];
    if (!meeting) failures.push("meeting_not_found");
    if (!meeting) return { ok: false, failures, checks: {}, evidence_refs: [], evidence_records: [] };
    if (output.meeting_id !== meeting.meeting_id) failures.push("meeting_id_mismatch");
    if (output.workspace_id !== meeting.workspace_id || output.workspace_id !== context.identity.workspace_id) failures.push("workspace_mismatch");
    if (output.source_version !== meeting.version || resource.source_version !== meeting.version) failures.push("source_version_mismatch");
    if (output.overview.text !== expectedOverview(meeting) || output.overview.epistemic_status !== "INTERPRETATION") failures.push("overview_mismatch");

    const expectedDecisions = meeting.decisions.map((item) => [item.record_id, item.text, item.evidence_ref]);
    const observedDecisions = output.decisions.map((item) => [item.ref, item.text, item.evidence_refs[0]]);
    if (canonicalJson(expectedDecisions) !== canonicalJson(observedDecisions)) failures.push("unsupported_or_missing_decision");
    const expectedCommitments = meeting.commitments.map((item) => [item.record_id, item.text, item.owner_ref, item.due_at, item.evidence_ref]);
    const observedCommitments = output.commitments.map((item) => [item.ref, item.text, item.owner_ref, item.due_at, item.evidence_refs[0]]);
    if (canonicalJson(expectedCommitments) !== canonicalJson(observedCommitments)) failures.push("commitment_mismatch");
    const expectedQuestions = meeting.open_questions.map((item) => [item.record_id, item.text, item.evidence_ref]);
    const observedQuestions = output.open_matters.map((item) => [item.ref, item.text, item.evidence_refs[0]]);
    if (canonicalJson(expectedQuestions) !== canonicalJson(observedQuestions)) failures.push("open_matters_mismatch");
    const expectedConflicts = meeting.conflicts.map((item) => [item.record_id, item.text, item.evidence_ref]);
    const observedConflicts = output.conflicts.map((item) => [item.ref, item.text, item.evidence_refs[0]]);
    if (canonicalJson(expectedConflicts) !== canonicalJson(observedConflicts)) failures.push("conflicts_mismatch");

    const expectedUnknowns = meeting.commitments.flatMap((item) => [
      ...(item.owner_ref === null ? [[item.record_id, "owner_ref", item.evidence_ref]] : []),
      ...(item.due_at === null ? [[item.record_id, "due_at", item.evidence_ref]] : []),
    ]);
    const observedUnknowns = output.unknowns.map((item) => [item.ref, item.field, item.evidence_refs[0]]);
    if (canonicalJson(expectedUnknowns) !== canonicalJson(observedUnknowns)) failures.push("unknowns_mismatch");

    const evidenceIndex = meetingEvidenceIndex(meeting);
    const referenced = [
      ...output.evidence_refs,
      ...output.overview.evidence_refs,
      ...output.decisions.flatMap((item) => item.evidence_refs),
      ...output.commitments.flatMap((item) => item.evidence_refs),
      ...output.open_matters.flatMap((item) => item.evidence_refs),
      ...output.unknowns.flatMap((item) => item.evidence_refs),
      ...output.conflicts.flatMap((item) => item.evidence_refs),
    ];
    if (referenced.some((ref) => !evidenceIndex.has(ref))) failures.push("evidence_reference_missing");
    if (!artifact || canonicalJson(artifact.content) !== canonicalJson(output) || artifact.artifact_id !== output.artifact_id) failures.push("artifact_integrity_mismatch");
    if (output.readable_markdown !== expectedReadable(output)) failures.push("readable_artifact_mismatch");

    return {
      ok: failures.length === 0,
      failures,
      checks: {
        meeting_id_matches: !failures.includes("meeting_id_mismatch"),
        workspace_matches: !failures.includes("workspace_mismatch"),
        source_version_matches: !failures.includes("source_version_mismatch"),
        evidence_refs_exist: !failures.includes("evidence_reference_missing"),
        claims_supported: !failures.some((failure) => ["unsupported_or_missing_decision", "commitment_mismatch", "open_matters_mismatch", "unknowns_mismatch", "conflicts_mismatch"].includes(failure)),
        artifact_integrity: !failures.some((failure) => failure.includes("artifact") || failure.includes("readable")),
      },
      evidence_refs: [...meeting.provenance_refs],
      evidence_records: evidenceRecords(meeting, context.identity),
    };
  });
}
