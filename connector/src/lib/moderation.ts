/**
 * Content Moderation — ClawManager security pattern.
 * Regex-based rule engine with block/flag/allow actions.
 */
import type { ModerationRule } from '../types.js';

const DEFAULT_RULES: ModerationRule[] = [
  {
    id: 'pii-email',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    action: 'flag',
    severity: 'medium',
    description: 'Email address detected',
  },
  {
    id: 'pii-phone-cn',
    pattern: '1[3-9]\\d{9}',
    action: 'flag',
    severity: 'medium',
    description: 'Chinese mobile number detected',
  },
  {
    id: 'sql-injection',
    pattern: "('|--|;|DROP|DELETE|INSERT|UNION|SELECT)",
    action: 'block',
    severity: 'high',
    description: 'Potential SQL injection pattern',
  },
];

// Mutable rule set (loaded from env or DB in real impl)
let rules: ModerationRule[] = [...DEFAULT_RULES];

export interface ModerationResult {
  allowed: boolean;
  hits: Array<{ rule: ModerationRule; match: string }>;
}

/**
 * Moderate a text message against the current rule set.
 * Returns immediately on first 'block' hit.
 */
export function moderateMessage(text: string, ruleSet: ModerationRule[] = rules): ModerationResult {
  const hits: Array<{ rule: ModerationRule; match: string }> = [];
  for (const rule of ruleSet) {
    try {
      const re = new RegExp(rule.pattern, 'gi');
      const match = re.exec(text);
      if (match) {
        hits.push({ rule, match: match[0] });
        if (rule.action === 'block') return { allowed: false, hits };
      }
    } catch {
      // Invalid regex — skip rule
    }
  }
  return { allowed: true, hits };
}

/**
 * Get the current moderation rules.
 */
export function getModerationRules(): ModerationRule[] {
  return [...rules];
}

/**
 * Add or replace a moderation rule.
 */
export function addModerationRule(rule: ModerationRule): void {
  rules = rules.filter(r => r.id !== rule.id);
  rules.push(rule);
}

/**
 * Remove a moderation rule by ID.
 */
export function removeModerationRule(ruleId: string): boolean {
  const before = rules.length;
  rules = rules.filter(r => r.id !== ruleId);
  return rules.length < before;
}
