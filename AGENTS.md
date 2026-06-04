# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Repository overview

This repository is being developed into a natural-language infrastructure management CLI. The current stack is:
- **Node.js + TypeScript** for the application runtime and CLI
- **Provider-agnostic LLM integration** behind an adapter interface (intended to support OpenAI, Gemini, and Ollama)
- **Docker Compose generation** as the first infrastructure output target
- **File-based state storage** in `state/infra-state.json` for desired vs actual state tracking

Reference and legacy files still present in the repo:
- `ReAct.pdf` — reference paper describing the ReAct paradigm (interleaving reasoning and acting in language models)
- `test/sc.sh` — unrelated shell script from earlier repository state; do not treat it as part of the main application architecture unless a task explicitly mentions it

## Common commands

Install dependencies:

```bash
npm install
```

Run the CLI in development mode:

```bash
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres"
npm run dev -- status
```

Build and validate:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Run the built CLI:

```bash
npm run start -- plan "Create a web application with nginx, 2 node backends, and postgres"
```

## Architecture

The codebase is organized around a small agent pipeline for infrastructure automation:

- `src/cli.ts` — CLI entrypoint using Commander. Parses commands, invokes the agent, runs the execution engine, and prints plans/results.
- `src/agent/` — ReAct-style orchestration layer. This is where natural-language requests are interpreted into execution plans, with reasoning/observation/action steps represented explicitly.
- `src/llm/` — provider abstraction for LLM backends. Keep provider-specific API code behind this boundary rather than leaking it into agent logic.
- `src/domain/` — shared domain types and input schemas for infrastructure specs, execution plans, and CLI validation.
- `src/compose/` — generation of Docker Compose YAML from the internal infrastructure spec.
- `src/execution/` — execution engine that handles dry-run/apply flows and will later own deployment sequencing and dependency-aware execution.
- `src/state/` — persistence of desired/actual state snapshots for status and drift detection.
- `src/status/` — read-model style status reporting over saved infrastructure state.
- `tests/` — unit tests, currently focused on deterministic generators such as Compose rendering.

As the project grows toward MCP integration and direct Docker runtime control, preserve a strict separation between:
- **agent intent** — deciding what action the system wants to take
- **tool/runtime capability** — deciding what operations are available and how they are executed
- **policy/approval** — deciding whether a requested action is allowed now
- **runtime observation** — reading actual Docker state back into the ReAct loop

Current control flow is:
1. CLI receives a natural-language infrastructure request
2. ReAct agent produces an execution plan and structured infrastructure spec
3. execution engine renders Compose YAML and optionally persists desired state
4. status/state services expose saved snapshots for later inspection and drift workflows

Near-term delivery should stay phased:
- **Baseline scaffold** — planning, compose rendering, state persistence, and dry-run behavior
- **Basic Docker demo** — limited image/container operations with preview and explicit confirmation
- **Custom MCP server** — only after the basic Docker demo works reliably, add a custom MCP capability layer around validated runtime operations
- **Later verification-heavy evolution** — add verifier-oriented or dual-environment patterns once the runtime boundary is stable

Target control flow for Docker Engine API + MCP-enabled execution is:
1. CLI receives a natural-language infrastructure request
2. ReAct agent produces an execution plan and structured infrastructure spec
3. validation layer checks spec/tool inputs and rejects malformed or unsafe requests
4. execution engine renders outputs and produces a dry-run or preview diff
5. approval/policy gate decides whether runtime actions may proceed
6. runtime adapter or MCP tool performs the allowed Docker operation
7. observation/state services capture actual runtime state for status and drift workflows

## ReAct-specific guidance

`ReAct.pdf` is repository-specific background material. The project concept maps the paper into infrastructure automation:
- **Reason** — interpret the user request, infer topology/dependencies/safety constraints
- **Act** — generate plan steps, render compose, inspect runtime, deploy/destroy
- **Observe** — collect LLM outputs, Docker/container state, and drift signals
- **Repeat** — refine or continue execution until the plan is complete

When implementing new features, prefer making these phases explicit in code rather than collapsing everything into one opaque service method.

For this repository, the **Act** phase must not become a raw Docker API escape hatch. All actions should be typed, validated, observable, and policy-controlled.

## MCP + Docker runtime guidance

When adding MCP support or Docker Engine API integration, follow these boundaries:

- Keep **MCP/tool contracts** narrow and capability-scoped. Prefer tools like inspect/list/render/apply specific resources over unrestricted "run arbitrary Docker operation" endpoints.
- Put Docker Engine API access behind a **runtime adapter** or dedicated execution module rather than calling it from `src/agent/` or `src/cli.ts`.
- Add **tool input/output schemas** so every action has explicit validation, constrained arguments, and structured results.
- Introduce a **safety/approval gate** before side-effecting operations such as create/start/stop/remove, host bind mounts, or externally exposed ports.
- Treat **dry-run, preview, and preflight checks** as required parts of the execution path, not optional polish.
- Make **observation** first-class: after runtime actions, capture actual Docker state for status, reconciliation, and future drift detection.

Implementation sequencing matters:
- Start with a **basic Docker demo** that proves limited image/container workflows end to end.
- Keep those first runtime actions simple and auditable: image pull/build, container create/start/inspect, and read-back observation.
- Only after that demo is stable should the project introduce a **custom MCP server** as the guarded capability layer for richer agent-driven runtime control.
- Do not introduce a broad or generic MCP surface area before the project has validated its runtime boundaries, approval model, and validation flow.

If an MCP server is introduced, it should behave like a guarded capability layer for the execution engine, not like a generic remote shell for the agent.

## Implementation notes for future Codex instances

- Keep the **provider abstraction** clean. If adding OpenAI/Gemini/Ollama support, isolate request/response formatting in `src/llm/`.
- Preserve the distinction between **desired state** and **actual state**. Drift detection should compare the saved spec against observed container/runtime information rather than only checking whether files exist.
- Keep **dry-run** as a first-class path through the execution engine, not a last-minute flag.
- Treat Docker deployment as an execution concern (`src/execution/` or dedicated tool modules), not as CLI glue code.
- If tasks mention agent prompting, planning loops, or tool-using workflows, consult `ReAct.pdf` for design context before changing the agent architecture.
- Prefer a **plan → validate → preview → approve → apply → observe** flow for any real runtime action.
- Add tests around **schema validation, plan generation, compose rendering, policy decisions, and runtime adapter behavior** before enabling real apply flows.
- Avoid designs where the LLM directly constructs low-level Docker payloads without a validating domain layer in between.
