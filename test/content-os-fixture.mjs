import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

export function syntheticContentOsState() {
  return {
    schema_version: 1,
    updated_at: "2035-04-05T10:00:00.000Z",
    pieces: [
      {
        id: "CONTENT-9901",
        type: "content",
        editorial_question: "¿Cómo documenta un equipo ficticio una transferencia reproducible?",
        working_title: "Transferencia Boreal ficticia",
        format: null,
        origins: [{ type: "commission", ref: "SYNTHETIC-COMMISSION-9901" }],
        stage: "research",
        status: "synthetic_ready_for_review",
        next_action: "Una persona ficticia revisa el ejemplo.",
        blockers: [],
        artifacts: {
          idea: "ideas/CONTENT-9901.md",
          evidence: "research/CONTENT-9901/EVIDENCE.md",
          absent_reference: "research/CONTENT-9901/ABSENT.md"
        },
        state_evidence: [
          { evidence_id: "EVIDENCE-FICTIONAL-9901", locator: "research/CONTENT-9901/EVIDENCE.md", supports: ["editorial_question", "status"] },
          { evidence_id: "EVIDENCE-FICTIONAL-MISSING", locator: "research/CONTENT-9901/ABSENT.md", supports: ["stage"] }
        ],
        approvals: { recording: false, publication: false }
      },
      {
        id: "CONTENT-9902",
        type: "content",
        editorial_question: "¿Qué señales ficticias indican que una revisión quedó incompleta?",
        working_title: "Revisión Cobalto ficticia",
        format: null,
        origins: [{ type: "synthetic", ref: "SYNTHETIC-SIGNAL-9902" }],
        stage: "candidate",
        status: "synthetic_fixture",
        next_action: "Mantener como candidata ficticia.",
        blockers: ["Falta una decisión ficticia."],
        artifacts: { idea: "ideas/CONTENT-9902.md" },
        state_evidence: [],
        approvals: { recording: false, publication: false }
      }
    ],
    outputs: [
      {
        output_id: "OUTPUT-9901",
        content_id: "CONTENT-9901",
        channel: "x",
        origin: "DIRECT",
        source_output_id: null,
        angle: "Una transferencia ficticia en tres pasos",
        format: "short_post",
        promise: "Mostrar el ejemplo sin afirmar resultados reales.",
        status: "published",
        artifact: "outputs/OUTPUT-9901/OUTPUT.md",
        review_status: "not_reviewed"
      },
      {
        output_id: "OUTPUT-9902",
        content_id: "CONTENT-9901",
        channel: "linkedin",
        origin: "REPURPOSED",
        source_output_id: "OUTPUT-9901",
        angle: "La misma transferencia ficticia con más contexto",
        format: "post",
        promise: "Explicar la procedencia del ejemplo ficticio.",
        status: "draft",
        artifact: "outputs/OUTPUT-9902/OUTPUT.md",
        review_status: "not_reviewed"
      }
    ]
  };
}

export function createSyntheticContentOsFixture(parent) {
  const coreRoot = join(parent, "content-os-core");
  const instanceRoot = join(parent, "content-os-instance");
  write(join(coreRoot, "VERSION"), "0.1.0-alpha.1\n");
  write(join(coreRoot, "docs", "PRODUCT-BOUNDARY.md"), "# Synthetic contract surface\n");
  write(join(coreRoot, "scripts", "validate-content-os.mjs"), "// Synthetic marker; never executed.\n");
  write(join(coreRoot, "templates", "instance", "state", "pieces.json"), `${JSON.stringify({ schema_version: 1, updated_at: null, pieces: [], outputs: [] }, null, 2)}\n`);

  const activeChannels = ["x", "linkedin"];
  const answers = {
    identity: { display_name: "Persona Ejemplo", role_expertise: "Sistemas ficticios", content_basis: "Ejemplos sintéticos" },
    purpose: { goal: "Explicar sistemas ficticios", audience: "Equipos ficticios", territories: ["operaciones sintéticas"], language: "es" },
    channels: { active_channels: activeChannels },
    voice: { sources: [], deferred: true, observed_from_samples: [], user_instruction: "Claro y sintético" },
    privacy: { sync_status: "UNKNOWN", private_media_policy: "OUTSIDE_CORE", external_processing: "NOT_AUTHORIZED", external_actions_default: "HUMAN_APPROVAL_REQUIRED", publication_approval: "HUMAN_APPROVAL_REQUIRED" },
    tools: { current_runtime: { name: "synthetic runtime", status: "AVAILABLE" }, audiovisual: { interest: false, status: "NOT_CONFIGURED" }, local_transcription: { status: "UNKNOWN" }, other_tools: [] }
  };
  write(join(instanceRoot, "profile", "PROFILE.md"), "# Perfil completamente ficticio\n");
  write(join(instanceRoot, "profile", "ONBOARDING.json"), `${JSON.stringify({ schema_version: 1, status: "configured", configured_at: "2035-04-05T09:00:00.000Z", updated_at: "2035-04-05T09:00:00.000Z", answers }, null, 2)}\n`);
  write(join(instanceRoot, "profile", "VOICE.md"), "# Voz ficticia\n");
  write(join(instanceRoot, "profile", "VOICE-SOURCES.json"), `${JSON.stringify({ schema_version: 1, sources: [] }, null, 2)}\n`);
  write(join(instanceRoot, "channel", "CONSTITUTION.md"), "# Constitución ficticia\n");
  write(join(instanceRoot, "channel", "ACTIVE-CHANNELS.json"), `${JSON.stringify({ schema_version: 1, status: "CONFIGURED", available_channels: ["youtube", "linkedin", "x"], active_channels: activeChannels }, null, 2)}\n`);
  write(join(instanceRoot, "docs", "STATE.md"), "# Estado sintético\n");
  write(join(instanceRoot, "docs", "DECISIONS.md"), "# Decisiones sintéticas\n");
  write(join(instanceRoot, "docs", "LEARNING-LEDGER.md"), "# Learnings sintéticos\n");
  write(join(instanceRoot, "ideas", "CONTENT-9901.md"), "# Encargo Boreal ficticio\n\nSolo datos sintéticos.\n");
  write(join(instanceRoot, "ideas", "CONTENT-9902.md"), "# Candidata Cobalto ficticia\n");
  write(join(instanceRoot, "research", "CONTENT-9901", "EVIDENCE.md"), "# Evidencia sintética\n\nEl fixture documenta una transferencia inventada; no acredita un resultado real.\n");
  write(join(instanceRoot, "outputs", "OUTPUT-9901", "OUTPUT.md"), "# OUTPUT-9901\n\nCopia directa completamente ficticia.\n");
  write(join(instanceRoot, "outputs", "OUTPUT-9902", "OUTPUT.md"), "# OUTPUT-9902\n\nReutilización completamente ficticia de OUTPUT-9901.\n");
  write(join(instanceRoot, "state", "pieces.json"), `${JSON.stringify(syntheticContentOsState(), null, 2)}\n`);

  return {
    coreRoot,
    instanceRoot,
    statePath: join(instanceRoot, "state", "pieces.json"),
    binding: {
      source_id: "SRC-CONTENT-OS-FICTIONAL-01",
      source_instance_id: "COS-FICTIONAL-01",
      core_root: coreRoot,
      instance_root: instanceRoot,
      core_version: "0.1.0-alpha.1",
      state_schema_version: 1,
      scope: {
        records: ["CONTENT", "OUTPUT"],
        allowed_artifact_roots: ["ideas", "research", "outputs"],
        max_state_bytes: 1048576,
        max_artifact_bytes: 262144
      }
    }
  };
}

function visit(root, directory, rows) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(root, path, rows);
    else if (entry.isFile()) {
      const content = readFileSync(path);
      rows.push({ path: relative(root, path).replaceAll("\\", "/"), size: content.length, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
}

export function sourceInventory(root) {
  const rows = [];
  visit(root, root, rows);
  return rows;
}
