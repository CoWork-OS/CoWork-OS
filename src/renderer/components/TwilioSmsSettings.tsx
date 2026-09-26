import { WebhookChannelSettings, type WebhookChannelField } from "./WebhookChannelSettings";

const E164 = /^\+[1-9]\d{6,14}$/;

const FIELDS: WebhookChannelField[] = [
  {
    key: "twilioAccountSid",
    configKey: "accountSid",
    label: "Account SID",
    placeholder: "AC...",
    required: true,
  },
  {
    key: "twilioAuthToken",
    configKey: "authToken",
    label: "Auth Token",
    type: "password",
    hint: "Also used to verify the X-Twilio-Signature on every webhook.",
    required: true,
  },
  {
    key: "twilioFromNumber",
    configKey: "fromNumber",
    label: "Sending Number",
    placeholder: "+15551234567",
    hint: "E.164 format. Leave blank when using a Messaging Service.",
  },
  {
    key: "twilioMessagingServiceSid",
    configKey: "messagingServiceSid",
    label: "Messaging Service SID",
    placeholder: "MG...",
  },
  {
    key: "twilioWebhookPublicUrl",
    configKey: "webhookPublicUrl",
    label: "Public HTTPS Base URL",
    placeholder: "https://your-tunnel.example.com",
    hint: "The public address that forwards to this machine. Twilio signs this exact URL, so it must match what you configure in the Twilio console. If your tunnel URL changes, update it here.",
    required: true,
  },
  {
    key: "webhookPort",
    configKey: "webhookPort",
    label: "Webhook Port",
    type: "number",
    defaultValue: "3983",
  },
  {
    key: "webhookPath",
    configKey: "webhookPath",
    label: "Inbound Path",
    defaultValue: "/twilio-sms/webhook",
  },
  {
    key: "twilioStatusPath",
    configKey: "statusPath",
    label: "Status Callback Path",
    defaultValue: "/twilio-sms/status",
  },
];

export function TwilioSmsSettings({
  onStatusChange,
}: {
  onStatusChange?: (connected: boolean) => void;
}) {
  return (
    <WebhookChannelSettings
      channelType="twilio_sms"
      title="Twilio SMS"
      defaultName="Twilio SMS"
      description={
        <>
          Sends and receives SMS/MMS through Twilio. Inbound messages and delivery receipts arrive
          as signed webhooks, so the port below must be reachable at the public HTTPS base URL.
          Contacts who reply STOP are recorded but never answered.
        </>
      }
      fields={FIELDS}
      validate={(values) => {
        if (!values.twilioFromNumber?.trim() && !values.twilioMessagingServiceSid?.trim()) {
          return "Provide a sending number or a Messaging Service SID.";
        }
        if (values.twilioFromNumber?.trim() && !E164.test(values.twilioFromNumber.trim())) {
          return "The sending number must be in E.164 format, e.g. +15551234567.";
        }
        if (!values.twilioWebhookPublicUrl?.trim().startsWith("https://")) {
          return "The public base URL must start with https://.";
        }
        return null;
      }}
      endpointHint={(config) => {
        const base = String(config.webhookPublicUrl ?? "").replace(/\/+$/, "");
        return (
          <>
            In the Twilio console set &quot;A message comes in&quot; to{" "}
            <code>{`${base}${String(config.webhookPath ?? "/twilio-sms/webhook")}`}</code> (HTTP
            POST). Delivery receipts are requested automatically at{" "}
            <code>{`${base}${String(config.statusPath ?? "/twilio-sms/status")}`}</code>.
          </>
        );
      }}
      onStatusChange={onStatusChange}
    />
  );
}
