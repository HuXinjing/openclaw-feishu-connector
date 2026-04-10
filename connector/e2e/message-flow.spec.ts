/**
 * Message flow E2E tests - verify connector API endpoints.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.CONNECTOR_URL || 'http://localhost:3000';

test.describe('Connector API', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${BASE}/api/admin/login`, {
      data: { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
    });
    if (res.ok()) {
      const body = await res.json() as { token: string };
      token = body.token;
    }
  });

  test('GET /health returns 200', async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  test('GET /healthz returns detailed health', async ({ request }) => {
    const res = await request.get(`${BASE}/healthz`);
    expect(res.status()).toBe(200);
    const body = await res.json() as { ok: boolean; docker: boolean; db: boolean };
    expect(body.ok).toBe(true);
  });

  test('GET /metrics returns Prometheus format', async ({ request }) => {
    const res = await request.get(`${BASE}/metrics`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('connector_active_users');
  });

  test('GET /api/admin/dlq requires auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/dlq`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/admin/dlq with auth returns entries', async ({ request }) => {
    if (!token) test.skip();
    const res = await request.get(`${BASE}/api/admin/dlq`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { entries: unknown[]; stats: { total: number } };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.stats).toBeDefined();
  });

  test('GET /docs serves Swagger UI', async ({ request }) => {
    const res = await request.get(`${BASE}/docs`);
    expect(res.status()).toBe(200);
  });
});
