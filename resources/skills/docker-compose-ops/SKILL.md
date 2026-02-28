---
name: docker-compose-ops
description: "Docker Compose operations: service orchestration, compose file authoring, multi-stage builds, networking, volumes, and production configurations."
---

# Docker Compose Operations

## Purpose

Docker Compose operations: service orchestration, compose file authoring, multi-stage builds, networking, volumes, and production configurations.

## Routing

- Use when: Use when the user asks about Docker Compose, docker-compose.yml, multi-container applications, service orchestration with Docker, or container networking with Compose.
- Do not use when: Do not use for Kubernetes (use kubernetes-ops), Terraform (use terraform-ops), or standalone Docker commands not related to Compose.
- Outputs: Docker Compose files, Dockerfiles, docker compose commands, and container orchestration guidance.
- Success criteria: Returns valid docker-compose.yml configurations or docker compose commands.

## Trigger Examples

### Positive

- Use the docker-compose-ops skill for this request.
- Help me with docker compose operations.
- Use when the user asks about Docker Compose, docker-compose.yml, multi-container applications, service orchestration with Docker, or container networking with Compose.
- Docker Compose Operations: provide an actionable result.

### Negative

- Do not use for Kubernetes (use kubernetes-ops), Terraform (use terraform-ops), or standalone Docker commands not related to Compose.
- Do not use docker-compose-ops for unrelated requests.
- This request is outside docker compose operations scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 899 characters.
- Runtime prompt is defined directly in `../docker-compose-ops.json`. 
