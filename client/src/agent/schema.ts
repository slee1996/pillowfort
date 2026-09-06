export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface Schema {
  type?: "object" | "array" | "string" | "boolean" | "integer" | "number";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: (string | boolean | number)[];
  const?: boolean | number | string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}
export class AgentError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}
export const object = (properties: Record<string, Schema> = {}, required = Object.keys(properties)): Schema =>
  ({ type: "object", properties, required, additionalProperties: false });
export const text = (maxLength: number, minLength = 1): Schema => ({ type: "string", minLength, maxLength });
export const choice = (...values: string[]): Schema => ({ type: "string", enum: values });
export const confirm: Schema = { type: "boolean", const: true, description: "Explicit caller confirmation. This is not proof of human consent." };
export function validate(value: unknown, schema: Schema, path = "input"): void {
  const invalid = (reason: string): never => { throw new AgentError("invalid-input", `${path}: ${reason}`); };
  if (schema.const !== undefined && value !== schema.const) invalid(`must equal ${String(schema.const)}`);
  if (schema.enum && !schema.enum.some(item => item === value)) invalid(`must be one of ${schema.enum.join(", ")}`);
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("must be an object");
      const record = value as Record<string, unknown>;
      for (const key of Reflect.ownKeys(record)) {
        if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) invalid("contains an unknown property");
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) invalid("must contain only data properties");
        validate(descriptor.value, schema.properties![key as string], `${path}.${String(key)}`);
      }
      for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(record, key)) invalid(`requires ${key}`);
      break;
    }
    case "string":
      if (typeof value !== "string") invalid("must be a string");
      else {
        let length = 0;
        for (const _character of value) length++;
        if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) invalid("length outside allowed range");
        if (/\p{Cs}/u.test(value) || value !== value.normalize("NFC")) invalid("must be valid NFC Unicode");
        if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) invalid("does not match the documented pattern");
      }
      break;
    case "integer": case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (schema.type === "integer" && !Number.isSafeInteger(value))) invalid(`must be a finite ${schema.type}`);
      else if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid("outside allowed range");
      break;
    case "boolean": if (typeof value !== "boolean") invalid("must be boolean"); break;
    case "array":
      if (!Array.isArray(value)) invalid("must be an array");
      else {
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) invalid("array length outside allowed range");
        for (let index = 0; index < value.length; index++) validate(value[index], schema.items!, `${path}[${index}]`);
      }
      break;
  }
}
