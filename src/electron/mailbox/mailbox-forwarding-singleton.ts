import type { MailboxForwardingService } from "./MailboxForwardingService";

let activeMailboxForwardingService: MailboxForwardingService | null = null;

export function setMailboxForwardingServiceInstance(
  service: MailboxForwardingService | null,
): void {
  activeMailboxForwardingService = service;
}

export function getMailboxForwardingServiceInstance(): MailboxForwardingService | null {
  return activeMailboxForwardingService;
}
