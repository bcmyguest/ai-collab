/** Minimal OTLP/HTTP protobuf encoder for ExportTraceServiceRequest (spans with scalar attributes); no dependency. */

const varint = (value) => {
  let v = BigInt(value);
  const bytes = [];
  while (v > 0x7fn) { bytes.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  bytes.push(Number(v));
  return Buffer.from(bytes);
};
const tag = (field, wire) => varint((field << 3) | wire);
const bytesField = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const stringField = (field, s) => bytesField(field, Buffer.from(String(s), "utf8"));
const varintField = (field, v) => Buffer.concat([tag(field, 0), varint(v)]);
const fixed64 = (field, ms) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.round(ms)) * 1_000_000n); return Buffer.concat([tag(field, 1), b]); };

function anyValue(v) {
  if (typeof v === "boolean") return varintField(2, v ? 1 : 0);
  if (typeof v === "number" && Number.isInteger(v)) return varintField(3, BigInt.asUintN(64, BigInt(v)));
  if (typeof v === "number") { const b = Buffer.alloc(8); b.writeDoubleLE(v); return Buffer.concat([tag(4, 1), b]); }
  return stringField(1, v);
}
const keyValue = (k, v) => Buffer.concat([stringField(1, k), bytesField(2, anyValue(v))]);

function span({ traceId, spanId, parentSpanId, name, startMs, endMs, attrs = {} }) {
  return Buffer.concat([
    bytesField(1, Buffer.from(traceId, "hex")), bytesField(2, Buffer.from(spanId, "hex")),
    ...(parentSpanId ? [bytesField(4, Buffer.from(parentSpanId, "hex"))] : []), stringField(5, name), varintField(6, 1),
    fixed64(7, startMs), fixed64(8, endMs),
    ...Object.entries(attrs).map(([k, v]) => bytesField(9, keyValue(k, v))),
  ]);
}

/** The request body for POST /v1/traces (Content-Type: application/x-protobuf). */
export function encodeTraceRequest(spans, { project = "ai-collab", service = "ai-collab-analyze", scope: scopeName = "ai-collab.analyze-run-code" } = {}) {
  const resource = bytesField(1, Buffer.concat([
    bytesField(1, keyValue("service.name", service)), bytesField(1, keyValue("openinference.project.name", project)),
  ]));
  const scope = bytesField(1, stringField(1, scopeName));
  const scopeSpans = bytesField(2, Buffer.concat([scope, ...spans.map((s) => bytesField(2, span(s)))]));
  return bytesField(1, Buffer.concat([resource, scopeSpans]));
}
