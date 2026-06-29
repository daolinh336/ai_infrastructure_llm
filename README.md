# Infra ReAct Agent

Mini project scaffold for a natural-language infrastructure management CLI using a ReAct-style agent architecture.

## Product vision

This project aims to become a CLI that lets users manage infrastructure through natural-language commands.

A user should be able to describe target infrastructure such as:

```bash
infra-react-agent plan "Create a web application with nginx, 2 node backends, and postgres"
```

The system will then:
- interpret the request with an AI agent
- generate a structured infrastructure specification
- build an execution plan with dependencies and safety-oriented steps
- support dry-run review before execution
- synthesize Docker configuration outputs
- deploy infrastructure through Docker Engine APIs
- persist desired vs actual state for status and drift detection

The architectural rule is:
- **InfrastructureSpec is the source of truth** for desired infrastructure intent
- **ExecutionPlan is the procedural layer** that explains how the system intends to validate, preview, approve, apply, and observe that spec
- **Docker Compose YAML is an artifact** rendered from the spec for preview and execution support, not the canonical model of the system

To support future MCP integration and direct Docker runtime control safely, the architecture will treat execution as a typed, policy-controlled boundary rather than letting the agent call runtime operations directly.

## Baseline scope

The current baseline target is intentionally narrow:
- **Runtime and backend:** Node.js + TypeScript
- **AI providers:** Gemini and OpenAI API integration
- **Container runtime:** Docker Engine API
- **State storage:** SQLite through `better-sqlite3`; validated domain objects are stored as JSON payloads in SQLite tables, while YAML remains a generated artifact format
- **Agent pattern:** ReAct (Reason → Act → Observe → Repeat)

This baseline is the first milestone, not the final research direction.

## Current scope

The current implementation is synced through the Phase 8 control boundary in the
11-phase roadmap. It provides:
- a TypeScript CLI entrypoint
- a pre-ReAct Static Gateway for obvious unsafe/out-of-scope pre-screening,
  full-prompt LLM intent classification, structured query parsing,
  deterministic static validation, and early rejection/clarification
- a structured ReAct agent loop with explicit reason/act/observe trace steps
- provider-agnostic LLM interface with a stub provider and an OpenAI Responses
  API provider path
- prompt-to-spec planning that builds an `InfrastructureSpec` from a validated
  query
- execution plan generation from the validated spec
- deterministic Docker Compose YAML rendering as a preview artifact
- dependency-aware detailed dry-run preview with policy/readiness observations
- SQLite state storage with schema versioning, pending preview memory,
  current verified runtime snapshot shape, history, and validation
- Phase 8 approval/preflight boundary: `plan --apply` runs preflight, asks y/n,
  writes `docker-compose.yaml` only after approval, and creates an
  `ApprovedAction`
- a read-only `doctor --docker` setup check for Docker CLI/Desktop reachability
- a `status` command that reads saved pending/current state memory

Still not implemented:
- custom MCP server
- Docker Runtime Adapter or Docker Engine API apply/observe path
- real runtime drift detection, destroy, repair, or healing

## Functional goals through phase 8

The mini-project CLI currently supports:
- entering natural-language infrastructure requests
- running the Static Gateway before ReAct starts
- analyzing validated requests into a desired-state `InfrastructureSpec`
- showing assumptions, observations, ReAct trace, plan steps, and preview output
- running in **dry-run** mode to preview changes without saving state or applying Docker changes
- generating Docker Compose-style configuration as an intermediate preview artifact
- optionally persisting a **pending preview memory record** in SQLite without deploying Docker (for example via `--save-state`)
- running `plan --apply` to preview, preflight, ask approval, write the compose
  artifact only after approval, and save the approved action in SQLite
- running `doctor --docker` as a read-only Docker Desktop setup check
- supporting status-style inspection over saved pending/current state memory

The current data boundary is:
- the validated **InfrastructureSpec** is the canonical desired-state model
- the generated **Docker Compose YAML** is a derived preview/execution artifact
- SQLite persistence saves pending preview memory and approved action records
  separately from future verified desired/actual runtime state
- compose text is stored only as artifact metadata/content and must not become the primary domain object

The current implementation intentionally stops short of real Docker deployment,
runtime observation, and full drift detection. Those behaviors belong to Phase
9+ after MCP and Docker runtime boundaries are implemented.

For the first real Docker milestone, keep the demo intentionally basic, but define the custom/wrapper MCP contract before exposing runtime tools to the agent. Existing Docker MCP servers may be used for prototyping behind an adapter, but the agent should only see the project's narrow, policy-controlled tool surface.

## Runtime safety layers for MCP + Docker Engine API

Before the agent is allowed to operate on Docker through MCP or direct runtime adapters, the project should add explicit control layers:

- **MCP / tool boundary** — the agent decides *what* it wants to do, but all runtime actions must pass through typed tool contracts rather than raw Docker calls.
- **Docker runtime interface** — Docker Engine API access should live behind a dedicated runtime adapter so agent logic, CLI code, and status code do not depend on low-level Docker request details.
- **Safety / approval gate** — read-only inspection, dry-run generation, and state persistence can be low-risk paths, but create/start/stop/remove actions must be classified and gated by approval or policy.
- **Tool input/output validation** — MCP tool calls should use explicit schemas, constrained arguments, and structured results so the system can reject malformed or unsafe requests before execution.
- **Test-before-apply pipeline** — every real apply flow should validate the infrastructure spec, render outputs deterministically, build a detailed dependency-aware dry-run preview, run preflight checks, and surface the expected impact before touching the runtime.
- **Split-Act pipeline** — the LLM proposes an action, an action builder creates a typed tool call, preflight validation checks schema/policy/state/dry-run evidence, approval gates side effects, the executor calls MCP/runtime, and an observer/verifier reads the result.
- **Detailed dry-run preview** — before any runtime mutation, the system should show the resources, dependency order, readiness gates, ports, volumes, networks, environment/default secrets, and actions not performed.
- **Read-only verifier path** — post-action verification should use read-only tools and must not share mutation permissions with the executor.

These layers are the architectural "guardrails" that let the agent act without turning runtime execution into opaque LLM behavior.

## Future upgrade direction

After the baseline is working, the project may evolve beyond a simple ReAct loop.

A practical roadmap is:
- **Phase 1 / baseline scaffold** — natural-language planning, structured infra spec generation, compose rendering, dry-run, and persisted desired/pending state.
- **Phase 2 / controlled runtime boundary** — keep `InfrastructureSpec` as the desired-state source of truth, strengthen validation and typed execution planning around it, and avoid promoting compose output into the domain model.
- **Phase 3 / custom or wrapper MCP contract** — define the project's narrow MCP tool surface early; existing Docker MCP servers can be wrapped behind it for prototyping.
- **Phase 4 / Docker runtime + verifier** — connect the custom MCP boundary to Docker Engine API or a wrapped Docker MCP implementation, classify failure modes, and verify results with read-only observation tools.
- **Phase 5 / end-to-end hardening** — complete apply/status/destroy/drift flows, strengthen policy, logging, contract tests, error handling, verification, and observation-heavy workflows.

For a more detailed implementation sequence, see `docs/roadmap-11-phases.md`. For a trackable execution checklist, see `docs/roadmap-11-phases-checklist.md`.

One candidate long-term direction is a more verification-heavy architecture, for example:
- **Robust Infrastructure by Verification Agents**
- **Tool Generation Agent + Verifier Agent**
- **Dual-environment architecture**
- **Atomic Configuration Synthesis**

In addition to those longer-term ideas, the near-term roadmap for Docker Engine API + MCP integration should emphasize:
- capability-scoped MCP tools instead of unrestricted runtime access
- explicit plan → validate → preview → approve → apply → observe flow
- `InfrastructureSpec` as the desired-state source of truth and `ExecutionPlan` as the procedural layer
- Docker Compose as a rendered artifact for preview/execution support rather than the canonical domain model
- split-Act execution with preflight validation before the executor can call MCP/runtime
- detailed dependency-aware dry-run preview before host runtime mutation
- runtime observation paths for status, drift detection, post-action verification, and failure classification
- explicit error handling for validation failures, preflight failures, approval rejection, runtime failures, and post-apply verification mismatches
- policy controls for destructive or externally exposed operations
- testable runtime adapters and mocks for integration testing

The purpose of that direction is to avoid blind AI execution of generated infrastructure files and reduce failure modes such as broken deployments, dangling containers, invalid virtual network setups, or unsafe runtime mutations. Custom MCP contracts belong before the runtime demo becomes agent-visible; implementation can still reuse an existing Docker MCP server behind a wrapper.

## Commands

```bash
npm install
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres"
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres" --apply
npm run dev -- doctor --docker
npm run dev -- status
npm run build
npm run build:supernova-mcp
npm run test:e2e:docker-mcp
npm run typecheck
npm run lint
npm test
```

## Docker MCP deployment

Docker deploys use the local Supernova MCP server by default. The runtime path is CLI/execution engine -> `DockerMcpGateway` -> Supernova MCP stdio server -> `dockerode` -> Docker Engine API. The CLI does not call Docker directly for deploy, observe, verify, or cleanup.

Before a real deploy or the opt-in E2E smoke test, build the server:

```bash
npm --prefix .worktrees/docker-mcp-server-supernova install
npm run build:supernova-mcp
npm run test:e2e:docker-mcp
npm run test:e2e:docker-mcp:all-tools
```

The default profile is `supernova-local` and runs `node .worktrees/docker-mcp-server-supernova/dist/index.js`. `INFRA_DOCKER_MCP_PROFILE=legacy-uvx` and `INFRA_DOCKER_MCP_PROFILE=official` remain explicit debug overrides only.

## LLM provider setup

The stub provider remains the default deterministic path. OpenAI and Gemini are
both first-class provider choices configured through a local `.env` file. Set
`INFRA_AGENT_PROVIDER` to `openai`, `gemini`, or `stub`; optionally set
`INFRA_AGENT_FALLBACK_PROVIDER` so a failed primary provider falls back to the
other one.

```bash
INFRA_AGENT_PROVIDER=openai
INFRA_AGENT_FALLBACK_PROVIDER=gemini
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://api.vietapi.tech/v1
OPENAI_REACT_MODEL=gpt-5.5
OPENAI_AUX_MODEL=gpt-5.5

# Gemini calls the Google API directly (no proxy).
GEMINI_API_KEY=your_gemini_key
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_REACT_MODEL=gemini-2.5-flash
GEMINI_AUX_MODEL=gemini-2.5-flash
```

Provider variables:

- **OpenAI**: `OPENAI_API_KEY` (required), `OPENAI_BASE_URL` (optional, for
  OpenAI-compatible proxies), `OPENAI_REACT_MODEL`, `OPENAI_AUX_MODEL`.
- **Gemini**: `GEMINI_API_KEY` or `GOOGLE_API_KEY` (required), `GEMINI_BASE_URL`
  (defaults to the direct Google endpoint), `GEMINI_REACT_MODEL`, `GEMINI_AUX_MODEL`.
- `OPENAI_BASE_URL` only affects the OpenAI provider; Gemini always uses its own
  direct Google endpoint via `GEMINI_BASE_URL`.

## Notes

- Real Docker deployment is available through the guarded Supernova MCP path after
  approval; preview/dry-run remains the default path when deploy is not requested.
- OpenAI and Gemini are both working first-class provider choices configured
  via `.env` (see provider setup above); the stub provider remains the default
  deterministic path for local dev/tests. Only OpenAI and Gemini are
  supported as real providers.
- SQLite is the primary state storage at `state/infra-state.sqlite`.
