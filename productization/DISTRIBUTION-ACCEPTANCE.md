# Distribution acceptance

## Result

Status: `PUBLIC_RELEASE_READY`

Candidate: `ai-os-core@0.1.0-alpha.1`

Target: `https://github.com/afmanu/ai-os`

The distribution is ready for the owner's final publication decision. No remote, push, GitHub repository or public release was created during acceptance.

## Clean installation

Environment:

- Windows 11
- Node.js `v24.11.1`
- npm `11.6.2`
- no `OPENAI_API_KEY`
- no external Content OS repository installed or linked
- no dependency on the private development repository

Commands executed from the independent distribution:

```text
npm ci --ignore-scripts
npm test
npm run test:generic
```

Final results:

- Locked packages installed: 5
- npm reported vulnerabilities: 0
- Public product suite: 62/62 PASS
- Dedicated generic install test: 1/1 PASS
- PERSONAL validator: 18/18 PASS
- New model or Codex sessions consumed by tests: 0

The installed `node_modules` directory was removed after validation and is not part of the release candidate.

## Synthetic ONBOARD acceptance

A separate CLI smoke used only the fictional identity `Avery Example` and a temporary private directory:

- `start`: `DRAFT`
- required answers missing after `answer`: 0
- preview project seed count: 0
- `approve`: `CREATED`
- created project seed count: 0
- created task seed count: 0
- validator: PASS, 18/18 checks
- model API key present: false

The dedicated generic test additionally verified:

- preview and explicit hash approval before instance creation;
- a synthetic Git repository selected by the fictional user;
- allow-listed document and decision reads;
- bounded Git status and history reads;
- confirmed project and blocker capture;
- durable result retrieval in another process;
- workspace isolation and denial of non-allow-listed files;
- unchanged source files, HEAD and worktree status after every AI OS operation;
- Content OS, Meeting Brief and all unselected external capabilities disabled by default.

All temporary instances and synthetic repositories were removed after verification.

## Privacy acceptance

PASS for the current candidate:

- no real identity or personal email;
- no development profile path or personal synchronized directory;
- no operational SQLite, onboarding state, backup, local config, credential or private trace;
- no evaluation benchmark, expected label or holdout result;
- no development Git history or remote metadata;
- Atlas retained only as an explicitly synthetic regression fixture.

The email-shaped values are the fictional fixture `fictional@example.invalid` and the public Git commit identity `78539103+afmanu@users.noreply.github.com`.

## License and security acceptance

- Apache-2.0 is owner-approved and applied through the full root `LICENSE` plus package metadata.
- Third-party packages and declared licenses match `package-lock.json` and `THIRD-PARTY-NOTICES.md`.
- `SECURITY.md` documents trusted local code, unsandboxed in-process modules, contractual read-only access, unencrypted local state, approval boundaries and backup limits.
- GitHub Private Vulnerability Reporting is the selected reporting channel but cannot be enabled or verified until the public repository exists.
- No enterprise, autonomous-agent or hard-sandbox security claim is made.

## Network and offline behavior

Network-required steps:

- cloning from the future public host;
- downloading npm packages when not already cached.

Offline after installation:

- ONBOARD and preview/approval;
- capture and records queries;
- local Git and allow-listed document reads;
- kernel persistence, recovery and validator;
- complete public product suite.

Codex conversational use requires the user's compatible ChatGPT subscription and Codex environment, but the product does not require a model API key or create additional model-runtime infrastructure.

## Remaining publication actions

1. Create or select the empty public GitHub repository `afmanu/ai-os`.
2. Add it as `origin` and push `main` plus `v0.1.0-alpha.1` after explicit approval.
3. Verify the hosted Windows and Linux GitHub Actions jobs.
4. Enable GitHub Private Vulnerability Reporting and verify that the private report button is available.

No code, capability, router, agent layer, model runtime or long LLM benchmark is required before publication.
