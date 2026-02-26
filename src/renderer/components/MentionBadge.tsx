import { useState, useEffect } from "react";
import { MentionEvent } from "../../electron/preload";

interface MentionBadgeProps {
  agentRoleId?: string;
  workspaceId?: string;
  onClick?: () => void;
}

export function MentionBadge({ agentRoleId, workspaceId, onClick }: MentionBadgeProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const loadCount = async () => {
      try {
        const query: Any = { status: "pending" };
        if (agentRoleId) {
          query.toAgentRoleId = agentRoleId;
        }
        if (workspaceId) {
          query.workspaceId = workspaceId;
        }
        const mentions = await window.electronAPI.listMentions(query);
        setCount(mentions.length);
      } catch (err) {
        console.error("Failed to load mention count:", err);
      }
    };

    loadCount();

    // Subscribe to real-time mention events
    const unsubscribe = window.electronAPI.onMentionEvent((event: MentionEvent) => {
      if (event.type === "created") {
        // Check if this mention is for our agent
        if (
          event.mention &&
          (!agentRoleId || event.mention.toAgentRoleId === agentRoleId) &&
          (!workspaceId || event.mention.workspaceId === workspaceId)
        ) {
          setCount((prev) => prev + 1);
        }
      } else if (
        event.type === "acknowledged" ||
        event.type === "completed" ||
        event.type === "dismissed"
      ) {
        // Decrement if this mention was pending
        if (
          event.mention &&
          (!agentRoleId || event.mention.toAgentRoleId === agentRoleId) &&
          (!workspaceId || event.mention.workspaceId === workspaceId)
        ) {
          setCount((prev) => Math.max(0, prev - 1));
        }
      }
    });

    return () => unsubscribe();
  }, [agentRoleId, workspaceId]);

  if (count === 0) {
    return null;
  }

  return (
    <span className="mention-badge" onClick={onClick}>
      {count > 99 ? "99+" : count}
      <style>{`
        .mention-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          font-size: 11px;
          font-weight: 600;
          color: white;
          background: #ec4899;
          border-radius: 9px;
          cursor: pointer;
        }

        .mention-badge:hover {
          background: #db2777;
        }
      `}</style>
    </span>
  );
}
