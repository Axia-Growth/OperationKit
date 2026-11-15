/**
 * Heuristic prompt-injection scanner (obj 900910, systems audit #8).
 *
 * TELEMETRY, NOT THE WALL. This never blocks, rewrites or drops a payload. The
 * wall is the untrusted frame (lib/untrusted-content.ts) plus the tool gates;
 * this only answers "does this payload look like it is trying to steer a
 * model?" so a hit can be written to activity_log (metadata.kind =
 * 'injection_suspect') and an operator can see injection attempts instead of
 * learning about them from a misbehaving bot.
 *
 * Pure and dependency-free so it can run on every boundary. Rules are
 * deliberately conservative phrase patterns (false positives cost one log row;
 * there is no false-negative guarantee). Each rule has a stable id that lands
 * in the log, so a noisy rule can be found and tuned.
 */
import { foldConfusables } from './untrusted-content.js'

export interface InjectionRule {
  id: string
  pattern: RegExp
}

export const INJECTION_RULES: readonly InjectionRule[] = [
  // Classic override phrasing.
  { id: 'ignore_previous', pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?|guidelines?|messages?)\b/i },
  { id: 'new_instructions', pattern: /\b(new|updated|real|actual|revised)\s+(system\s+)?(instructions?|prompt|directives?)\s*:/i },
  { id: 'role_reassignment', pattern: /\byou\s+are\s+now\s+(a|an|the|in)\b|\bact\s+as\s+(an?\s+)?(admin|administrator|root|developer mode|system)\b|\bfrom\s+now\s+on,?\s+you\b/i },
  { id: 'system_prompt_probe', pattern: /\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system\s+prompt|your\s+instructions|hidden\s+prompt)\b/i },
  // Chat-template / role tokens that only matter if someone hopes a model reads them as structure.
  { id: 'chat_template_token', pattern: /<\|(im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?system>|^\s*#{2,}\s*(system|assistant)\s*:?\s*$/im },
  // Forged platform structure (both are neutralised by the frame; the attempt is still worth logging).
  { id: 'forged_frame_marker', pattern: /<{2,}[\W_]*UNTRUSTED[\W_]*CONTENT|END[\W_]*UNTRUSTED[\W_]*CONTENT|UNTRUSTED[\W_]*CONTENT[\W_]*>{2,}/i },
  { id: 'forged_sender_stamp', pattern: /\[\s*cc-sender\s*\]|(?<![A-Za-z])(VERIFIED|DELEGATED)\s*:\s*\S/ },
  // Authority claims aimed at the approval rule.
  { id: 'authority_claim', pattern: /\b(the\s+)?(owner|operator|admin(istrator)?|operator)\s+(has\s+)?(approved|authori[sz]ed|said\s+(it'?s\s+)?(ok|fine))\b|\bthis\s+is\s+(the\s+)?(owner|operator|operator)\b/i },
  // Exfiltration / credential grabs.
  { id: 'credential_request', pattern: /\b(send|give|paste|post|email|share|reveal|print|echo)\b[^.\n]{0,40}\b(api[\s_-]?keys?|passwords?|secrets?|tokens?|credentials?|private\s+keys?|\.env)\b/i },
  { id: 'env_dump', pattern: /\b(printenv|cat\s+[^\s]*\.env\b|env\s*\|\s*curl|echo\s+\$[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD))/ },
  { id: 'pipe_to_shell', pattern: /\b(curl|wget)\b[^\n|]{0,200}\|\s*(ba|z)?sh\b/i },
  { id: 'concealment', pattern: /\b(do\s+not|don'?t|never)\s+(tell|inform|mention\s+(this\s+)?to|alert)\s+(the\s+)?(user|owner|operator|human)\b/i },
]

export interface InjectionScan {
  suspect: boolean
  /** Ids of the rules that matched, in rule order. */
  rules: string[]
  /** A short excerpt around the first match (for the log row; already bounded). */
  excerpt: string | null
}

/** Cap on how much of a payload is scanned — the frame caps what the model sees anyway. */
export const SCAN_MAX_CHARS = 64_000

export function scanForInjection(text: unknown): InjectionScan {
  const s = typeof text === 'string' ? text : text == null ? '' : safeStringify(text)
  // Scan the FOLDED text so a zero-width space or a fullwidth bracket cannot hide
  // a rule match (the frame folds the same way before neutralising).
  const body = foldConfusables(s.slice(0, SCAN_MAX_CHARS))
  const rules: string[] = []
  let excerpt: string | null = null
  for (const r of INJECTION_RULES) {
    const m = r.pattern.exec(body)
    if (!m) continue
    rules.push(r.id)
    if (excerpt === null) {
      const start = Math.max(0, m.index - 40)
      excerpt = body.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim().slice(0, 240)
    }
  }
  return { suspect: rules.length > 0, rules, excerpt }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}
