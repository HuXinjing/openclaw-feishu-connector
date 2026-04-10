/**
 * Structured pino logger for planC connector.
 * Use this instead of console.log/error/info throughout the codebase.
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({ service: 'planC-connector', pid: process.pid }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
