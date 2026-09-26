import { WebhookChannelSettings, type WebhookChannelField } from "./WebhookChannelSettings";

const FIELDS: WebhookChannelField[] = [
  {
    key: "whatsappCloudPhoneNumberId",
    configKey: "phoneNumberId",
    label: "Phone Number ID",
    placeholder: "123456789012345",
    hint: "WhatsApp Manager > API Setup. This is the numeric ID, not the phone number.",
    required: true,
  },
  {
    key: "whatsappCloudAccessToken",
    configKey: "accessToken",
    label: "Access Token",
    type: "password",
    hint: "Use a system-user token; temporary tokens from API Setup expire after 24 hours.",
    required: true,
  },
  {
    key: "whatsappCloudAppSecret",
    configKey: "appSecret",
    label: "App Secret",
    type: "password",
    hint: "Meta app > Settings > Basic. Used to verify every webhook signature.",
    required: true,
  },
  {
    key: "whatsappCloudVerifyToken",
    configKey: "verifyToken",
    label: "Webhook Verify Token",
    type: "password",
    hint: "Any random string of 8+ characters; enter the same value in the Meta webhook setup.",
    required: true,
  },
  {
    key: "whatsappCloudFallbackTemplateName",
    configKey: "fallbackTemplateName",
    label: "Fallback Template Name",
    placeholder: "follow_up_available",
    hint: "Approved template sent (at most once a day per contact) when a contact has not messaged in the last 24 hours. The reply itself is held and delivered as soon as they write back. Without a template, such replies fail with an explanation.",
  },
  {
    key: "whatsappCloudFallbackTemplateLanguage",
    configKey: "fallbackTemplateLanguage",
    label: "Fallback Template Language",
    placeholder: "en_US",
  },
  {
    key: "webhookPort",
    configKey: "webhookPort",
    label: "Webhook Port",
    type: "number",
    defaultValue: "3982",
  },
  {
    key: "webhookPath",
    configKey: "webhookPath",
    label: "Webhook Path",
    defaultValue: "/whatsapp-cloud/webhook",
  },
];

export function WhatsAppCloudSettings({
  onStatusChange,
}: {
  onStatusChange?: (connected: boolean) => void;
}) {
  return (
    <WebhookChannelSettings
      channelType="whatsapp_cloud"
      title="WhatsApp Business"
      defaultName="WhatsApp Business"
      description={
        <>
          Connects a WhatsApp Business number through Meta&apos;s Cloud API. This is separate from
          the personal WhatsApp channel. Meta must reach the webhook over public HTTPS, so expose
          the port below with a tunnel or reverse proxy, then subscribe the app to the{" "}
          <code>messages</code> webhook field.
        </>
      }
      fields={FIELDS}
      endpointHint={(config) => (
        <>
          Local webhook: port {String(config.webhookPort ?? 3982)}, path{" "}
          <code>{String(config.webhookPath ?? "/whatsapp-cloud/webhook")}</code>. Set the Meta
          callback URL to your public HTTPS address plus this path.
        </>
      )}
      onStatusChange={onStatusChange}
    />
  );
}
