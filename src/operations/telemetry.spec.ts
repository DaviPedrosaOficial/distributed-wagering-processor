import { expect, test } from "bun:test";
import { Telemetry } from "./telemetry.js";

test("métricas contam duplicatas e expõem histograma cumulativo de duração", () => {
  const metrics = new Telemetry();
  metrics.inc("wager_duplicates_total", { channel: "http" });
  metrics.observe(0.03, "http");
  metrics.observe(0.2, "http");
  const text = metrics.render();
  expect(text).toContain('wager_duplicates_total{channel="http"} 1');
  expect(text).toContain(
    'wager_processing_duration_seconds_bucket{channel="http",le="0.05"} 1',
  );
  expect(text).toContain(
    'wager_processing_duration_seconds_bucket{channel="http",le="0.5"} 2',
  );
  expect(text).toContain(
    'wager_processing_duration_seconds_count{channel="http"} 2',
  );
});
