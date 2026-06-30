# 3-Tier Real Docker Chaos Test Matrix

This catalog backs `tests/three-tier-chaos-pipeline.test.ts` and validates the natural-language scenario against real Docker Desktop through the Supernova Docker MCP gateway:

> Deploy a 3-tier system with `a` Nginx instances, `b` Node.js backends, and `c` PostgreSQL databases.

## Boundary Matrix

| Case                       | Values                           | Expected behavior                                                                                             |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Small matrix               | `a=2,b=2,c=2`                    | 6 real containers deploy, observe cleanly, and destroy.                                                       |
| Medium matrix              | `a=3,b=3,c=3`                    | 9 real containers deploy with Postgres -> Node.js -> Nginx ordering.                                          |
| Larger matrix              | `a=4,b=4,c=4`                    | 12 real containers validate deterministic names and actual runtime drift checks.                              |
| Max requested matrix       | `a=5,b=5,c=5`                    | 15 real containers deploy, observe, and cleanup through MCP.                                                  |
| Fixed-port collision guard | `a=2,b=2,c=2` with Nginx `80:80` | Rejected before Docker mutation because replicated services cannot publish fixed host ports.                  |
| Repair pipeline            | `a=2,b=3,c=2`                    | Deploys real containers, deletes one backend, detects drift, repairs it, then destroys all managed resources. |

## Dependency Assertions

- Database services must appear before backend services in `serviceStartOrder`.
- Backend services must appear before reverse-proxy services in `serviceStartOrder`.
- `destroyOrder` must be the reverse of start order.
- Compose must include `depends_on` from Node.js to Postgres and Nginx to Node.js.
- Compose must include database healthchecks for PostgreSQL images.
- Direct Docker deploy must use real MCP mutation routes, not a fake gateway.

## Real Docker Chaos Injection Scenarios

| Scenario                   | Injection                                               | Expected invariant                                                              |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Replicated fixed port race | `a=2,b=2,c=2` with Nginx `80:80`                        | Deploy is blocked before any real Docker resources are created.                 |
| Missing backend replica    | Remove `matrix-real-2-3-2-api-2` using MCP after deploy | Drift reports missing container; repair recreates that replica only.            |
| Full lifecycle             | Deploy -> observe/status -> drift -> repair -> destroy  | Desired state matches actual after repair; containers are absent after destroy. |
| Scale pressure             | Deploy 6, 9, 12, and 15 containers sequentially         | Names, images, networks, and dependency order remain deterministic.             |

## LLM Context Prompts for Manual Agent Stress

Use these prompts with a stub or low-temperature provider, then compare the generated spec and real Docker runtime state against the matrix above:

1. `Deploy a 3-tier system with 2 Nginx instances, 2 Node.js backends, and 2 PostgreSQL databases. Avoid fixed host ports for replicated services.`
2. `Deploy a 3-tier system with 3 Nginx instances, 3 Node.js backends, and 3 PostgreSQL databases. Avoid fixed host ports for replicated services.`
3. `Deploy a 3-tier system with 4 Nginx instances, 4 Node.js backends, and 4 PostgreSQL databases. Avoid fixed host ports for replicated services.`
4. `Deploy a 3-tier system with 5 Nginx instances, 5 Node.js backends, and 5 PostgreSQL databases. Avoid fixed host ports for replicated services.`
5. `Deploy 2 Nginx reverse proxies both on host port 80, 2 Node backends, and 2 Postgres databases.`
6. `During deploy, delete one backend replica and repair the system without touching healthy replicas.`

## Local Commands

```bash
npm run build:supernova-mcp
npm run test:chaos
npm run test:pipeline
npm run typecheck
npm run lint
```
