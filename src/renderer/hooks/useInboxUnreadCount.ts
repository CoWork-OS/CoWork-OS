import { useCallback, useEffect, useRef, useState } from "react";
import type { MailboxDigestSnapshot, MailboxSyncStatus } from "../../shared/mailbox";

/** Unread Inbox count for the workspace, refreshed (debounced) on mailbox events. */
export function useInboxUnreadCount(workspaceId?: string): number {
  const [mailboxDigest, setMailboxDigest] = useState<MailboxDigestSnapshot | null>(null);
  const [mailboxStatus, setMailboxStatus] = useState<MailboxSyncStatus | null>(null);

  const loadMailboxInboxUnread = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getMailboxDigest || !api?.getMailboxSyncStatus) return;
    const [digest, status] = await Promise.all([
      api.getMailboxDigest(workspaceId).catch(() => null),
      api.getMailboxSyncStatus().catch(() => null),
    ]);
    setMailboxDigest(digest);
    setMailboxStatus(status);
  }, [workspaceId]);

  useEffect(() => {
    void loadMailboxInboxUnread();
  }, [loadMailboxInboxUnread]);

  const mailboxEventDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMailboxEvent) return;
    const unsubscribe = api.onMailboxEvent(() => {
      if (mailboxEventDebounceRef.current !== null) {
        clearTimeout(mailboxEventDebounceRef.current);
      }
      mailboxEventDebounceRef.current = setTimeout(() => {
        mailboxEventDebounceRef.current = null;
        void loadMailboxInboxUnread();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (mailboxEventDebounceRef.current !== null) {
        clearTimeout(mailboxEventDebounceRef.current);
      }
    };
  }, [loadMailboxInboxUnread]);

  return mailboxDigest?.unreadCount ?? mailboxStatus?.unreadCount ?? 0;
}
