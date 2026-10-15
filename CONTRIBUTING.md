# Contributing to AI OS

AI OS is an early local-first project. Contributions should preserve its authority boundaries, generic distribution and synthetic-only test corpus.

## Development setup

Requirements:

- Node.js 24.11 or later.
- Git available in `PATH`.

```powershell
git clone https://github.com/afmanu/ai-os.git
Set-Location ai-os
npm ci --ignore-scripts
npm test
```

Run the focused generic installation test with:

```powershell
npm run test:generic
```

## Contribution rules

- Keep `PRODUCT CORE` separate from every `USER INSTANCE`.
- Use only fictional identities, repositories and records in tests and documentation.
- Do not commit SQLite, onboarding state, credentials, local bindings, backups, traces or real user data.
- Do not weaken workspace isolation, policy checks, exact-plan approval, durable idempotency or independent verification.
- Do not treat model output as a grant, policy decision or source-scope expansion.
- Keep Content OS optional and Atlas limited to synthetic fixtures.
- Add the smallest test that demonstrates the changed contract.

## Pull requests

Describe the problem, the exact boundary affected and the validation performed. Run `npm test` before submitting. Changes to security, persistence, approval or execution contracts should explain their failure behavior and recovery path.

## Security reports

Do not include vulnerabilities, secrets or personal information in a public issue. Once enabled and verified by the owner, use GitHub Private Vulnerability Reporting from the repository Security advisories page. Until that control is active, the project has no private reporting channel.

Contributions are submitted under the repository's Apache-2.0 license unless explicitly marked otherwise.
