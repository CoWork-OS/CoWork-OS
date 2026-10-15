import { z } from "zod";

export const AndroidDeviceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const AndroidPhoneSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    deviceId: AndroidDeviceIdSchema.optional(),
  })
  .strict();
export type AndroidPhoneSettings = z.infer<typeof AndroidPhoneSettingsSchema>;
export interface AndroidPhoneDevice {
  id: string;
  state: string;
  model: string;
}
export interface AndroidPhoneStatus {
  settings: AndroidPhoneSettings;
  devices: AndroidPhoneDevice[];
  runtimeInstalled: boolean;
  pythonPath: string;
  error?: string;
}
export const AndroidPhoneActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("open_app"),
      package: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/)
        .max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tap"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("swipe"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      toX: z.number().int().nonnegative(),
      toY: z.number().int().nonnegative(),
      durationMs: z.number().int().min(100).max(2000).default(500),
    })
    .strict(),
  // Upstream ADB input text does not support arbitrary Unicode. Refuse rather than corrupt it.
  z
    .object({
      kind: z.literal("type_text"),
      text: z
        .string()
        .min(1)
        .max(2000)
        .regex(/^[\x20-\x7e\n]*$/, "Android input currently supports ASCII text only"),
    })
    .strict(),
  z.object({ kind: z.enum(["home", "back", "recents"]) }).strict(),
]);
export const AndroidPhoneInputSchema = z
  .object({
    deviceId: AndroidDeviceIdSchema,
    snapshotId: z.string().uuid(),
    action: AndroidPhoneActionSchema,
    expected: z
      .object({
        package: z.string().min(1).max(256).optional(),
        text: z.string().min(1).max(512).optional(),
      })
      .strict()
      .refine((v) => !!v.package || !!v.text, "Supply a package or visible text to verify")
      .optional(),
  })
  .strict();
export type AndroidPhoneInput = z.infer<typeof AndroidPhoneInputSchema>;
export interface AndroidPhoneObservation {
  captureId: string;
  deviceId: string;
  createdAt: number;
  width: number;
  height: number;
  package: string | null;
  stateDigest: string;
  typingDigest?: string | null;
  texts: string[];
  elements: {
    text: string;
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    clickable: boolean;
  }[];
  secure: boolean;
  treeAvailable: boolean;
  securityKnown: boolean;
  observationWarning?: string | null;
  imageBase64: string;
  mediaType: "image/png";
  scaleFactor: number;
  target: { appName: string; windowTitle: string };
}
