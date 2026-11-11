/**
 * Prompt-injection / abuse scan for inbound general-correspondence mail.
 * Heuristic-first: flags are cheap regex/keyword signals. Any flag forces human
 * review regardless of model confidence — the AI never auto-sends flagged mail.
 * Flags are logged sanitized (flag names only, never the triggering text).
 */

export type InjectionFlag =
  | "ignore_instructions"
  | "system_prompt_probe"
  | "credential_request"
  | "role_spoof"
  | "exfiltration_url"
  | "encoded_payload"
  | "header_injection";

export type InjectionScan = { flagged: boolean; flags: InjectionFlag[] };

const PATTERNS: { flag: InjectionFlag; re: RegExp }[] = [
  {
    flag: "ignore_instructions",
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,60}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|directives?|guidelines?)\b/i,
  },
  {
    flag: "system_prompt_probe",
    re: /\b(system prompt|initial prompt|developer message|you are (now )?(a|an|the)|pretend (to be|you are)|act as (a|an|the)|jailbreak|DAN mode)\b/i,
  },
  {
    flag: "credential_request",
    re: /\b(password|passcode|credentials?|api[-_ ]?key|secret|token|otp|one[- ]time code|credit card|card number|cvv|ssn|social security|bank (account|routing)|reveal|show me|send me|tell me)\b[^.\n]{0,80}\b(password|passcode|credentials?|api[-_ ]?key|secret|token|otp|code|card|cvv|ssn|account|routing)\b/i,
  },
  {
    flag: "role_spoof",
    re: /\b(i am|i'm|this is)\s+(the\s+)?(admin|administrator|staff|developer|owner|founder|ceo|cto|security team|it support|zapnivo (staff|team|admin))\b/i,
  },
  {
    flag: "exfiltration_url",
    re: /https?:\/\/(?![a-z0-9.-]*zapnivo\.com)[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>]*\b(token|key|secret|password|auth|session|credential|data|dump|export)\b/i,
  },
  {
    flag: "encoded_payload",
    re: /(\b[a-zA-Z0-9+/]{200,}={0,2}\b|eval\s*\(|atob\s*\(|fromCharCode|document\.cookie|fetch\s*\(\s*["'`]https?:)/i,
  },
  {
    flag: "header_injection",
    re: /\r?\n\s*(to|cc|bcc|subject|from|reply-to)\s*:/i,
  },
];

/** Pure heuristic scan over subject + body. */
export function scanInjection(subject: string, bodyText: string): InjectionScan {
  const hay = `${subject}\n${bodyText.slice(0, 20_000)}`;
  const flags: InjectionFlag[] = [];
  for (const { flag, re } of PATTERNS) {
    if (re.test(hay) && !flags.includes(flag)) flags.push(flag);
  }
  return { flagged: flags.length > 0, flags };
}
