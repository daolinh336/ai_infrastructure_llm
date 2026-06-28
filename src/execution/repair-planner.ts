import type {
  DriftReport,
  RepairAction,
  RepairPlan,
} from '../domain/types.js';

function action(
  kind: RepairAction['kind'],
  risk: RepairAction['risk'],
  resourceName: string,
  reason: string,
): RepairAction {
  return { kind, resourceName, risk, reason };
}

export function buildRepairPlan(report: DriftReport): RepairPlan {
  const actions: RepairAction[] = [];

  for (const finding of report.findings) {
    switch (finding.kind) {
      case 'stopped-container':
        actions.push(action('start-container', 'safe', finding.resourceName, finding.message));
        break;
      case 'running-container':
        actions.push(action('stop-container', 'approval-required', finding.resourceName, finding.message));
        break;
      case 'missing-container':
        actions.push(action('recreate-container', 'approval-required', finding.resourceName, finding.message));
        break;
      case 'missing-image':
        actions.push(action('pull-image', 'safe', finding.resourceName, finding.message));
        break;
      case 'missing-network':
        actions.push(action('create-network', 'safe', finding.resourceName, finding.message));
        break;
      case 'missing-volume':
        actions.push(action('create-volume', 'approval-required', finding.resourceName, finding.message));
        break;
      case 'image-mismatch':
      case 'port-mismatch':
        actions.push(action('recreate-container', 'approval-required', finding.resourceName, finding.message));
        break;
      default:
        break;
    }
  }

  const requiresApproval = actions.some((entry) => entry.risk === 'approval-required');
  const autoRepairable = actions.length > 0 && actions.every((entry) => entry.risk === 'safe');

  return {
    projectName: report.projectName,
    findings: report.findings,
    actions,
    requiresApproval,
    autoRepairable,
  };
}
