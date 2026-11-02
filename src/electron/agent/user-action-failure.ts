/**
 * Failure-reason classifier for TaskExecutor step failures.
 *
 * Lives apart from the executor so the patterns can be unit-tested directly:
 * every match here pauses the task and asks the user to act, so a pattern
 * that matches unrelated text stalls recoverable work (#607).
 */

/**
 * Whether a step-failure reason describes a blocker only the user can clear
 * (an approval, a credential, a disconnected integration, a rate-limited
 * external dependency). Recoverable failures return false.
 */
export function isUserActionRequiredFailure(reason: string): boolean {
  const lower = String(reason || "").toLowerCase();
  if (!lower) return false;

  const rateLimitedExternalDependency =
    /\b429\b/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("faucet has run dry") ||
    lower.includes("airdrop limit");

  const integrationActionSignal =
    /\b(connect|reconnect|link|re-link|authorize|re-authorize|enable|configure|set up)\b.*\b(integration|account|provider|channel|wallet|api)\b/.test(
      lower,
    ) ||
    /\b(integration|account|provider|channel|wallet|api)\b.*\b(disconnected|not connected|not configured|missing|required|expired|invalid)\b/.test(
      lower,
    );
  const missingUserSpecificDatesOrYears =
    ((/\b(user'?s|your|my)\b/.test(lower) &&
      /\b(actual|exact|specific)\b/.test(lower) &&
      /\b(date|dates|year|years|tax year|tax years|start date|end date|timeline)\b/.test(
        lower,
      )) ||
      (/\b(include|provide|confirm|state)\b/.test(lower) &&
        /\b(actual|exact|specific)\b/.test(lower) &&
        /\b(date|dates|year|years|tax year|tax years|start date|end date)\b/.test(lower))) &&
    /\b(cannot continue|can't continue|blocked|required|needs to change|what needs to change|missing)\b/.test(
      lower,
    );

  return (
    /action required/.test(lower) ||
    /approve|approval|user denied|denied approval/.test(lower) ||
    integrationActionSignal ||
    missingUserSpecificDatesOrYears ||
    // "auth" only as a word or as the start of authenticate/authorization/
    // unauthorized (and standalone oauth): "author" must not match.
    /\b(auth|authenticat\w*|authoriz\w*|unauthori[sz]ed|oauth|credential\w*|login)\b/.test(
      lower,
    ) ||
    /permission/.test(lower) ||
    /api key|token required/.test(lower) ||
    rateLimitedExternalDependency ||
    // The verb "provide", not "provided"/"provides": an instruction to hand
    // something over, not prose about what something provided.
    /\bprovide\b.*\b(path|value|input)\b/.test(lower)
  );
}
