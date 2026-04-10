/**
 * Feishu @mention event handler.
 * Routes @-bot messages to the standard message handler.
 */
import type { FeishuWebhookEvent } from '../types.js';
import { handleFeishuMessage } from '../router.js';

export async function handleMentionEvent(event: FeishuWebhookEvent): Promise<void> {
  const message = event.event?.message;
  if (!message) return;

  let mentionedOpenIds: string[] = [];
  try {
    const content = JSON.parse(message.content);
    mentionedOpenIds = content.at_ids ? Object.values(content.at_ids) as string[] : [];
  } catch {
    // Non-JSON content, ignore
  }

  const botOpenId = process.env.FEISHU_BOT_OPEN_ID || '';
  if (mentionedOpenIds.length > 0 && botOpenId && mentionedOpenIds.includes(botOpenId)) {
    console.log('[Mention] Bot was mentioned, routing to message handler');
    await handleFeishuMessage(event.event);
  }
}
