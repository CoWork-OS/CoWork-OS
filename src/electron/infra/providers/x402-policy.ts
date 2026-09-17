import type {
  X402PaymentDetails,
  X402PaymentRequirement,
  X402ResourceInfo,
} from "./wallet-provider";

export const BASE_MAINNET_NETWORK = "eip155:8453";
export const BASE_SEPOLIA_NETWORK = "eip155:84532";
export const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

const ATOMIC_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)$/;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && ATOMIC_AMOUNT_PATTERN.test(value);
}

export function parseAtomicAmount(value: unknown): bigint | null {
  if (!isAtomicAmount(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function formatAtomicUsdc(value: bigint | string): string {
  const atomic = typeof value === "bigint" ? value : parseAtomicAmount(value);
  if (atomic === null) return "unknown";
  const raw = atomic.toString().padStart(7, "0");
  const whole = raw.slice(0, -6) || "0";
  const fraction = raw.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Convert a configured decimal USD limit to six-decimal atomic units. */
export function usdToAtomic(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const normalized = value.toFixed(6);
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0") || "0");
}

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function isResourceInfo(value: unknown): value is X402ResourceInfo {
  return isRecord(value) && typeof value.url === "string" && value.url.length > 0;
}

export function isPaymentRequirement(value: unknown): value is X402PaymentRequirement {
  if (!isRecord(value)) return false;
  return (
    typeof value.scheme === "string" &&
    typeof value.network === "string" &&
    isAtomicAmount(value.amount) &&
    isAddress(value.asset) &&
    isAddress(value.payTo) &&
    typeof value.maxTimeoutSeconds === "number" &&
    Number.isSafeInteger(value.maxTimeoutSeconds) &&
    value.maxTimeoutSeconds > 0
  );
}

export function isCanonicalPaymentDetails(value: unknown): value is X402PaymentDetails {
  return normalizePaymentDetails(value) !== null;
}

/** Normalize either a raw v2 PaymentRequired envelope or local enriched details. */
export function normalizePaymentDetails(
  value: unknown,
  expectedNetwork?: string,
  expectedAsset?: string,
): X402PaymentDetails | null {
  if (!isRecord(value) || value.x402Version !== 2) return null;
  if (!isResourceInfo(value.resource) || !Array.isArray(value.accepts)) return null;
  if (!value.accepts.every(isPaymentRequirement)) return null;

  const suppliedSelected = isPaymentRequirement(value.selectedRequirement)
    ? value.accepts.find((candidate) => deepEqual(candidate, value.selectedRequirement))
    : undefined;
  const candidates =
    expectedNetwork && expectedAsset
      ? value.accepts.filter((candidate) =>
          isSupportedExactRequirement(candidate, expectedNetwork, expectedAsset),
        )
      : value.accepts.filter((candidate) => candidate.scheme === "exact");
  const selected = suppliedSelected || (candidates.length === 1 ? candidates[0] : undefined);
  if (!selected) return null;
  if (
    expectedNetwork &&
    expectedAsset &&
    !isSupportedExactRequirement(selected, expectedNetwork, expectedAsset)
  ) {
    return null;
  }

  const resourceInfo = { ...value.resource };
  const accepts = value.accepts.map((candidate) => ({
    ...candidate,
    ...(candidate.extra ? { extra: { ...candidate.extra } } : {}),
  }));
  const selectedRequirement = {
    ...selected,
    ...(selected.extra ? { extra: { ...selected.extra } } : {}),
  };
  return {
    ...(value as unknown as X402PaymentDetails),
    x402Version: 2,
    resource: resourceInfo,
    resourceInfo,
    resourceUrl: resourceInfo.url,
    accepts,
    selectedRequirement,
    scheme: selectedRequirement.scheme,
    payTo: selectedRequirement.payTo,
    amount: selectedRequirement.amount,
    asset: selectedRequirement.asset,
    network: selectedRequirement.network,
  };
}

export function getExpectedBaseNetwork(network: "base-mainnet" | "base-sepolia"): string {
  return network === "base-sepolia" ? BASE_SEPOLIA_NETWORK : BASE_MAINNET_NETWORK;
}

export function getExpectedBaseAsset(network: "base-mainnet" | "base-sepolia"): string {
  return network === "base-sepolia" ? BASE_SEPOLIA_USDC : BASE_MAINNET_USDC;
}

export function isSupportedExactRequirement(
  requirement: X402PaymentRequirement,
  expectedNetwork: string,
  expectedAsset: string,
): boolean {
  if (requirement.scheme !== "exact") return false;
  if (requirement.network.toLowerCase() !== expectedNetwork.toLowerCase()) return false;
  if (requirement.asset.toLowerCase() !== expectedAsset.toLowerCase()) return false;
  if (!isRecord(requirement.extra)) return false;
  if (
    requirement.extra.assetTransferMethod !== undefined &&
    requirement.extra.assetTransferMethod !== "eip3009"
  ) {
    return false;
  }
  return (
    typeof requirement.extra.name === "string" &&
    requirement.extra.name.length > 0 &&
    typeof requirement.extra.version === "string" &&
    requirement.extra.version.length > 0
  );
}

export function getSupportedRequirement(
  details: X402PaymentDetails,
  expectedNetwork: string,
  expectedAsset: string,
): X402PaymentRequirement | null {
  const normalized = normalizePaymentDetails(details, expectedNetwork, expectedAsset);
  if (!normalized) return null;
  const supported = normalized.accepts.filter((candidate) =>
    isSupportedExactRequirement(candidate, expectedNetwork, expectedAsset),
  );
  if (supported.length !== 1) return null;
  if (!deepEqual(supported[0], normalized.selectedRequirement)) return null;
  return supported[0];
}

export function getPaymentIdentity(details: X402PaymentDetails): unknown {
  return {
    x402Version: details.x402Version,
    resource: details.resource,
    accepts: details.accepts,
    selectedRequirement: details.selectedRequirement,
    extensions: details.extensions ?? null,
  };
}

export function getCanonicalPaymentMismatch(
  expected: X402PaymentDetails,
  actual: X402PaymentDetails,
): string | null {
  const normalizedExpected = normalizePaymentDetails(expected);
  const normalizedActual = normalizePaymentDetails(actual);
  if (!normalizedExpected || !normalizedActual) {
    return "canonical v2 payment details required";
  }
  if (!deepEqual(getPaymentIdentity(normalizedExpected), getPaymentIdentity(normalizedActual))) {
    const fields: Array<keyof X402PaymentDetails> = [
      "x402Version",
      "resource",
      "accepts",
      "selectedRequirement",
      "extensions",
    ];
    for (const field of fields) {
      if (!deepEqual(normalizedExpected[field], normalizedActual[field])) {
        return `${field} mismatch`;
      }
    }
    return "payment identity mismatch";
  }
  return null;
}

export function isResourceForRequest(resource: X402ResourceInfo, requestUrl: string): boolean {
  try {
    const requested = new URL(requestUrl);
    const resourceUrl = new URL(resource.url);
    return resourceUrl.href === requested.href;
  } catch {
    return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
    );
  }
  return false;
}
