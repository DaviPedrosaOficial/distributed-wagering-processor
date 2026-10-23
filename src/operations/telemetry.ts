// Métricas locais de observação; nunca são usadas para garantir idempotência.
const labelsText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, v]) =>
        `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    )
    .join(",");

export class Telemetry {
  private readonly counters = new Map<string, number>();
  private readonly latency = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();
  constructor() {
    for (const name of ["wager_lock_conflicts_total", "wager_dlq_total"])
      this.counters.set(name, 0);
    for (const source of ["sqs", "outbox", "reference"])
      this.counters.set(`wager_retries_total{source="${source}"}`, 0);
    for (const channel of ["http", "sqs"])
      this.counters.set(`wager_duplicates_total{channel="${channel}"}`, 0);
  }
  inc(name: string, labels: Record<string, string> = {}): void {
    const text = labelsText(labels);
    const key = name + (text ? `{${text}}` : "");
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  observe(seconds: number, channel: string): void {
    const value = this.latency.get(channel) ?? {
      count: 0,
      sum: 0,
      buckets: [0, 0, 0, 0, 0, 0],
    };
    value.count++;
    value.sum += seconds;
    [0.01, 0.05, 0.1, 0.5, 1, 5].forEach((bound, index) => {
      if (seconds <= bound) value.buckets[index]++;
    });
    this.latency.set(channel, value);
  }
  render(): string {
    const rows = [...this.counters].map(([key, value]) => `${key} ${value}`);
    rows.unshift("# TYPE wager_processing_duration_seconds histogram");
    for (const [channel, value] of this.latency) {
      [0.01, 0.05, 0.1, 0.5, 1, 5].forEach((bound, index) =>
        rows.push(
          `wager_processing_duration_seconds_bucket{${labelsText({ channel, le: String(bound) })}} ${value.buckets[index]}`,
        ),
      );
      rows.push(
        `wager_processing_duration_seconds_bucket{${labelsText({ channel, le: "+Inf" })}} ${value.count}`,
      );
      rows.push(
        `wager_processing_duration_seconds_count{${labelsText({ channel })}} ${value.count}`,
      );
      rows.push(
        `wager_processing_duration_seconds_sum{${labelsText({ channel })}} ${value.sum}`,
      );
    }
    return rows.join("\n") + "\n";
  }
}
export const telemetry = new Telemetry();
export function operationalLog(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }) +
      "\n",
  );
}
