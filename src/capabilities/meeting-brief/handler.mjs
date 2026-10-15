function overviewText(meeting) {
  return `La reunión documenta ${meeting.decisions.length} decisión(es), ${meeting.commitments.length} compromiso(s), ${meeting.open_questions.length} asunto(s) pendiente(s) y ${meeting.conflicts.length} conflicto(s) explícito(s).`;
}

export function renderReadableBrief(brief) {
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

export function buildMeetingBrief(meeting) {
  const decisions = meeting.decisions.map((item) => ({
    ref: item.record_id,
    text: item.text,
    epistemic_status: "SOURCE_FACT",
    evidence_refs: [item.evidence_ref],
  }));
  const commitments = meeting.commitments.map((item) => ({
    ref: item.record_id,
    text: item.text,
    owner_ref: item.owner_ref,
    due_at: item.due_at,
    epistemic_status: "SOURCE_FACT",
    evidence_refs: [item.evidence_ref],
  }));
  const openMatters = meeting.open_questions.map((item) => ({
    ref: item.record_id,
    text: item.text,
    epistemic_status: "UNKNOWN",
    evidence_refs: [item.evidence_ref],
  }));
  const unknowns = meeting.commitments.flatMap((item) => [
    ...(item.owner_ref === null ? [{ ref: item.record_id, field: "owner_ref", reason: "El registro no identifica responsable.", epistemic_status: "UNKNOWN", evidence_refs: [item.evidence_ref] }] : []),
    ...(item.due_at === null ? [{ ref: item.record_id, field: "due_at", reason: "El registro no incluye fecha comprometida.", epistemic_status: "UNKNOWN", evidence_refs: [item.evidence_ref] }] : []),
  ]);
  const conflicts = meeting.conflicts.map((item) => ({
    ref: item.record_id,
    text: item.text,
    epistemic_status: "CONFLICTING",
    evidence_refs: [item.evidence_ref],
  }));
  const brief = {
    schema: "MeetingBrief@v1",
    artifact_id: `ART-${meeting.meeting_id}-v${meeting.version}`,
    meeting_id: meeting.meeting_id,
    workspace_id: meeting.workspace_id,
    source_version: meeting.version,
    title: meeting.title,
    held_at: meeting.held_at,
    overview: {
      ref: `OVERVIEW-${meeting.meeting_id}`,
      text: overviewText(meeting),
      epistemic_status: "INTERPRETATION",
      evidence_refs: [...meeting.provenance_refs],
    },
    decisions,
    commitments,
    open_matters: openMatters,
    unknowns,
    conflicts,
    evidence_refs: [...meeting.provenance_refs],
    readable_markdown: "",
  };
  brief.readable_markdown = renderReadableBrief(brief);
  return brief;
}

export function readMeeting({ input, identity, instanceRoot }) {
  return import("./meeting-source.mjs").then(({ MeetingSource }) => {
    const source = new MeetingSource(instanceRoot);
    try {
      const meeting = source.read(identity.workspace_id, input.meeting_id);
      return {
        output: meeting,
        artifact: null,
        effects: { reads: ["meeting-source"], writes: [] },
      };
    } finally {
      source.close();
    }
  });
}

export function prepareMeetingBrief({ input, identity, instanceRoot }) {
  return import("./meeting-source.mjs").then(({ MeetingSource }) => {
    const source = new MeetingSource(instanceRoot);
    try {
      const meeting = source.read(identity.workspace_id, input.meeting_id);
      const output = buildMeetingBrief(meeting);
      return {
        output,
        artifact: { artifact_id: output.artifact_id, content: output },
        effects: { reads: ["meeting-source"], writes: ["kernel-record-store:artifacts"] },
      };
    } finally {
      source.close();
    }
  });
}
