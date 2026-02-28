---
name: terraform-ops
description: "Infrastructure-as-Code operations: plan, apply, import, state management, module development, and drift detection using Terraform CLI."
---

# Terraform Operations

## Purpose

Infrastructure-as-Code operations: plan, apply, import, state management, module development, and drift detection using Terraform CLI.

## Routing

- Use when: Use when the user asks about Terraform, infrastructure as code, IaC, HCL, terraform plan, terraform apply, state management, module development, drift detection, or cloud resource provisioning with Terraform.
- Do not use when: Do not use for Kubernetes/container orchestration (use kubernetes-ops), Docker Compose (use docker-compose-ops), or general cloud migration strategy (use cloud-migration).
- Outputs: Terraform commands, HCL configurations, state management guidance, and infrastructure plans.
- Success criteria: Returns actionable Terraform commands or HCL code that can be executed via shell tools.

## Trigger Examples

### Positive

- Use the terraform-ops skill for this request.
- Help me with terraform operations.
- Use when the user asks about Terraform, infrastructure as code, IaC, HCL, terraform plan, terraform apply, state management, module development, drift detection, or cloud resource provisioning with Terraform.
- Terraform Operations: provide an actionable result.

### Negative

- Do not use for Kubernetes/container orchestration (use kubernetes-ops), Docker Compose (use docker-compose-ops), or general cloud migration strategy (use cloud-migration).
- Do not use terraform-ops for unrelated requests.
- This request is outside terraform operations scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 4112 characters.
- Runtime prompt is defined directly in `../terraform-ops.json`. 
