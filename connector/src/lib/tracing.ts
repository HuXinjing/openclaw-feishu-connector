/**
 * OpenTelemetry distributed tracing initialization.
 * Only starts if OTEL_ENABLED=true (disabled by default to avoid side effects).
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

let sdk: { shutdown(): Promise<void> } | null = null;

export function initTracing() {
  if (process.env.OTEL_ENABLED !== 'true') return;

  // Dynamically import to avoid startup overhead when tracing is disabled
  Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/core'),
  ]).then(([{ NodeSDK }, { OTLPTraceExporter }, { getNodeAutoInstrumentations }, { W3CTraceContextPropagator }]) => {
    const sdkInst = new NodeSDK({
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
      }),
      instrumentations: [getNodeAutoInstrumentations()],
      textMapPropagator: new W3CTraceContextPropagator(),
    });
    sdkInst.start();
    sdk = sdkInst;
    process.on('SIGTERM', () => sdkInst.shutdown());
  }).catch(err => {
    console.error('[Tracing] Failed to initialize OpenTelemetry:', err);
  });
}

export async function shutdownTracing() {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}

export { trace, SpanStatusCode, type Span };
