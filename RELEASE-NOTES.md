# AI OS v0.1.0-alpha.1

First public alpha candidate of AI OS, a persistent and extensible local AI operating system designed to work from Codex while keeping operational authority in a deterministic kernel.

## Included

- Persistent SQLite kernel and separate durable synthetic task authority.
- Capability contracts, Registry, Policy, Approval, Execution and Result Verifier.
- Situation Model reconstructed from authorized evidence and confirmed records.
- Resumable PERSONAL onboarding with preview hash and explicit approval.
- Confirmed capture for projects, objectives, decisions, blockers, commitments, events and evidence.
- Local Git read-only adapter with explicit repository and document allow-lists.
- Codex-native contextual runtime with kernel-owned eligibility and policy validation.
- Optional Content OS read integration.
- AI OS Codex skill, validator and deterministic public test suite.
- Atlas and Meeting Brief only as synthetic fixtures.

## Requirements

- Node.js 24.11 or later.
- Git in `PATH` for local repository reads and related tests.
- Network for cloning and the first uncached npm install.
- A compatible ChatGPT subscription and Codex environment for conversational use; no independent model API key is required by default.

## Known limitations

- Local single-user Personal Instance only.
- Trusted in-process modules without a sandbox.
- SQLite state is not encrypted by AI OS.
- Filesystem read-only behavior is contractual, not OS-level isolation.
- Backup/restore does not coordinate every optional capability store.
- No enterprise identity, multi-tenant isolation, scheduler, dashboard, plugin marketplace or autonomous publication.
- Semantic model quality is not a security guarantee.

## Security and privacy

Private instances must stay outside Git and synchronized directories. Raw conversation capture is denied. Operational mutation requires an exact frozen plan, a one-use expiring grant and post-effect verification.

GitHub Private Vulnerability Reporting is the intended disclosure channel after the owner enables and verifies it in the public repository. It is not active in this unpublished candidate.

## License

Apache License 2.0.
