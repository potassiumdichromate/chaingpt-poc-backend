# Documentation index

Written for three audiences: engineers extending the service, frontend engineers
integrating against it, and whoever has to run the showcase.

## Start here

- **[architecture.md](architecture.md)** — the system model, module map, request
  lifecycle, and the decisions that shaped them.
- **[api-reference.md](api-reference.md)** — every endpoint, every payload, every
  status code, and the error envelope contract.

## Building against it

- **[frontend-integration.md](frontend-integration.md)** — the complete integration
  guide: client contract, the five flows, error handling, state model, CORS, env.
- **[design-system.md](design-system.md)** — tokens, components, and the UX rules that
  keep the product honest (memory badge, evidence block, degraded banner).

## Working inside it

- **[intelligence-pipeline.md](intelligence-pipeline.md)** — prompts, structured-output
  parsing, schema validation, the memory loop and its enforcement pass.
- **[chaingpt-integration.md](chaingpt-integration.md)** — provider abstraction,
  transports, live-verified API findings, credits, going live.
- **[kult-data-model.md](kult-data-model.md)** — what is real KULT data, what is
  derived, and the live shape variance the mappers absorb.

## Running it

- **[configuration.md](configuration.md)** — every environment variable, its real
  default in code, and what it changes.
- **[operations.md](operations.md)** — deployment, health checks, the showcase runbook,
  storage durability, scaling limits.
- **[testing.md](testing.md)** — the suite, the scripts, and what each one proves.

## Knowing what is broken

- **[audit.md](audit.md)** — findings from the full-stack audit, ranked by severity,
  each with a reproduction and a fix.
