/**
 * WhatsApp natural command utilities
 *
 * Shared helpers for converting conversational WhatsApp phrases into slash commands.
 */

const PREAMBLE_PATTERNS: RegExp[] = [
  /^@[\w.-]+[,:]?\s+/i,
  /^please\s+/i,
  /^pls\s+/i,
  /^can you please\s+/i,
  /^can you\s+/i,
  /^could you please\s+/i,
  /^could you\s+/i,
  /^would you please\s+/i,
  /^would you\s+/i,
  /^hey\s*,?\s*/i,
  /^hi\s*,?\s*/i,
  /^hello\s*,?\s*/i,
  /^good\s+morning\s*,?\s*/i,
  /^good\s+afternoon\s*,?\s*/i,
  /^good\s+evening\s*,?\s*/i,
];

function stripTrailingQuestionOrExclamation(text: string): string {
  return text.replace(/[!?.,]+$/g, '').trim();
}

export function stripWhatsAppCommandPreamble(text: string): string {
  let normalized = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PREAMBLE_PATTERNS) {
      const next = normalized.replace(prefix, '');
      if (next !== normalized) {
        normalized = next;
        changed = true;
      }
    }
    normalized = normalized.trim();
  }
  return normalized;
}

export function normalizeWhatsAppNaturalCommand(text: string): string | undefined {
  const stripped = stripWhatsAppCommandPreamble(text).trim();
  const normalized = stripTrailingQuestionOrExclamation(stripped).trim();

  if (!normalized || normalized.startsWith('/')) {
    return undefined;
  }

  if (/^(?:help|commands?|menu|show commands?|what can you do|what can i do|what is available)\b/i.test(normalized)) {
    return '/help';
  }

  if (/^(?:self chat|self-chat|selfchat|message yourself)\b/i.test(normalized)) {
    return '/selfchat';
  }
  if (/^(?:enable|turn on|disable|turn off)\s+self[- ]chat\b/i.test(normalized)) {
    return normalized.includes('off') ? '/selfchat off' : '/selfchat on';
  }
  const selfChatMatch = normalized.match(/^(?:set|set to|switch|switch to|enable|disable)\s+self[- ]chat\s*(on|off|yes|no|true|false|enable|disable)\b/i);
  if (selfChatMatch) {
    const value = selfChatMatch[1].toLowerCase();
    if (['off', 'no', 'false', 'disable'].includes(value)) {
      return '/selfchat off';
    }
    return '/selfchat on';
  }

  if (/^(?:ambient mode|ambient|ambiently)\b/i.test(normalized)) {
    return '/ambient';
  }
  if (/^(?:enable|turn on|disable|turn off)\s+ambient(?:\s+mode)?\b/i.test(normalized)) {
    return /(off|disable|turn off)/i.test(normalized) ? '/ambient off' : '/ambient on';
  }
  const ambientMatch = normalized.match(
    /^(?:set|set to|switch|switch to|enable|disable|turn on|turn off)\s+ambient\b\s*(?:mode)?\s*(on|off|yes|no|true|false|enable|disable)\b/i
  );
  if (ambientMatch) {
    const value = ambientMatch[1].toLowerCase();
    if (['off', 'no', 'false', 'disable'].includes(value)) {
      return '/ambient off';
    }
    return '/ambient on';
  }

  if (/^(?:ingest only|ingest|log only|log-mode)\b/i.test(normalized)) {
    return '/ingest';
  }
  const ingestMatch = normalized.match(
    /^(?:set|set to|switch|switch to|enable|disable|turn on|turn off)\s+ingest(?:\s+only)?\b\s*(on|off|yes|no|true|false|enable|disable)?$/i
  );
  if (ingestMatch) {
    const value = ingestMatch[1]?.toLowerCase();
    if (!value) {
      return '/ingest';
    }
    if (['off', 'no', 'false', 'disable'].includes(value)) {
      return '/ingest off';
    }
    return '/ingest on';
  }

  const prefixMatch = normalized.match(/^(?:set|change|use|update)\s+(?:response\s+)?prefix\s+(.+)$/i);
  if (prefixMatch) {
    const value = prefixMatch[1].trim();
    if (value) {
      return `/prefix ${value}`;
    }
  }
  const prefixDisableMatch = normalized.match(/^(?:disable|turn\s+off|clear|remove|reset|none)\s+(?:my\s+)?(?:response\s+)?prefix$/i);
  if (prefixDisableMatch) {
    return '/prefix off';
  }
  if (/^prefix\b/i.test(normalized)) {
    return '/prefix';
  }

  if (/^(?:allowed numbers?|allowed number|number allowlist|allowlist|whitelist|trusted numbers?)\b/i.test(normalized)) {
    return '/numbers';
  }
  const numbersMatch = normalized.match(/^(?:show|list)\s+(?:my\s+)?allowed\s+numbers?\b/i);
  if (numbersMatch) {
    return '/numbers';
  }
  if (/^(?:clear|reset|remove|empty|reset\s+all)\s+(?:my\s+)?(?:number|numbers|allowed numbers?|allowed number|allowlist|whitelist)$/i.test(normalized)) {
    return '/numbers clear';
  }
  const allowMatch = normalized.match(/^(?:allow|add)\s+(?:number|numbers|phone)\s+(.+)$/i);
  if (allowMatch) {
    const value = allowMatch[1].trim();
    if (value) {
      return `/allow ${value}`;
    }
  }
  const allowLooseMatch = normalized.match(/^(?:allow|add)\s+(.+)$/i);
  if (allowLooseMatch) {
    const value = allowLooseMatch[1].trim();
    if (value) {
      return `/allow ${value}`;
    }
  }
  const disallowMatch = normalized.match(/^(?:disallow|remove)\s+(?:number|numbers|phone)\s+(.+)$/i);
  if (disallowMatch) {
    const value = disallowMatch[1].trim();
    if (value) {
      return `/disallow ${value}`;
    }
  }
  const disallowLooseMatch = normalized.match(/^(?:disallow|remove)\s+(.+)$/i);
  if (disallowLooseMatch) {
    const value = disallowLooseMatch[1].trim();
    if (value) {
      return `/disallow ${value}`;
    }
  }

  if (/^(?:start new task|start a task|begin task|open new task|let's start|let's do it|clear the slate|start over|new conversation|reset chat|fresh start|new task|fresh task|new|compact|reset)\b/i.test(normalized)) {
    return '/newtask';
  }

  if (/^(?:start|start the bot|start app|begin|launch|boot)\b/i.test(normalized)) {
    return '/start';
  }

  if (/^(?:status|what(?:'s| is) the status|current status|check status|show status)\b/i.test(normalized)) {
    return '/status';
  }

  if (/^(?:workspaces|list workspaces|show workspaces|workspace list|my workspaces)\b/i.test(normalized)) {
    return '/workspaces';
  }

  if (/^(?:version|build info|app version|what version|version info)\b/i.test(normalized)) {
    return '/version';
  }

  const switchWorkspaceMatch = normalized.match(
    /^(?:switch|set|change|select|choose|move to|use)\s+workspace(?:\s+(?:to|as|for|on)?)?\s+(.+)$/i
  );
  if (switchWorkspaceMatch) {
    const selector = switchWorkspaceMatch[1].trim();
    if (selector) {
      return `/workspace ${selector}`;
    }
  }

  const workspaceMatch = normalized.match(/^workspace\s+(.+)$/i);
  if (workspaceMatch) {
    return `/workspace ${workspaceMatch[1].trim()}`;
  }

  if (/^workspace\b/i.test(normalized)) {
    return '/workspace';
  }

  const addWorkspaceMatch = normalized.match(
    /^(?:add|create|register|connect)\s+(?:a\s+)?(?:workspace|project)\s+(.+)$/i
  );
  if (addWorkspaceMatch) {
    return `/addworkspace ${addWorkspaceMatch[1].trim()}`;
  }

  const addWorkspaceFallbackMatch = normalized.match(
    /^add workspace$/i
  );
  if (addWorkspaceFallbackMatch) {
    return '/addworkspace';
  }

  const removeWorkspaceMatch = normalized.match(
    /^(?:remove|delete|clear|drop|unlink)\s+(?:a\s+)?(?:workspace|project)\s+(.+)$/i
  );
  if (removeWorkspaceMatch) {
    return `/removeworkspace ${removeWorkspaceMatch[1].trim()}`;
  }

  if (/^(?:cancel|stop)\s*[!?.,]*$/i.test(normalized)) {
    return '/cancel';
  }
  if (/^(?:cancel|stop|abort|halt|kill|dismiss|end)\s*(?:current)?\s*task\b/i.test(normalized)) {
    return '/cancel';
  }

  if (/^(?:pause|pause it|pause the task|pause task|pause now|pause execution|hold on|hold on a second|hold on a minute|hold the task|stop for now|stop for the moment|interrupt|interrupt task|suspend|suspend task)\b/i.test(normalized)) {
    return '/pause';
  }

  if (/^(?:resume|resume task|resume now|resume work|continue|continue task|continue work|continue working|unpause|unpause task|carry on|go on|go ahead|pick up|pick up where we left off|go again)\b/i.test(normalized)) {
    return '/resume';
  }

  if (/^(?:what(?:'s| is) the task(?: status)?|what is my task|what's my task|current task|current status|task status|task details|show task|show me the task|my task|my current task|current task snapshot|task snapshot|show my task)\b/i.test(normalized)) {
    return '/task';
  }

  const briefMatch = normalized.match(/^brief(?:\s+(morning|today|tomorrow|week|schedule|unschedule|list))?(?:\s+.*)?$/i);
  if (briefMatch && /^brief/.test(normalized.toLowerCase())) {
    const subcommand = (briefMatch[1] || '').trim();
    return subcommand ? `/brief ${subcommand}` : '/brief';
  }

  const inboxMatch = normalized.match(/^(?:inbox|inbox triage|email triage|triage inbox|mail triage|mailbox)(?:\s+(.*))?$/i);
  if (inboxMatch) {
    const rest = inboxMatch[1]?.trim();
    return rest ? `/inbox ${rest}` : '/inbox';
  }

  const scheduleMatch = normalized.match(/^(?:schedule|remind me|reminder)\s+(.*)$/i);
  if (scheduleMatch) {
    const rest = scheduleMatch[1].trim();
    return rest ? `/schedule ${rest}` : '/schedule';
  }

  const digestMatch = normalized.match(/^(?:digest|summarize|summary|recap|recap chat)(?:\s+(.*))?$/i);
  if (digestMatch) {
    const rest = digestMatch[1]?.trim();
    return rest ? `/digest ${rest}` : '/digest';
  }

  const followupsMatch = normalized.match(
    /^(?:followups|follow-ups|follow ups|follow-up|commitments|follow up|what should i do next)(?:\s+(.*))?$/i
  );
  if (followupsMatch) {
    const rest = followupsMatch[1]?.trim();
    return rest ? `/followups ${rest}` : '/followups';
  }

  if (/^(?:approve|yes|y|yea|yeah|yep|okay|ok|confirm|proceed|sounds good)\b$/i.test(normalized)) {
    return '/yes';
  }

  if (/^(?:deny|no|n|nah|nope|reject)\b$/i.test(normalized)) {
    return '/no';
  }

  if (/^(?:retry|try again|retry that|try it again|run again)\b/i.test(normalized)) {
    return '/retry';
  }

  if (/^(?:history|task history|recent tasks?|past tasks|my tasks)\b/i.test(normalized)) {
    return '/history';
  }

  if (/^(?:queue status|queue list|check queue)\b/i.test(normalized)) {
    return '/queue';
  }

  if (/^(?:show queue|clear queue|empty queue|reset queue)\b/i.test(normalized)) {
    return '/queue clear';
  }

  if (/^(?:always listen|always respond|respond to all|respond always|respond every message|always listen in groups|always all messages)\b/i.test(normalized)) {
    return '/activation always';
  }

  if (/^(?:mention only|only mention|mention mode|respond when mentioned|reply only when mentioned|respond only to mentions|only respond when mentioned)\b/i.test(normalized)) {
    return '/activation mention';
  }

  if (/^(?:command only|commands only|command mode)\b/i.test(normalized)) {
    return '/activation commands';
  }

  const activationMatch = normalized.match(
    /^(?:set|set to|switch|switch to|change|change to|use|enable)\s+(?:group\s+)?(?:activation|group routing|group mode)\s+(always|all|mention|mentions\s*only|mentions|commands\s*only|commands)\b/i
  );
  if (activationMatch) {
    const mode = activationMatch[1].toLowerCase().replace(/\s+/g, '');
    if (mode === 'all' || mode === 'always') {
      return '/activation always';
    }
    if (mode.startsWith('mention')) {
      return '/activation mention';
    }
    if (mode.startsWith('command')) {
      return '/activation commands';
    }
  }

  if (/^(?:models?|list models|available models)\b/i.test(normalized)) {
    return '/models';
  }

  const modelMatch = normalized.match(
    /^(?:set|switch|change|use|select|choose|pick)\s+(?:to\s+)?(?:the\s+)?model\s+(.+)$/i
  );
  if (modelMatch) {
    return `/model ${modelMatch[1].trim()}`;
  }

  const modelDirectMatch = normalized.match(/^model\s+(.+)$/i);
  if (modelDirectMatch) {
    return `/model ${modelDirectMatch[1].trim()}`;
  }

  if (/^(?:providers?|list providers|available providers)\b/i.test(normalized)) {
    return '/providers';
  }

  const providerMatch = normalized.match(
    /^(?:set|switch|change|use|select|choose)\s+(?:to\s+)?(?:the\s+)?provider\s+(.+)$/i
  );
  if (providerMatch) {
    return `/provider ${providerMatch[1].trim()}`;
  }

  const providerDirectMatch = normalized.match(/^provider\s+(.+)$/i);
  if (providerDirectMatch) {
    return `/provider ${providerDirectMatch[1].trim()}`;
  }

  const skillMatch = normalized.match(/^(?:skill|toggle|enable|disable)\s+(.+)$/i);
  if (skillMatch) {
    const value = skillMatch[1].trim();
    if (value) {
      return `/skill ${value}`;
    }
  }

  if (/^(?:skills?|list skills)\b/i.test(normalized)) {
    return '/skills';
  }

  if (/^(?:feedback|comment|opinion)\b/i.test(normalized)) {
    return '/feedback';
  }

  if (/^(?:agents?|assistant list|agent roles?)\b/i.test(normalized)) {
    return '/agent';
  }

  const agentMatch = normalized.match(/^(?:agent|assistant)\s+(clear|reset|default|off)$/i);
  if (agentMatch) {
    return '/agent clear';
  }

  const setAgentMatch = normalized.match(/^(?:agent|assistant)\s+(.+)$/i);
  if (setAgentMatch) {
    const value = setAgentMatch[1].trim();
    if (value) {
      return `/agent ${value}`;
    }
  }

  if (/^(?:settings|preferences|configuration|preferences panel)\b/i.test(normalized)) {
    return '/settings';
  }

  const shellMatch = normalized.match(
    /^(?:enable|turn on|disable|turn off|set)\s+shell\s+(on|off)\b/i
  );
  if (shellMatch) {
    return `/shell ${shellMatch[1].toLowerCase()}`;
  }
  if (/^(?:shell|shell access)\b/i.test(normalized)) {
    return '/shell';
  }

  if (/^(?:debug|debug mode)\b/i.test(normalized)) {
    return '/debug';
  }

  const pairMatch = normalized.match(/^(?:pair|pairing)\s+([A-Z0-9]{6,8})$/i);
  if (pairMatch) {
    return `/pair ${pairMatch[1].toUpperCase()}`;
  }

  if (/^(?:queue clear|clear queue|empty queue|reset queue)\b/i.test(normalized)) {
    return '/queue clear';
  }

  if (/^(?:help me|show help|show me commands|quick start|what can i do on my desktop)\b/i.test(normalized)) {
    return '/help';
  }

  return undefined;
}

export function isLikelyWhatsAppNaturalCommand(text: string): boolean {
  return normalizeWhatsAppNaturalCommand(text) !== undefined;
}
