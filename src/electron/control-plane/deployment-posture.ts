import type { ControlPlaneBindContext } from "../utils/runtime-mode";
import type { ControlPlaneSettings } from "./settings";

export type ControlPlaneDeploymentPostureStatus = "ready" | "degraded" | "blocked";

export interface ControlPlaneDeploymentPostureOptions {
  settings: Pick<ControlPlaneSettings, "host" | "token" | "nodeToken" | "tailscale">;
  headless: boolean;
  managedDeployment: boolean;
  bindContext: ControlPlaneBindContext;
  allowInsecurePublicBind: boolean;
}

export interface ControlPlaneDeploymentPosture {
  status: ControlPlaneDeploymentPostureStatus;
  managedMode: boolean;
  headless: boolean;
  host: string;
  bindContext: ControlPlaneBindContext;
  publicBind: boolean;
  tailscaleEnabled: boolean;
  insecurePublicBindAllowed: boolean;
  operatorTokenStrong: boolean;
  nodeTokenStrong: boolean;
  reasons: string[];
  recommendations: string[];
}

export function isLoopbackControlPlaneHost(host?: string): boolean {
  const normalized = String(host || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function isPublicControlPlaneBind(host?: string): boolean {
  const normalized = String(host || "")
    .trim()
    .toLowerCase();
  if (isLoopbackControlPlaneHost(normalized)) return false;
  return (
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*"
  );
}

export function isStrongControlPlaneToken(token?: string): boolean {
  const value = String(token || "").trim();
  if (value.length < 32) return false;
  if (/^(changeme|change-me|password|token|secret|test|dev|local)$/i.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return true;
}

export function evaluateControlPlaneDeploymentPosture(
  options: ControlPlaneDeploymentPostureOptions,
): ControlPlaneDeploymentPosture {
  const settings = options.settings;
  const managedMode = options.managedDeployment || options.headless;
  const host = settings.host || "127.0.0.1";
  const publicBind = isPublicControlPlaneBind(host);
  const tailscaleEnabled =
    settings.tailscale?.mode !== undefined && settings.tailscale.mode !== "off";
  const operatorTokenStrong = isStrongControlPlaneToken(settings.token);
  const nodeTokenStrong = isStrongControlPlaneToken(settings.nodeToken);
  const reasons: string[] = [];
  const recommendations: string[] = [];

  if (publicBind) {
    reasons.push(`Control Plane is bound to ${host}.`);
    recommendations.push("Prefer 127.0.0.1 with an SSH tunnel or Tailscale for remote access.");
  }

  if (managedMode && publicBind) {
    const permitted =
      tailscaleEnabled || options.bindContext === "container" || options.allowInsecurePublicBind;
    if (!permitted) {
      reasons.push(
        "Managed/headless deployments cannot bind the Control Plane publicly by default.",
      );
      recommendations.push(
        "Set COWORK_CONTROL_PLANE_BIND_CONTEXT=container only for loopback-published containers, enable Tailscale, or explicitly set COWORK_CONTROL_PLANE_ALLOW_INSECURE_PUBLIC_BIND=1.",
      );
    } else if (options.allowInsecurePublicBind) {
      reasons.push("Public bind is enabled through an explicit break-glass override.");
      recommendations.push(
        "Place the Control Plane behind trusted network controls and rotate tokens regularly.",
      );
    } else if (options.bindContext === "container") {
      reasons.push(
        "Public bind is allowed inside a container; host publishing must remain loopback/private.",
      );
      recommendations.push(
        "Keep Docker/Kubernetes service exposure private and publish host ports on 127.0.0.1.",
      );
    } else if (tailscaleEnabled) {
      reasons.push("Public bind is allowed because Tailscale exposure is configured.");
    }
  }

  if (managedMode && !operatorTokenStrong) {
    reasons.push("Managed/headless deployment requires a strong operator token.");
    recommendations.push(
      "Regenerate the Control Plane token or let CoWork create a 64-character token.",
    );
  }
  if (managedMode && !nodeTokenStrong) {
    reasons.push("Managed/headless deployment requires a strong node token.");
    recommendations.push(
      "Regenerate the Control Plane token pair before exposing remote device access.",
    );
  }

  let status: ControlPlaneDeploymentPostureStatus = "ready";
  if (
    (managedMode &&
      publicBind &&
      !tailscaleEnabled &&
      options.bindContext !== "container" &&
      !options.allowInsecurePublicBind) ||
    (managedMode && (!operatorTokenStrong || !nodeTokenStrong))
  ) {
    status = "blocked";
  } else if (publicBind || options.allowInsecurePublicBind) {
    status = "degraded";
  }

  return {
    status,
    managedMode,
    headless: options.headless,
    host,
    bindContext: options.bindContext,
    publicBind,
    tailscaleEnabled,
    insecurePublicBindAllowed: options.allowInsecurePublicBind,
    operatorTokenStrong,
    nodeTokenStrong,
    reasons,
    recommendations,
  };
}
