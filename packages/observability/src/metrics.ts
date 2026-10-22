// Prometheus text format (version 0.0.4) from our own registry: counters and gauges, no
// histograms yet. ~50 lines instead of prom-client (ADR 008 rule 1), which brings default
// process collectors and a cluster aggregator we do not need. Never a tenant id as a label:
// cardinality grows with every customer and the scrape would list their names.

type Labels = Record<string, string>;

interface Series {
  type: 'counter' | 'gauge';
  help: string;
  values: Map<string, number>;
}

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(',');

export class Metrics {
  readonly #series = new Map<string, Series>();

  #define(name: string, type: Series['type'], help: string): Series {
    const existing = this.#series.get(name);
    if (existing) return existing;
    const series: Series = { type, help, values: new Map() };
    this.#series.set(name, series);
    return series;
  }

  counter(name: string, help: string) {
    const s = this.#define(name, 'counter', help);
    return {
      inc(labels: Labels = {}, by = 1) {
        const k = key(labels);
        s.values.set(k, (s.values.get(k) ?? 0) + by);
      },
    };
  }

  gauge(name: string, help: string) {
    const s = this.#define(name, 'gauge', help);
    return { set: (value: number, labels: Labels = {}) => void s.values.set(key(labels), value) };
  }

  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.#series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      for (const [labels, value] of s.values)
        out.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }
    return out.join('\n') + '\n';
  }
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
