import { describe, it, expect } from 'vitest';
import { getThreadId } from '../src/types.js';
import { buildSessionKey } from '../src/router.js';

describe('getThreadId', () => {
  it('should return thread_id when present', () => {
    const event = {
      sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'user' as const },
      message: {
        message_id: 'm1', chat_id: 'c1', chat_type: 'p2p' as const,
        create_time: '', message_type: 'text' as const, content: '{"text":"hi"}',
        thread_id: 'thr_123',
      },
    } as any;
    expect(getThreadId(event)).toBe('thr_123');
  });

  it('should fall back to root_id', () => {
    const event = {
      sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'user' as const },
      message: {
        message_id: 'm1', chat_id: 'c1', chat_type: 'p2p' as const,
        create_time: '', message_type: 'text' as const, content: '{"text":"hi"}',
        root_id: 'root_456',
      },
    } as any;
    expect(getThreadId(event)).toBe('root_456');
  });

  it('should return undefined when no thread id', () => {
    const event = {
      sender: { sender_id: { open_id: 'ou_test' }, sender_type: 'user' as const },
      message: {
        message_id: 'm1', chat_id: 'c1', chat_type: 'p2p' as const,
        create_time: '', message_type: 'text' as const, content: '{"text":"hi"}',
      },
    } as any;
    expect(getThreadId(event)).toBeUndefined();
  });
});

describe('buildSessionKey', () => {
  it('should include thread id for thread messages', () => {
    const event = {
      message: { thread_id: 'thr_abc', root_id: undefined, parent_id: undefined },
    } as any;
    expect(buildSessionKey('ou_test', event)).toBe('ou_test:thread:thr_abc');
  });

  it('should use dm prefix when no thread', () => {
    const event = {
      message: { thread_id: undefined, root_id: undefined, parent_id: undefined },
    } as any;
    expect(buildSessionKey('ou_test', event)).toBe('dm:ou_test');
  });
});
