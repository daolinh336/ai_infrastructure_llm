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

This initial scaffold provides:
- a TypeScript CLI entrypoint
- a seed ReAct agent loop abstraction
- provider-agnostic LLM interface with a stub provider
- execution plan generation
- Docker Compose YAML rendering
- file-based infrastructure state storage
- a basic `status` command

## Functional goals for phase 1

The mini-project CLI should support:
- entering natural-language infrastructure requests
- analyzing requests into an execution plan
- showing the plan for user confirmation
- running in **dry-run** mode to preview changes without applying them
- generating Docker Compose-style configuration as an intermediate artifact
- deploying after confirmation
- persisting infrastructure state
- supporting status-style inspection and a future `destroy all` flow
- detecting drift by comparing desired state against actual Docker runtime state

For the first real Docker milestone, keep the demo intentionally basic: prove end-to-end execution with container/image-oriented flows before introducing a custom MCP server. That basic demo can include simple image pull/build and container create/start/inspect flows, as long as they still pass through dry-run, preview, and confirmation steps.

## Runtime safety layers for MCP + Docker Engine API

Before the agent is allowed to operate on Docker through MCP or direct runtime adapters, the project should add explicit control layers:

- **MCP / tool boundary** — the agent decides *what* it wants to do, but all runtime actions must pass through typed tool contracts rather than raw Docker calls.
- **Docker runtime interface** — Docker Engine API access should live behind a dedicated runtime adapter so agent logic, CLI code, and status code do not depend on low-level Docker request details.
- **Safety / approval gate** — read-only inspection, dry-run generation, and state persistence can be low-risk paths, but create/start/stop/remove actions must be classified and gated by approval or policy.
- **Tool input/output validation** — MCP tool calls should use explicit schemas, constrained arguments, and structured results so the system can reject malformed or unsafe requests before execution.
- **Test-before-apply pipeline** — every real apply flow should validate the infrastructure spec, render outputs deterministically, run preflight checks, and surface the expected impact before touching the runtime.

These layers are the architectural "guardrails" that let the agent act without turning runtime execution into opaque LLM behavior.

## Future upgrade direction

After the baseline is working, the project may evolve beyond a simple ReAct loop.

A practical roadmap is:
- **Phase 1 / baseline scaffold** — natural-language planning, structured infra spec generation, compose rendering, dry-run, and file-based desired state.
- **Phase 2 / basic Docker demo** — limited real runtime actions such as image pull/build, container create/start/inspect, and state observation, still with explicit preview and user confirmation.
- **Phase 3 / custom MCP server** — after the basic Docker demo is stable, introduce a custom MCP server as a guarded capability layer around validated, policy-controlled runtime actions.
- **Phase 4 / verification-heavy evolution** — expand toward verifier-oriented or dual-environment execution patterns once the runtime boundary is trustworthy.

For a more detailed implementation sequence, see `docs/roadmap-11-phases.md`.

One candidate long-term direction is a more verification-heavy architecture, for example:
- **Robust Infrastructure by Verification Agents**
- **Tool Generation Agent + Verifier Agent**
- **Dual-environment architecture**
- **Atomic Configuration Synthesis**

In addition to those longer-term ideas, the near-term roadmap for Docker Engine API + MCP integration should emphasize:
- capability-scoped MCP tools instead of unrestricted runtime access
- explicit plan → validate → preview → approve → apply flow
- runtime observation paths for status, drift detection, and post-action verification
- policy controls for destructive or externally exposed operations
- testable runtime adapters and mocks for integration testing

The purpose of that direction is to avoid blind AI execution of generated infrastructure files and reduce failure modes such as broken deployments, dangling containers, invalid virtual network setups, or unsafe runtime mutations. The custom MCP server belongs after the basic runtime demo milestone, not before it.

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

- The current implementation is scaffolding-first: it generates a seed plan and compose file, but does not yet perform real Docker deployment or real provider API calls.
- `state/infra-state.json` is used for desired/actual state persistence in the first phase.
