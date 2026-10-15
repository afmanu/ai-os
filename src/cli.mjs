import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AiOsKernel } from "./core/kernel.mjs";
import { asPublicError, AiOsError } from "./core/errors.mjs";
import { backupInstance, restoreInstance } from "./core/backup.mjs";
import { validateInstance } from "./core/validator.mjs";
import { defaultRegistry } from "./core/registry.mjs";
import { defaultInstanceRoot } from "./instance/paths.mjs";
import { ATLAS, atlasStatement } from "./fixtures/atlas.mjs";
import { CodexNativeRuntime } from "./runtime/codex-native.mjs";
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
  const subcommand = ["capability", "runtime", "onboard", "capture", "records"].includes(command) && rest[0] && !rest[0].startsWith("--") ? rest.shift() : null;
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
      "onboard status --state <private-path>",
      "capture --instance <path> [--text <spanish statement>]",
      "capture confirmed --instance <path> --record <json>",
      "records list --instance <path> [--project-ref <id>] [--types PROJECT,DECISION]",
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
      "runtime context --instance <path> --request-id <id> --request-ref <ref> [--request-text <text>] [--target ANSWER] [--channel codex] [--context-packet <synthetic-json>]",
      "runtime assess --instance <path> --request-id <id> --request-ref <ref> --target <target> --response <json> [--request-text <text>] [--context-packet <synthetic-json>]",
      "runtime decisions --instance <path> [--subject-ref <ref>]",
    ],
    default_instance: defaultInstanceRoot(),
  };
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
    const { command, subcommand, options } = parseArgs(argv);
    if (!command || command === "help") {
      print(usage());
      return;
    }
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
        print(approvePersonalOnboarding({
          statePath: options.state,
          previewHash: options.preview_hash,
          approved: options.approve === true,
          registry,
        }));
      } else if (subcommand === "status") {
        print(personalOnboardingStatus({ statePath: options.state, registry }));
      } else throw new AiOsError("CLI_USAGE", "Unknown onboard command", { subcommand });
      return;
    }
    const instance = options.instance || defaultInstanceRoot();
    if (command === "registry") {
      print(registry.list());
      return;
    }
    if (command === "backup") {
      if (!options.backup) throw new AiOsError("CLI_USAGE", "backup requires --backup <empty-path>");
      print(await backupInstance(instance, options.backup));
      return;
    }
    if (command === "restore") {
      if (!options.backup) throw new AiOsError("CLI_USAGE", "restore requires --backup <path>");
      print(restoreInstance(options.backup, instance));
      return;
    }
    if (command === "init" && (options.mode !== "ATLAS_FIXTURE" || options.confirm_synthetic !== true)) {
      throw new AiOsError("ONBOARDING_REQUIRED", "Generic instances must use onboard start, answer, preview and explicit approve; Atlas requires --mode ATLAS_FIXTURE --confirm-synthetic");
    }

    kernel = new AiOsKernel(instance, { registry });
    if (command === "init") print(kernel.initializeAtlas());
    else if (command === "capture" && subcommand === "confirmed") {
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
