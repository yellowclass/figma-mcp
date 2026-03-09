// ---------------------------------------------------------------------------
// OpenTelemetry instrumentation setup for CubeAPM
//
// Loaded BEFORE the app via:
//   node --import ./instrumentation.mjs server.mjs
//
// CubeAPM endpoints:
//   Traces  → port 4318  /v1/traces           (standard OTLP HTTP)
//   Metrics → port 3130  /api/metrics/v1/save/otlp  (CubeAPM-specific)
//
// Required env vars (set via K8s deployment):
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   - e.g. http://cubeapm:4318/v1/traces
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  - e.g. http://cubeapm:3130/api/metrics/v1/save/otlp
//   OTEL_SERVICE_NAME                     - defaults to "figma-mcp-server"
//   OTEL_METRICS_EXPORTER                 - set to "otlp"
// ---------------------------------------------------------------------------

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

if (process.env.OTEL_LOG_LEVEL === "debug") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

// Only enable OTEL if a traces endpoint is configured
if (tracesEndpoint) {
  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint,
  });

  const sdkConfig = {
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  };

  // Add metrics exporter if endpoint is configured
  if (metricsEndpoint) {
    sdkConfig.metricReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: metricsEndpoint,
      }),
      exportIntervalMillis: 30_000,
    });
  }

  const sdk = new NodeSDK(sdkConfig);
  sdk.start();

  // Graceful shutdown
  const shutdown = () => {
    sdk
      .shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Use stderr so it doesn't interfere with stdio MCP transport
  process.stderr.write(
    `[figma-mcp] OpenTelemetry enabled → traces: ${tracesEndpoint}, metrics: ${metricsEndpoint || "disabled"}\n`
  );
} else {
  process.stderr.write(
    `[figma-mcp] OpenTelemetry disabled (no OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)\n`
  );
}
