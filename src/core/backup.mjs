import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { AiOsError, invariant } from "./errors.mjs";
import { canonicalJson, iso, sha256, systemClock } from "./utils.mjs";
import { instancePaths, projectDirectory } from "../instance/paths.mjs";

function fileHash(path) {
  return sha256(readFileSync(path));
}

function assertBackupLocation(path) {
  const resolved = resolve(path);
  const project = projectDirectory();
  invariant(!resolved.startsWith(`${project}\\`) && resolved !== project, "UNSAFE_BACKUP_PATH", "Backup cannot live inside the source repository");
  return resolved;
}

function integrity(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  } finally {
    db.close();
  }
}

function counts(path, tables) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  } finally {
    db.close();
  }
}

export async function backupInstance(instanceRoot, backupRoot, { clock = systemClock } = {}) {
  const source = instancePaths(instanceRoot);
  invariant(existsSync(source.kernelDb) && existsSync(source.taskDb), "INSTANCE_NOT_FOUND", "Both durable stores are required for backup");
  const destination = assertBackupLocation(backupRoot);
  mkdirSync(destination, { recursive: true });
  invariant(readdirSync(destination).length === 0, "BACKUP_DESTINATION_NOT_EMPTY", "Backup destination must be empty");
  const kernelBackup = join(destination, "kernel.sqlite");
  const taskBackup = join(destination, "task-source.sqlite");
  const kernelDb = new DatabaseSync(source.kernelDb, { readOnly: true });
  const taskDb = new DatabaseSync(source.taskDb, { readOnly: true });
  try {
    await backup(kernelDb, kernelBackup);
    await backup(taskDb, taskBackup);
  } finally {
    kernelDb.close();
    taskDb.close();
  }
  const manifest = {
    schema: "AiOsBackupManifest@v1",
    created_at: iso(clock),
    source_instance_root: source.root,
    files: {
      kernel: { name: basename(kernelBackup), sha256: fileHash(kernelBackup), integrity: integrity(kernelBackup), counts: counts(kernelBackup, ["events", "evidence", "plans", "grants", "executions", "results"]) },
      task_source: { name: basename(taskBackup), sha256: fileHash(taskBackup), integrity: integrity(taskBackup), counts: counts(taskBackup, ["tasks", "idempotency_records", "task_history"]) },
    },
    limitations: ["local_point_in_time", "synthetic_data_only", "no_remote_replication", "destination_must_be_empty"],
  };
  writeFileSync(join(destination, "manifest.json"), `${canonicalJson(manifest)}\n`, "utf8");
  return manifest;
}

export function restoreInstance(backupRoot, destinationRoot) {
  const source = assertBackupLocation(backupRoot);
  const manifestPath = join(source, "manifest.json");
  invariant(existsSync(manifestPath), "BACKUP_INVALID", "Backup manifest is missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  invariant(manifest.schema === "AiOsBackupManifest@v1", "BACKUP_INVALID", "Unsupported backup manifest");
  const destination = instancePaths(destinationRoot);
  mkdirSync(destination.root, { recursive: true });
  invariant(!existsSync(destination.kernelDb) && !existsSync(destination.taskDb), "RESTORE_DESTINATION_NOT_EMPTY", "Restore destination already contains operational stores");
  const kernelBackup = join(source, manifest.files.kernel.name);
  const taskBackup = join(source, manifest.files.task_source.name);
  invariant(fileHash(kernelBackup) === manifest.files.kernel.sha256, "BACKUP_HASH_MISMATCH", "Kernel backup hash does not match manifest");
  invariant(fileHash(taskBackup) === manifest.files.task_source.sha256, "BACKUP_HASH_MISMATCH", "Task source backup hash does not match manifest");
  invariant(integrity(kernelBackup).every((value) => value === "ok"), "BACKUP_INTEGRITY_FAILED", "Kernel backup failed integrity check");
  invariant(integrity(taskBackup).every((value) => value === "ok"), "BACKUP_INTEGRITY_FAILED", "Task source backup failed integrity check");
  copyFileSync(kernelBackup, destination.kernelDb);
  copyFileSync(taskBackup, destination.taskDb);
  return {
    restored_to: destination.root,
    kernel_hash: fileHash(destination.kernelDb),
    task_source_hash: fileHash(destination.taskDb),
    integrity: { kernel: integrity(destination.kernelDb), task_source: integrity(destination.taskDb) },
    counts: {
      kernel: counts(destination.kernelDb, ["events", "evidence", "plans", "grants", "executions", "results"]),
      task_source: counts(destination.taskDb, ["tasks", "idempotency_records", "task_history"]),
    },
  };
}
