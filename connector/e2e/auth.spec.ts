/**
 * Auth E2E tests - verify JWT admin authentication.
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.CONNECTOR_URL || 'http://localhost:3000';

test.describe('Admin Auth', () => {
  test('rejects unauthenticated requests to admin API', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/users`);
    expect(res.status()).toBe(401);
  });

  test('rejects unauthenticated requests to containers API', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/containers`);
    expect(res.status()).toBe(401);
  });

  test('accepts valid credentials and returns JWT', async ({ request }) => {
    const login = await request.post(`${BASE}/api/admin/login`, {
      data: { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
    });
    expect(login.status()).toBe(200);
    const body = await login.json() as { token: string; expiresIn: string };
    expect(body.token).toBeTruthy();
    expect(body.expiresIn).toBe('8h');
  });

  test('rejects invalid credentials', async ({ request }) => {
    const login = await request.post(`${BASE}/api/admin/login`, {
      data: { username: 'admin', password: 'wrong-password' },
    });
    expect(login.status()).toBe(401);
  });

  test('authenticated request succeeds', async ({ request }) => {
    // Login
    const login = await request.post(`${BASE}/api/admin/login`, {
      data: { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
    });
    const { token } = await login.json() as { token: string };

    // Authenticated request
    const users = await request.get(`${BASE}/api/admin/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(users.status()).toBe(200);
  });
});
