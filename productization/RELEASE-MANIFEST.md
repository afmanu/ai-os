# Release manifest

## Public alpha candidate

- Product: `ai-os-core`
- Version: `0.1.0-alpha.2`
- Git tag: `v0.1.0-alpha.2`
- Status: `PUBLIC_RELEASE_READY`
- Public owner: `afmanu`
- Intended repository: `https://github.com/afmanu/ai-os`
- Repository description: `Persistent, extensible local AI operating system for Codex with explicit permissions and private user instances.`
- Authorized source files: 114
- npm publication: disabled through `private: true`

This candidate is prepared for one final human gate. It has not been pushed, published or released.

## Included product

- persistent SQLite kernel and separate durable synthetic task authority;
- capability contracts, Registry, Policy, Approval, Execution and Result Verifier;
- Situation Model and Codex-native contextual runtime;
- resumable PERSONAL onboarding with preview hash and explicit approval;
- confirmed capture for projects, objectives, decisions, blockers, commitments, events and evidence;
- local Git read-only adapter;
- optional Content OS read adapter;
- local read-only Company Holographic Blueprint 3D with a verified workspace core, deterministic project assemblies, node cards, search, filters, relations and evidence context;
- synthetic Atlas and Meeting Brief regression fixtures;
- validator, public Codex skill, documentation and deterministic product tests;
- basic Windows and Linux GitHub Actions workflow.

The exact positive file boundary is recorded in `productization/ALLOWLIST.md`.

## Excluded content

- development Git history, remotes and author metadata;
- evaluation benchmarks, holdouts, labels, traces, reports and model evaluation binaries;
- internal phase reports and private development notes;
- operational SQLite, onboarding state, backups, local bindings, credentials, logs, caches and temporary data;
- real user data and external source repositories;
- installed `node_modules`.

## Privacy inventory

All 114 authorized source files were scanned for identities, emails, profile paths, Windows user directories, synchronized personal paths, credentials, private keys, bearer tokens, API keys, databases, sessions and private traces.

- Personal identities or email addresses: 0
- Personal absolute paths: 0
- Credentials or secret material: 0
- Operational databases or private state: 0
- Development Git history: 0
- Real project or user records: 0
- Synthetic email fixture: `fictional@example.invalid`

Generic references to OneDrive remain only where the product documents or enforces rejection of synchronized instance paths. They do not contain a personal directory.

## License and provenance

The owner approved Apache-2.0. Root `LICENSE` exactly matches the official Apache License 2.0 text after line-ending normalization:

`sha256:cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

`package.json` and `package-lock.json` declare `Apache-2.0`. `THIRD-PARTY-NOTICES.md` records the locked npm dependencies, the two referenced GitHub Actions and the MIT provenance of the adapted AIS-OS 3D Brain patterns. The original upstream license and notice are preserved under `src/dashboard/vendor/`; no upstream branding or framework is incorporated.

## Dependencies

- `ajv@8.20.0` — MIT
- `fast-deep-equal@3.1.3` — MIT
- `fast-uri@3.1.8` — BSD-3-Clause
- `json-schema-traverse@1.0.0` — MIT
- `require-from-string@2.0.2` — MIT
- `three@0.185.1` — MIT
- `3d-force-graph@1.80.0` — MIT
- `esbuild@0.28.2` — MIT, development dependency
- `actions/checkout@v4` — MIT, referenced only
- `actions/setup-node@v4` — MIT, referenced only

## Verified release checks

- Node.js: `v24.11.1`
- npm: `11.6.2`
- `npm ci --ignore-scripts`: PASS, 42 packages added, 43 audited, zero reported vulnerabilities
- Dashboard bundle build: PASS
- Dashboard source/bundle reproducibility: PASS
- Product suite: 64/64 PASS
- Dedicated generic installation test: 1/1 PASS
- Dedicated dashboard tests: 2/2 PASS
- PERSONAL validator: 18/18 PASS
- Synthetic ONBOARD: `DRAFT → PREVIEWED → CREATED`, zero projects and zero tasks
- Model API key required: no
- New model evaluation calls: 0

The workflow is syntactically included for Windows and Linux, but its hosted runs can only be observed after the repository is pushed.

## Network boundary

Cloning and an uncached npm install require network access. After dependencies are installed, onboarding, persistence, local source reads, recovery, validator and tests work offline. Conversational Codex use relies on the user's compatible ChatGPT subscription and does not require a separate model API key by default.

## Public Git identity

The authenticated GitHub account is `afmanu` with account ID `78539103`. The clean public repository must use repository-local identity only:

`afmanu <78539103+afmanu@users.noreply.github.com>`

Global Git configuration must remain unchanged.

## Remaining human gate

Publication still requires explicit authorization to push the committed candidate and create `v0.1.0-alpha.2`. After publication, the owner must enable and verify GitHub Private Vulnerability Reporting and confirm the hosted Windows/Linux workflow results.
