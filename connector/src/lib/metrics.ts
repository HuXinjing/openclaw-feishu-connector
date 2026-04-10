/**
 * Prometheus metrics for planC connector observability.
 */
import client from 'prom-client';

const register = new client.Registry();

register.setDefaultLabels({ app: 'feishu-connector' });

client.collectDefaultMetrics({ register });

/** HTTP request counter */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

/** HTTP request duration histogram */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

/** Active users gauge */
export const activeUsersGauge = new client.Gauge({
  name: 'connector_active_users',
  help: 'Number of active users',
  registers: [register],
});

/** Gateway message counter */
export const gatewayMessagesTotal = new client.Counter({
  name: 'gateway_messages_total',
  help: 'Total gateway messages sent',
  labelNames: ['direction', 'status'],
  registers: [register],
});

/** Feishu message counter */
export const feishuMessagesTotal = new client.Counter({
  name: 'feishu_messages_total',
  help: 'Total Feishu messages processed',
  labelNames: ['chat_type', 'status'],
  registers: [register],
});

/** DLQ size gauge */
export const dlqSizeGauge = new client.Gauge({
  name: 'connector_dlq_size',
  help: 'Current DLQ pending count',
  registers: [register],
});

export { register };

export function metricsHandler() {
  return register.metrics();
}

export function getContentType() {
  return register.contentType;
}
