# AI OS Dashboard

`AI OS Dashboard` is a local, read-only 3D operating map over one authorized AI OS workspace. It is part of the generic product core. It does not create a personal instance, store a second graph, scan the home directory or expose SQLite to the browser.

## Architecture

```text
kernel stores and registered sources
  → identity + workspace resolution
  → existing READ policy checks
  → AuthorizedDashboardReadModel@v1
  → DashboardGraphProjection@v2
  → loopback HTTP server
  → 3D Company Holographic Blueprint browser client
```

`AiOsKernel.dashboardProjection()` is the only data entrypoint. The read model requires `cap.personal-record@0.1.0/records.read`. Task nodes are included only when `cap.task-record@0.1.0/task.read` is authorized. Kernel decision records are included only when `cap.situation@0.1.0/situation.read` is authorized. Missing authority produces an explicit projection limitation rather than an expanded read.

The browser receives safe metadata, confirmed descriptions, IDs, timestamps, evidence references and source identifiers. It does not receive source-binding paths, arbitrary evidence values, raw conversation, secrets or SQLite access.

## Graph contract

`DashboardGraphProjection@v2` contains:

- `workspace_id`, presentation name, generation time and projection lineage;
- truthful counts derived from represented nodes;
- one `WORKSPACE` root derived from the authorized instance profile, plus stable nodes of type `PROJECT`, `GOAL`, `DECISION`, `COMMITMENT`, `TASK`, `BLOCKER`, `EVENT`, `EVIDENCE`, `SOURCE` and `CAPABILITY`, only when matching data exists;
- links backed by persisted project references, task references, evidence claims, confirmed source references or source bindings;
- explicit unknowns and read limitations.

No semantic-similarity links are created. Recommendations are not promoted to decisions. Stable deterministic layout is computed from node IDs and verified connectivity, not random positions.

The `WORKSPACE` node is the real center of the scene. It links to projects, registered sources and capabilities through existing workspace membership. It does not assert that a PERSONAL instance provides organizational identity, roles or company KPIs; those fields remain explicitly unknown until another approved contract supplies them.

## Holographic blueprint visual system

The default `Company Holographic Blueprint` theme uses primary `#FBC92E`, secondary `#FEEAB9`, tertiary `#F88E0B` and a graphite-black field derived from neutral `#131313`. Headline and interface stacks prefer Space Grotesk and Inter respectively, with local system fallbacks so the dashboard remains offline and does not contact a font CDN.

The renderer is an exploded spatial model, not a random neural network. The authorized workspace becomes an engineered geometric core; projects form deterministic assemblies around it; goals, decisions, commitments, blockers, evidence, sources and capabilities occupy distinct depth and height planes. Structural rings, a ground grid, thin directional connections and a slow scan expose the shape of the company without asserting new facts. Node cards remain readable and become prominent when their context is selected.

The central core, project assemblies and operating summary make the company knowledge boundary legible to a CEO without inventing hierarchy, ownership, progress or performance metrics. The overview shows the whole verified model; focusing a project frames its complete assembly rather than magnifying one isolated node. The presentation name comes from onboarding; no company identity is hardcoded into the public Core. The cinematic spatial-computing reference is implemented with original geometry, typography and AI OS branding; it does not copy Marvel, Iron Man, Google or Y Combinator trademarks, characters or interface assets.

## Start

Build the browser bundle after installing dependencies:

```powershell
npm ci --ignore-scripts
npm run build:dashboard
```

Open an existing PERSONAL instance:

```powershell
$instance = Join-Path $env:LOCALAPPDATA 'ai-os\instances\personal'
npm run dashboard -- --instance $instance
```

Equivalent CLI command:

```powershell
npm run cli -- dashboard --instance $instance --port 4640
```

The server binds only to `127.0.0.1`. `--principal` and `--workspace` can select an identity scope already authorized by the instance. The port can be changed with `--port`; presentation name comes from onboarding, while visual filters remain browser-local preferences.

## Interaction

- orbit, zoom and inspect one persistent 3D scene rooted in the authorized workspace;
- search by ID, type, state, name or confirmed description;
- filter by node type, state and represented source;
- focus a project cluster, move between related nodes and return to the previous focus;
- reset the camera, pause the holographic scan or use immersive mode;
- replay actual connectivity as a visual traversal;
- copy a short read-only node context for a later Codex request.

Connectivity replay is not a historical timeline. AI OS does not present chronological project animation unless verified historical events support it.

## Local server boundary

- GET and HEAD only; mutation methods return `405`;
- exact loopback Host and same-origin validation;
- no permissive CORS;
- fixed static-file allow-list;
- restrictive CSP and browser security headers;
- no filesystem path parameter, command execution or reveal/open endpoint;
- external content is rendered as text, never injected as HTML.

All mutations remain in Codex and the kernel approval path.

## Upstream reference and licenses

The renderer uses `three` and `3d-force-graph`. Connectivity replay and selected interaction patterns were adapted from Nate Herk's AIS-OS `3d-brain` at commit `ce9cb93a1145da5daba84ea37208ec35fd03606e`, under its MIT license. The holographic card renderer, workspace core, exploded assembly layout and structural stage are AI OS adaptations.

The original notice is preserved in `src/dashboard/vendor/NATE-AIS-OS-LICENSE.txt`; dependency notices are preserved in `src/dashboard/vendor/THIRD-PARTY-NOTICES.txt`. AI OS-specific projection, authorization, server, UI and operational semantics remain under Apache-2.0. No Three Ms of AI™ or Four Cs of an AI OS™ framework or branding is incorporated.

## Current limits

- local single-user PERSONAL instances only;
- no dashboard mutations or deep Codex UI integration;
- no real-time push; refresh the page to rebuild the projection;
- no invented progress, urgency, priority, owner or KPI;
- freshness is `UNKNOWN` when the source does not provide a usable observation timestamp or threshold;
- large graphs have not yet been performance-tested beyond synthetic acceptance data;
- WebGL and browser GPU support are required for the 3D view.
