import { z } from "zod";
import {
  AndroidPhoneInputSchema,
  type AndroidPhoneInput,
  type AndroidPhoneObservation,
} from "../../shared/android-phone";
import type { ApplicationResource, ApplicationResult } from "../../shared/application-execution";
import type { ApplicationAdapter, ApplicationAdapterContext } from "./ApplicationAdapterCatalog";
import type { PhoneBridgeReply } from "../phone/AndroidPhoneService";

export function androidPhoneResources(input: AndroidPhoneInput): ApplicationResource[] {
  return [
    {
      kind: "application_state",
      system: "android-phone",
      identity: input.deviceId,
    },
  ];
}
type PhoneState = {
  observation: AndroidPhoneObservation;
  receipt?: PhoneBridgeReply["receipt"];
};
export function androidPhoneUnmet(input: AndroidPhoneInput, state: PhoneState): string[] {
  const unmet: string[] = [];
  if (state.receipt?.status !== "completed")
    unmet.push("No completed receipt for the original action; do not replay");
  if (state.observation.deviceId !== input.deviceId) unmet.push("Device identity differs");
  if (!input.expected)
    unmet.push("No domain outcome criterion supplied; input dispatch alone is unverified");
  if (input.expected?.package && state.observation.package !== input.expected.package)
    unmet.push("Expected foreground package is not present");
  if (
    input.expected?.text &&
    !state.observation.texts.some((text) => text.includes(input.expected!.text!))
  )
    unmet.push("Expected visible text is not present");
  return unmet;
}
export function createAndroidPhoneAdapter(): ApplicationAdapter {
  const input = (context: ApplicationAdapterContext) =>
    AndroidPhoneInputSchema.parse(context.operation.request.input);
  const collect = async (context: ApplicationAdapterContext, mode: "action" | "reconcile") =>
    (await context.tools.call(
      mode === "action" ? "android_phone_dispatch" : "android_phone_readback",
      input(context),
      context,
    )) as PhoneState;
  const result = (context: ApplicationAdapterContext, state: PhoneState): ApplicationResult => {
    const request = input(context);
    const {
      captureId,
      deviceId,
      createdAt,
      package: packageName,
      stateDigest,
      width,
      height,
      secure,
    } = state.observation;
    // Keep durable records small. Screen pixels/text remain in the private capture store.
    const observation = {
      captureId,
      deviceId,
      createdAt,
      package: packageName,
      stateDigest,
      width,
      height,
      secure,
    };
    return {
      kind: "application_state",
      summary: `Android ${request.action.kind} on ${request.deviceId}`,
      resources: androidPhoneResources(request),
      data: {
        observation: JSON.parse(JSON.stringify(observation)),
        receipt: JSON.parse(JSON.stringify(state.receipt ?? null)),
      },
      unmetCriteria: androidPhoneUnmet(request, state),
    };
  };
  return {
    route: {
      id: "phone.android.v1",
      adapterId: "phone-harness-android",
      adapterVersion: "0.3.2-1",
      capability: "phone.android.action",
      protocol: "cli",
      control: "structured",
      environment: {
        id: "local-adb",
        kind: "local",
        locality: "local",
        background: true,
        isolated: false,
      },
      resourceKinds: ["application_state"],
      effect: "write",
      preparationEffect: "read",
      replay: "never",
      qualified: false,
      callTimeoutMs: 120_000,
      supports: {
        prepare: true,
        observe: true,
        cancel: false,
        verify: true,
        conditionalWrite: false,
        remoteFencing: false,
      },
      description:
        "Android phone-harness: explicit selected device, fresh task-owned screen, per-action approval, durable receipts and readback. Never replay uncertain input. Verification proves only supplied visible-text/package criteria, not remote transaction success. No arbitrary scripts, password/PIN entry, cloud rental or device switching.",
      inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(AndroidPhoneInputSchema))),
    },
    validateInput(raw, resources) {
      const request = AndroidPhoneInputSchema.parse(raw);
      if (JSON.stringify(resources) !== JSON.stringify(androidPhoneResources(request)))
        throw new Error("Phone operations require the exact selected device resource");
    },
    async readiness() {
      return { ready: true };
    },
    async prepare(context) {
      return {
        kind: "summary",
        summary: `Proposed Android action: ${JSON.stringify(input(context))}`,
        references: [input(context).deviceId],
        payload: JSON.parse(JSON.stringify(input(context))),
        expiresAt: Date.now() + 120_000,
      };
    },
    async execute(context) {
      const state = await collect(context, "action");
      if (state.receipt?.status !== "completed")
        return {
          status: "unknown",
          summary: "The original phone action has no completed receipt. Observe without replay.",
        };
      return { status: "completed", result: result(context, state) };
    },
    async authorize(context) {
      await context.tools.call("android_phone_authorize", input(context), context);
    },
    async observe(context) {
      const state = await collect(context, "reconcile");
      if (state.receipt?.status !== "completed")
        return {
          status: "unknown",
          summary:
            "Phone input may have applied; no completed original receipt. Human reconciliation is required.",
        };
      return { status: "completed", result: result(context, state) };
    },
    async verify(context) {
      const state = await collect(context, "reconcile");
      const unmet = androidPhoneUnmet(input(context), state);
      return {
        status: unmet.length ? "unavailable" : "verified",
        result: result(context, state),
        summary: unmet.length
          ? unmet.join("; ")
          : "Fresh selected-device readback matches the requested visible outcome",
        checkedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        evidence: [
          {
            source: `android:${input(context).deviceId}:${state.observation.captureId}`,
            claim: `Package ${state.observation.package}; screen digest ${state.observation.stateDigest}. This proves visible state only.`,
          },
        ],
      };
    },
  };
}
