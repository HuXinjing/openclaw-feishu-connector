/**
 * Agent message queue — ClawManager reverse heartbeat pattern.
 * Connector enqueues messages here; Gateway Agent picks them up via /agent/heartbeat.
 */
import type { FeishuMessageEvent } from '../types.js';

export interface QueuedMessage {
  eventId: string;
  sessionKey: string;
  content: string;
  chatType: string;
  threadId?: string;
  enqueuedAt: number;
}

// In-memory queue per user
const userMessageQueues = new Map<string, QueuedMessage[]>();

/**
 * Enqueue a Feishu message for the Gateway Agent to poll.
 */
export function enqueueUserMessage(
  openId: string,
  msg: QueuedMessage
): void {
  const queue = userMessageQueues.get(openId) || [];
  queue.push(msg);
  userMessageQueues.set(openId, queue);
}

/**
 * Dequeue all pending messages for a user.
 * Called by the heartbeat handler when Gateway Agent polls.
 */
export function dequeueUserMessages(openId: string): QueuedMessage[] {
  const queue = userMessageQueues.get(openId) || [];
  userMessageQueues.delete(openId);
  return queue;
}

/**
 * Peek at queue length without dequeuing.
 */
export function getQueueLength(openId: string): number {
  return (userMessageQueues.get(openId) || []).length;
}

/**
 * Clear all queues (for testing).
 */
export function clearAllQueues(): void {
  userMessageQueues.clear();
}
