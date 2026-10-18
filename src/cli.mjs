import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AiOsKernel } from "./core/kernel.mjs";
import { asPublicError, AiOsError } from "./core/errors.mjs";
import { backupInstance, restoreInstance } from "./core/backup.mjs";
import { validateInstance } from "./core/validator.mjs";
import { defaultRegistry } from "./core/registry.mjs";
import { defaultInstanceRoot } from "./instance/paths.mjs";
import {
  activeInstanceSelectionPath,
  activeInstanceStatus,
  diagnoseInstance,
  resolveActiveInstance,
  selectActiveInstance,
} from "./instance/state.mjs";
import { ATLAS, atlasStatement } from "./fixtures/atlas.mjs";
import { CodexNativeRuntime } from "./runtime/codex-native.mjs";
import { createDashboardServer } from "./dashboard/server.mjs";
import {
  answerPersonalOnboarding,
  approvePersonalOnboarding,
  personalOnboardingStatus,
  previewPersonalOnboarding,
  startPersonalOnboarding,
} from "./onboarding/personal.mjs";

function parseArgs(argv) {
  const [command, ...tail] = argv;
  const rest = [...tail];
  const subcommand = ["capability", "runtime", "onboard", "capture", "records", "connection", "instance"].includes(command) && rest[0] && !rest[0].startsWith("--") ? rest.shift() : null;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new AiOsError("CLI_USAGE", `Unexpected argument ${token}`);
    const name = token.slice(2).replaceAll("-", "_");
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[name] = true;
    else {
      options[name] = next;
      index += 1;
    }
  }
  return { command, subcommand, options };
}

function common(options, kernel) {
  const fallback = kernel.store.defaultIdentity();
  return {
    principalId: options.principal || fallback.principal_id,
    workspaceId: options.workspace || fallback.workspace_id,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify({ ok: true, data: value }, null, 2)}\n`);
}

function usage() {
  return {
    commands: [
      "init --instance <path> --mode ATLAS_FIXTURE --confirm-synthetic",
      "onboard start --state <private-path> --instance <private-instance-path>",
      "onboard answer --state <private-path> --answers <json>",
      "onboard preview --state <private-path>",
      "onboard approve --state <private-path> --preview-hash <sha256:...> --approve",
      "onboard approve --state <private-path> --preview-hash <sha256:...> --approve --select",
      "onboard status --state <private-path>",
      "instance diagnose --instance <path>",
      "instance select --instance <path>",
      "instance current",
      "capture --instance <path> [--text <spanish statement>]",
      "capture confirmed --instance <path> --record <json>",
      "records list --instance <path> [--project-ref <id>] [--types PROJECT,DECISION]",
      "dashboard --instance <path> [--port 4640] [--principal <id>] [--workspace <id>]",
      "status --instance <path>",
      "prepare --instance <path>",
      "plan --instance <path> [--plan-id <id>]",
      "approve --instance <path> --plan-hash <sha256:...>",
      "reject --instance <path>",
      "execute --instance <path> [--simulate-crash-after-effect|--simulate-unknown-after-effect|--tamper]",
      "recover --instance <path> [--execution-id <id>]",
      "result --instance <path> [--result-id <id>]",
      "metrics --instance <path>",
      "validate --instance <path>",
      "backup --instance <path> --backup <empty-path>",
      "restore --backup <path> --instance <empty-instance-path>",
      "registry",
      "capability list --instance <path>",
      "capability inspect --instance <path> --id <cap.id> --version <semver>",
      "capability configure --instance <path> --id <cap.id> --version <semver> --config <json>",
      "capability route --instance <path> --intent <intent> --input <json>",
      "capability enable|disable --instance <path> --id <cap.id> --version <semver>",
      "capability invoke --instance <path> --id <cap.id> --version <semver> --operation <operation.id> --input <json>",
      "capability result --instance <path> --result-id <id>",
      "connection add --instance <path> --config <json> [--connection-id <id>] [--source-id <id>]",
      "connection preview --instance <path> --connection-id <id>",
      "connection approve --instance <path> --connection-id <id> --preview-hash <sha256:...> --approve",
      "connection list --instance <path>",
      "connection authorize-read --instance <path> --connection-id <id> --resource-ref <ref>",
      "connection verify-read --instance <path> --evidence <json>",
      "connection revoke --instance <path> --connection-id <id> --revoke",
      "runtime context --instance <path> --request-id <id> --request-ref <ref> [--request-text <text>] [--target ANSWER] [--channel codex] [--context-packet <synthetic-json>]",
      "runtime assess --instance <path> --request-id <id> --request-ref <ref> --target <target> --response <json> [--request-text <text>] [--context-packet <synthetic-json>]",
      "runtime decisions --instance <path> [--subject-ref <ref>]",
    ],
    default_instance: defaultInstanceRoot(),
    suggested_personal_instance: defaultInstanceRoot(),
    active_instance_selection: activeInstanceSelectionPath(),
    first_use: "Complete onboard start, answer, preview and approve, then run instance select or approve with --select",
  };
}

const OPERATIONAL_COMMANDS = new Set([
  "capture", "records", "dashboard", "status", "prepare", "plan", "approve", "reject", "execute",
  "recover", "result", "metrics", "validate", "capability", "runtime", "connection",
]);

function requireText(options, name, message) {
  if (typeof options[name] !== "string" || !options[name]) throw new AiOsError("CLI_USAGE", message);
}

function validateOperationalInvocation(command, subcommand, options) {
  if (!OPERATIONAL_COMMANDS.has(command)) throw new AiOsError("CLI_USAGE", `Unknown command ${command}`, { command });
  if (command === "capture") {
    if (subcommand !== null && subcommand !== "confirmed") throw new AiOsError("CLI_USAGE", "Unknown capture command", { subcommand });
    if (subcommand === "confirmed") requireText(options, "record", "capture confirmed requires --record <json>");
  }
  if (command === "records" && subcommand !== "list") throw new AiOsError("CLI_USAGE", "Unknown records command", { subcommand });
  if (command === "approve") requireText(options, "plan_hash", "approve requires --plan-hash <exact hash>");
  if (command === "connection") {
    if (!["add", "preview", "approve", "list", "authorize-read", "verify-read", "revoke"].includes(subcommand)) throw new AiOsError("CLI_USAGE", "Unknown connection command", { subcommand });
    if (subcommand === "add") requireText(options, "config", "connection add requires --config <json>");
    if (["preview", "approve", "authorize-read", "revoke"].includes(subcommand)) requireText(options, "connection_id", `connection ${subcommand} requires --connection-id`);
    if (subcommand === "approve") requireText(options, "preview_hash", "connection approve requires --preview-hash");
    if (subcommand === "authorize-read") requireText(options, "resource_ref", "connection authorize-read requires --resource-ref");
    if (subcommand === "verify-read") requireText(options, "evidence", "connection verify-read requires --evidence <json>");
  }
  if (command === "capability") {
    if (!["list", "inspect", "configure", "enable", "disable", "route", "invoke", "result", "evidence"].includes(subcommand)) throw new AiOsError("CLI_USAGE", "Unknown capability command", { subcommand });
    if (["inspect", "configure", "enable", "disable", "invoke"].includes(subcommand)) {
      requireText(options, "id", `capability ${subcommand} requires --id`);
      requireText(options, "version", `capability ${subcommand} requires --version`);
    }
    if (subcommand === "configure") requireText(options, "config", "capability configure requires --config <json>");
    if (subcommand === "route") requireText(options, "intent", "capability route requires --intent");
    if (subcommand === "invoke") requireText(options, "operation", "capability invoke requires --operation");
    if (["result", "evidence"].includes(subcommand)) requireText(options, "result_id", `capability ${subcommand} requires --result-id`);
  }
  if (command === "runtime") {
    if (!["context", "assess", "decisions"].includes(subcommand)) throw new AiOsError("CLI_USAGE", "Unknown runtime command", { subcommand });
    if (["context", "assess"].includes(subcommand)) {
      requireText(options, "request_id", `runtime ${subcommand} requires --request-id`);
      requireText(options, "request_ref", `runtime ${subcommand} requires --request-ref`);
    }
    if (subcommand === "assess") {
      requireText(options, "response", "runtime assess requires --response");
      requireText(options, "target", "runtime assess requires --target");
    }
  }
}

function parseJsonInput(value, label = "--input") {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new AiOsError("CLI_USAGE", `${label} must contain valid JSON`, { cause: error.message });
  }
}

function runtimeRequest(options, kernel) {
  if (!options.request_id || !options.request_ref) throw new AiOsError("CLI_USAGE", "runtime context requires --request-id and --request-ref");
  return {
    ...common(options, kernel),
    requestId: options.request_id,
    rawRequestRef: options.request_ref,
    requestText: options.request_text || null,
    inputChannel: options.channel || "codex",
    timestamp: options.timestamp,
    target: options.target || "ANSWER",
    contextPacket: options.context_packet ? parseContextPacket(options.context_packet) : null,
  };
}

function parseContextPacket(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new AiOsError("CLI_USAGE", "--context-packet must reference valid synthetic JSON", { cause: error.message });
  }
}

export async function runCli(argv, { registry = defaultRegistry } = {}) {
  let kernel;
  try {
    if (!argv.length || argv[0] === "help" || argv.includes("-h") || argv.includes("--help")) {
      print(usage());
      return;
    }
    const { command, subcommand, options } = parseArgs(argv);
    if (command === "onboard") {
      if (!options.state) throw new AiOsError("CLI_USAGE", `onboard ${subcommand || ""} requires --state <private-path>`);
      if (subcommand === "start") {
        if (!options.instance) throw new AiOsError("CLI_USAGE", "onboard start requires --instance <private-instance-path>");
        print(startPersonalOnboarding({ statePath: options.state, instanceRoot: options.instance, registry }));
      } else if (subcommand === "answer") {
        if (!options.answers) throw new AiOsError("CLI_USAGE", "onboard answer requires --answers <json>");
        print(answerPersonalOnboarding({ statePath: options.state, answers: parseJsonInput(options.answers, "--answers"), registry }));
      } else if (subcommand === "preview") {
        print(previewPersonalOnboarding({ statePath: options.state, registry }));
      } else if (subcommand === "approve") {
        if (!options.preview_hash) throw new AiOsError("CLI_USAGE", "onboard approve requires --preview-hash");
        const creation = approvePersonalOnboarding({
          statePath: options.state,
          previewHash: options.preview_hash,
          approved: options.approve === true,
          registry,
        });
        const active = options.select === true ? selectActiveInstance(creation.instance_root) : null;
        print(active ? { ...creation, active_instance: active } : creation);
      } else if (subcommand === "status") {
        print(personalOnboardingStatus({ statePath: options.state, registry }));
      } else throw new AiOsError("CLI_USAGE", "Unknown onboard command", { subcommand });
      return;
    }
    if (command === "registry") {
      print(registry.list());
      return;
    }
    if (command === "instance") {
      if (subcommand === "diagnose") {
        requireText(options, "instance", "instance diagnose requires --instance <path>");
        print(diagnoseInstance(options.instance));
      } else if (subcommand === "select") {
        requireText(options, "instance", "instance select requires --instance <path>");
        print(selectActiveInstance(options.instance));
      } else if (subcommand === "current") {
        print(activeInstanceStatus());
      } else throw new AiOsError("CLI_USAGE", "Unknown instance command", { subcommand });
      return;
    }
    if (command === "backup") {
      requireText(options, "backup", "backup requires --backup <empty-path>");
      const instance = resolveActiveInstance(options.instance || null);
      print(await backupInstance(instance, options.backup));
      return;
    }
    if (command === "restore") {
      requireText(options, "backup", "restore requires --backup <path>");
      requireText(options, "instance", "restore requires --instance <empty-instance-path>");
      print(restoreInstance(options.backup, options.instance));
      return;
    }
    if (command === "init") {
      requireText(options, "instance", "init requires --instance <path>");
      if (options.mode !== "ATLAS_FIXTURE" || options.confirm_synthetic !== true) {
        throw new AiOsError("ONBOARDING_REQUIRED", "Personal instances must use onboard start, answer, preview and explicit approve; Atlas requires --mode ATLAS_FIXTURE --confirm-synthetic");
      }
      kernel = new AiOsKernel(options.instance, { registry });
      print(kernel.initializeAtlas());
      return;
    }

    validateOperationalInvocation(command, subcommand, options);
    const instance = resolveActiveInstance(options.instance || null);
    kernel = new AiOsKernel(instance, { registry });
    if (command === "capture" && subcommand === "confirmed") {
      if (!options.record) throw new AiOsError("CLI_USAGE", "capture confirmed requires --record <json>");
      print(kernel.captureConfirmed({ ...common(options, kernel), record: parseJsonInput(options.record, "--record") }));
    }
    else if (command === "capture") print(await kernel.captureAtlasStatement({ ...common(options, kernel), text: options.text || atlasStatement }));
    else if (command === "records" && subcommand === "list") {
      print(kernel.confirmedRecords({
        ...common(options, kernel),
        projectRef: options.project_ref || null,
        recordTypes: options.types ? options.types.split(",").filter(Boolean) : null,
      }));
    }
    else if (command === "dashboard") {
      const scope = common(options, kernel);
      const dashboard = await createDashboardServer({
        kernel,
        principalId: scope.principalId,
        workspaceId: scope.workspaceId,
        port: options.port === undefined ? 4640 : Number(options.port),
      });
      print({ url: dashboard.url, host: dashboard.host, port: dashboard.port, read_only: true, workspace_id: scope.workspaceId });
      const stop = () => dashboard.close().catch(() => {});
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await dashboard.closed;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    else if (command === "status") print(await kernel.status({ ...common(options, kernel), text: options.text, projectName: options.project || "Atlas" }));
    else if (command === "prepare") print(await kernel.prepareUpdate({ ...common(options, kernel), projectName: options.project || "Atlas", planId: options.plan_id || ATLAS.planId }));
    else if (command === "plan") print(kernel.getPlan({ ...common(options, kernel), planId: options.plan_id || ATLAS.planId }));
    else if (command === "approve") {
      if (!options.plan_hash) throw new AiOsError("CLI_USAGE", "approve requires --plan-hash <exact hash>");
      print(kernel.approve({ ...common(options, kernel), planId: options.plan_id || ATLAS.planId, planHash: options.plan_hash, grantId: options.grant_id || ATLAS.grantId }));
    } else if (command === "reject") print(kernel.reject({ ...common(options, kernel), planId: options.plan_id || ATLAS.planId }));
    else if (command === "execute") {
      print(await kernel.execute({
        ...common(options, kernel),
        grantId: options.grant_id || ATLAS.grantId,
        executionId: options.execution_id || ATLAS.executionId,
        resultId: options.result_id || ATLAS.resultId,
        idempotencyKey: options.idempotency_key,
        tamperUnauthorizedField: Boolean(options.tamper),
        simulateUnknownAfterEffect: Boolean(options.simulate_unknown_after_effect),
        afterSourceEffect: options.simulate_crash_after_effect
          ? async () => {
              process.stderr.write("SIMULATED_CRASH_AFTER_EFFECT\n");
              process.exit(86);
            }
          : null,
      }));
    } else if (command === "recover") print(await kernel.recover({ ...common(options, kernel), executionId: options.execution_id || null }));
    else if (command === "result") print(kernel.outcome({ ...common(options, kernel), resultId: options.result_id || ATLAS.resultId }));
    else if (command === "metrics") print(kernel.metrics(common(options, kernel)));
    else if (command === "validate") print(validateInstance({ store: kernel.store, taskSource: kernel.taskSource, registry: kernel.registry, instanceRoot: kernel.paths.root }));
    else if (command === "connection") {
      const scope = common(options, kernel);
      if (subcommand === "add") {
        if (!options.config) throw new AiOsError("CLI_USAGE", "connection add requires --config <json>");
        print(kernel.addExternalConnection({
          ...scope,
          config: parseJsonInput(options.config, "--config"),
          connectionId: options.connection_id || null,
          sourceId: options.source_id || null,
        }));
      } else if (subcommand === "preview") {
        if (!options.connection_id) throw new AiOsError("CLI_USAGE", "connection preview requires --connection-id");
        print(kernel.previewExternalConnection({ ...scope, connectionId: options.connection_id }));
      } else if (subcommand === "approve") {
        if (!options.connection_id || !options.preview_hash) throw new AiOsError("CLI_USAGE", "connection approve requires --connection-id and --preview-hash");
        print(kernel.approveExternalConnection({ ...scope, connectionId: options.connection_id, previewHash: options.preview_hash, approved: options.approve === true }));
      } else if (subcommand === "list") {
        print(kernel.externalConnections(scope));
      } else if (subcommand === "authorize-read") {
        if (!options.connection_id || !options.resource_ref) throw new AiOsError("CLI_USAGE", "connection authorize-read requires --connection-id and --resource-ref");
        print(kernel.authorizeExternalConnectionRead({ ...scope, connectionId: options.connection_id, resourceRef: options.resource_ref }));
      } else if (subcommand === "verify-read") {
        if (!options.evidence) throw new AiOsError("CLI_USAGE", "connection verify-read requires --evidence <json>");
        print(kernel.verifyExternalConnectionRead({ ...scope, evidence: parseJsonInput(options.evidence, "--evidence") }));
      } else if (subcommand === "revoke") {
        if (!options.connection_id) throw new AiOsError("CLI_USAGE", "connection revoke requires --connection-id");
        print(kernel.revokeExternalConnection({ ...scope, connectionId: options.connection_id, revoked: options.revoke === true }));
      } else throw new AiOsError("CLI_USAGE", "Unknown connection command", { subcommand });
    }
    else if (command === "capability") {
      const scope = common(options, kernel);
      if (subcommand === "list") print(kernel.capabilities(scope));
      else if (subcommand === "inspect") {
        if (!options.id || !options.version) throw new AiOsError("CLI_USAGE", "capability inspect requires --id and --version");
        print(kernel.capability({ ...scope, capabilityId: options.id, capabilityVersion: options.version }));
      } else if (subcommand === "configure") {
        if (!options.id || !options.version || !options.config) throw new AiOsError("CLI_USAGE", "capability configure requires --id, --version and --config");
        print(kernel.configureCapability({
          ...scope,
          capabilityId: options.id,
          capabilityVersion: options.version,
          config: parseJsonInput(options.config),
        }));
      } else if (subcommand === "enable" || subcommand === "disable") {
        if (!options.id || !options.version) throw new AiOsError("CLI_USAGE", `capability ${subcommand} requires --id and --version`);
        print(kernel.setCapabilityEnabled({ ...scope, capabilityId: options.id, capabilityVersion: options.version, enabled: subcommand === "enable" }));
      } else if (subcommand === "route") {
        if (!options.intent) throw new AiOsError("CLI_USAGE", "capability route requires --intent");
        const input = parseJsonInput(options.input);
        input.workspace_id ||= scope.workspaceId;
        print(kernel.routeCapability({ ...scope, intent: options.intent, input }));
      } else if (subcommand === "invoke") {
        if (!options.id || !options.version || !options.operation) throw new AiOsError("CLI_USAGE", "capability invoke requires --id, --version and --operation");
        const input = parseJsonInput(options.input);
        input.workspace_id ||= scope.workspaceId;
        print(await kernel.invokeCapability({
          ...scope,
          capabilityId: options.id,
          capabilityVersion: options.version,
          operationId: options.operation,
          input,
          idempotencyKey: options.idempotency_key,
          executionId: options.execution_id,
          resultId: options.result_id,
        }));
      } else if (subcommand === "result" || subcommand === "evidence") {
        if (!options.result_id) throw new AiOsError("CLI_USAGE", `capability ${subcommand} requires --result-id`);
        print(kernel.capabilityResult({ ...scope, resultId: options.result_id }));
      } else throw new AiOsError("CLI_USAGE", "Unknown capability command", { subcommand });
    } else if (command === "runtime") {
      const runtime = new CodexNativeRuntime(kernel);
      if (subcommand === "context") print(runtime.context(runtimeRequest(options, kernel)));
      else if (subcommand === "assess") {
        if (!options.response || !options.target) throw new AiOsError("CLI_USAGE", "runtime assess requires --response and --target");
        print(runtime.assess({
          ...runtimeRequest(options, kernel),
          target: options.target,
          response: parseJsonInput(options.response),
        }));
      } else if (subcommand === "decisions") {
        print(kernel.decisions({ ...common(options, kernel), subjectRef: options.subject_ref || null }));
      } else throw new AiOsError("CLI_USAGE", "Unknown runtime command", { subcommand });
    }
    else throw new AiOsError("CLI_USAGE", `Unknown command ${command}`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(asPublicError(error), null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    if (kernel) kernel.close();
  }
}
