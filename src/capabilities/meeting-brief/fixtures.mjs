export const MEETING_SOURCE_ID = "SRC-MEETINGS-SYNTHETIC";

export const meetingIntegration = Object.freeze({
  schema: "MeetingRecord@v1",
  meeting_id: "MTG-FICTIONAL-SOFTWARE-01",
  workspace_id: "WS-ATLAS-DEMO",
  title: "Revisión de integración Nebula",
  held_at: "2026-10-09T08:30:00.000Z",
  participants: [
    { participant_id: "PARTICIPANT-FICTIONAL-ALPHA", display_name: "Participant Alpha", evidence_ref: "MEV-SOFTWARE-PARTICIPANTS" },
    { participant_id: "PARTICIPANT-FICTIONAL-BETA", display_name: "Participant Beta", evidence_ref: "MEV-SOFTWARE-PARTICIPANTS" }
  ],
  statements: [
    {
      statement_id: "STM-SOFTWARE-01",
      speaker_ref: "PARTICIPANT-FICTIONAL-ALPHA",
      statement_type: "suggestion",
      text: "Evaluar OAuth delegado para una fase posterior.",
      evidence_ref: "MEV-SOFTWARE-STATEMENT-01"
    }
  ],
  decisions: [
    {
      record_id: "MDEC-SOFTWARE-01",
      text: "Validar la integración únicamente en el entorno sandbox antes de solicitar acceso adicional.",
      evidence_ref: "MEV-SOFTWARE-DECISION-01"
    }
  ],
  commitments: [
    {
      record_id: "MCOM-SOFTWARE-01",
      text: "Preparar una matriz de permisos necesarios para la prueba sandbox.",
      owner_ref: null,
      due_at: null,
      evidence_ref: "MEV-SOFTWARE-COMMITMENT-01"
    }
  ],
  open_questions: [
    {
      record_id: "MQUE-SOFTWARE-01",
      text: "¿Qué scope mínimo exige el endpoint ficticio de sincronización?",
      evidence_ref: "MEV-SOFTWARE-QUESTION-01"
    }
  ],
  conflicts: [],
  provenance_refs: [
    "MEV-SOFTWARE-PARTICIPANTS",
    "MEV-SOFTWARE-STATEMENT-01",
    "MEV-SOFTWARE-DECISION-01",
    "MEV-SOFTWARE-COMMITMENT-01",
    "MEV-SOFTWARE-QUESTION-01"
  ],
  version: 3,
  classification: "synthetic"
});

export const meetingOperations = Object.freeze({
  schema: "MeetingRecord@v1",
  meeting_id: "MTG-FICTIONAL-OPERATIONS-02",
  workspace_id: "WS-ATLAS-DEMO",
  title: "Revisión del proceso de guardia",
  held_at: "2026-10-09T11:00:00.000Z",
  participants: [
    { participant_id: "PARTICIPANT-FICTIONAL-GAMMA", display_name: "Participant Gamma", evidence_ref: "MEV-OPS-PARTICIPANTS" },
    { participant_id: "PARTICIPANT-FICTIONAL-DELTA", display_name: "Participant Delta", evidence_ref: "MEV-OPS-PARTICIPANTS" }
  ],
  statements: [
    {
      statement_id: "STM-OPS-01",
      speaker_ref: "PARTICIPANT-FICTIONAL-DELTA",
      statement_type: "observation",
      text: "La revisión manual actual deja una ventana sin cobertura documentada.",
      evidence_ref: "MEV-OPS-STATEMENT-01"
    }
  ],
  decisions: [
    {
      record_id: "MDEC-OPS-01",
      text: "Mantener una doble revisión manual hasta completar el ensayo del relevo.",
      evidence_ref: "MEV-OPS-DECISION-01"
    }
  ],
  commitments: [
    {
      record_id: "MCOM-OPS-01",
      text: "Documentar el ensayo del relevo con tres escenarios ficticios.",
      owner_ref: "ROLE-FICTIONAL-OPS-LEAD",
      due_at: "2026-10-16T16:00:00.000Z",
      evidence_ref: "MEV-OPS-COMMITMENT-01"
    }
  ],
  open_questions: [
    {
      record_id: "MQUE-OPS-01",
      text: "¿Qué señal confirmará que el relevo puede abandonar la doble revisión?",
      evidence_ref: "MEV-OPS-QUESTION-01"
    }
  ],
  conflicts: [
    {
      record_id: "MCNF-OPS-01",
      text: "Dos registros sintéticos difieren sobre la hora de inicio de la guardia; no se ha resuelto cuál es correcto.",
      evidence_ref: "MEV-OPS-CONFLICT-01"
    }
  ],
  provenance_refs: [
    "MEV-OPS-PARTICIPANTS",
    "MEV-OPS-STATEMENT-01",
    "MEV-OPS-DECISION-01",
    "MEV-OPS-COMMITMENT-01",
    "MEV-OPS-QUESTION-01",
    "MEV-OPS-CONFLICT-01"
  ],
  version: 5,
  classification: "synthetic"
});

export const meetingFixtures = Object.freeze([meetingIntegration, meetingOperations]);
