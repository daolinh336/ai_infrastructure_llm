# Infra ReAct Agent

Mini project scaffold for a natural-language infrastructure management CLI using a ReAct-style agent architecture.

## Current scope

This initial scaffold provides:
- a TypeScript CLI entrypoint
- a seed ReAct agent loop abstraction
- provider-agnostic LLM interface with a stub provider
- execution plan generation
- Docker Compose YAML rendering
- file-based infrastructure state storage
- a basic `status` command

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
