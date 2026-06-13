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
- **State storage:** file-based JSON and YAML
- **Agent pattern:** ReAct (Reason → Act → Observe → Repeat)

This baseline is the first milestone, not the final research direction.

## Current scope

The current implementation is synced through the Phase 7 boundary in the
11-phase roadmap. It provides:
- a TypeScript CLI entrypoint
- a pre-ReAct Static Gateway for intent classification, structured query parsing,
  static validation, and early rejection/clarification
- a structured ReAct agent loop with explicit reason/act/observe trace steps
- provider-agnostic LLM interface with a stub provider and an OpenAI Responses
  API provider path
- prompt-to-spec planning that builds an `InfrastructureSpec` from a validated
  query
- execution plan generation from the validated spec
- deterministic Docker Compose YAML rendering as a preview artifact
- dependency-aware detailed dry-run preview with policy/readiness observations
- file-based state storage with schema versioning, pending preview memory,
  current verified runtime snapshot shape, history, validation, and atomic writes
- a `status` command that reads saved pending/current state memory

Still not implemented:
- explicit approval gate / y-n approval workflow
- typed `ApprovedAction`
- MetaVerifier / ToolVerifier / `VerificationReport`
- custom MCP server
- Docker Runtime Adapter or Docker Engine API apply/observe path
- real runtime drift detection, destroy, repair, or healing

## Functional goals through phase 7

The mini-project CLI currently supports:
- entering natural-language infrastructure requests
- running the Static Gateway before ReAct starts
- analyzing validated requests into a desired-state `InfrastructureSpec`
- showing assumptions, observations, ReAct trace, plan steps, and preview output
- running in **dry-run** mode to preview changes without saving state or applying Docker changes
- generating Docker Compose-style configuration as an intermediate preview artifact
- optionally persisting a **pending preview memory record** without deploying Docker (for example via `--save-state`)
- supporting status-style inspection over saved pending/current state memory

The current data boundary is:
- the validated **InfrastructureSpec** is the canonical desired-state model
- the generated **Docker Compose YAML** is a derived preview/execution artifact
- state persistence saves pending preview memory separately from future verified desired/actual runtime state
- compose text is stored only as artifact metadata/content and must not become the primary domain object

The current implementation intentionally stops short of real Docker deployment,
runtime observation, and full drift detection. Those behaviors belong to Phase
8+ after approval, typed action, preflight, verification, MCP, and Docker runtime
boundaries are stronger.

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
- **Phase 1 / baseline scaffold** — natural-language planning, structured infra spec generation, compose rendering, dry-run, and file-based desired state.
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
npm run dev -- status
npm run build
npm run typecheck
npm run lint
npm test
```

## Notes

- The current implementation is preview/state-memory-first: it can plan, validate,
  render, dry-run, and save a pending preview, but does not yet perform real
  Docker deployment.
- OpenAI provider integration exists; the stub provider remains the default
  deterministic path for local dev/tests. Gemini and Ollama are explicit
  not-implemented paths.
- `state/infra-state.json` may contain legacy v0 state; the loader migrates it
  into v1 pending preview memory and keeps current verified runtime state empty
  until a future approved apply observes Docker runtime.
