import { z } from 'zod';

/** Any JSON-serializable value: safe to write to `run.json` or send to an LLM. */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

/** A JSON object with string keys, e.g. the `details` of an error. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
