/**
 * Feishu approval event handler.
 * Handles approval callback events from Feishu.
 */
import type { FeishuWebhookEvent } from '../types.js';

export async function handleApprovalEvent(event: FeishuWebhookEvent): Promise<void> {
  const eventType = event.header?.event_type || '';
  console.log(`[Approval] Received approval event: ${eventType}`);

  // Parse approval event content — approval events have different shape than message events
  const approvalEvent = event.event as unknown as Record<string, unknown>;
  const approvalId = (approvalEvent?.approval_id || (approvalEvent?.approval as Record<string, unknown>)?.approval_id) as string | undefined;

  if (approvalId) {
    console.log(`[Approval] Processing approval: ${approvalId}`);
    // TODO: integrate with approval workflow handler when implemented
  }
}
