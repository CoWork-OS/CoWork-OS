/**
 * Default model for a ChatGPT sign-in, based on the plan claim in its access token.
 * Free and Go plans only get GPT-6 Luna; paid plans (or an unknown plan) keep the
 * flagship default.
 */
export function recommendChatGPTModelForPlan(planType: string | undefined | null): string {
  const plan = String(planType || "")
    .trim()
    .toLowerCase();
  return plan === "free" || plan === "go" ? "gpt-6-luna" : "gpt-6-astra";
}
