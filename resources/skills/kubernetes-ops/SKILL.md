---
name: kubernetes-ops
description: "Kubernetes cluster operations: kubectl commands, manifest generation, Helm charts, RBAC, debugging, and deployment strategies."
---

# Kubernetes Operations

## Purpose

Kubernetes cluster operations: kubectl commands, manifest generation, Helm charts, RBAC, debugging, and deployment strategies.

## Routing

- Use when: Use when the user asks about Kubernetes, k8s, kubectl, pods, deployments, services, ingress, Helm charts, RBAC, container orchestration, or cluster management.
- Do not use when: Do not use for Docker Compose (use docker-compose-ops), Terraform IaC (use terraform-ops), or general cloud migration (use cloud-migration).
- Outputs: kubectl commands, Kubernetes manifests (YAML), Helm operations, and debugging guidance.
- Success criteria: Returns valid Kubernetes manifests or kubectl commands that can be applied to a cluster.

## Trigger Examples

### Positive

- Use the kubernetes-ops skill for this request.
- Help me with kubernetes operations.
- Use when the user asks about Kubernetes, k8s, kubectl, pods, deployments, services, ingress, Helm charts, RBAC, container orchestration, or cluster management.
- Kubernetes Operations: provide an actionable result.

### Negative

- Do not use for Docker Compose (use docker-compose-ops), Terraform IaC (use terraform-ops), or general cloud migration (use cloud-migration).
- Do not use kubernetes-ops for unrelated requests.
- This request is outside kubernetes operations scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 898 characters.
- Runtime prompt is defined directly in `../kubernetes-ops.json`. 
