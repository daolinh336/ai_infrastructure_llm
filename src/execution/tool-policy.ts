export type ToolPolicyCategory =
  | 'read'
  | 'plan'
  | 'validate'
  | 'preview'
  | 'state'
  | 'mutate'
  | 'destructive';

export interface ToolPolicyContext {
  dryRun: boolean;
  approved: boolean;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
}

export function evaluateToolPolicy(
  category: ToolPolicyCategory,
  context: ToolPolicyContext,
): ToolPolicyDecision {
  if (context.dryRun && (category === 'mutate' || category === 'destructive')) {
    return { allowed: false, reason: 'Dry-run cannot execute runtime mutations.' };
  }

  if ((category === 'mutate' || category === 'destructive') && !context.approved) {
    return { allowed: false, reason: 'Runtime mutation requires approval.' };
  }

  return { allowed: true, reason: 'Tool policy allowed.' };
}
