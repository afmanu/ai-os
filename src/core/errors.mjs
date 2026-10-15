export class AiOsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AiOsError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new AiOsError(code, message, details);
}

export function asPublicError(error) {
  if (error instanceof AiOsError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
  }
  return { ok: false, error: { code: "INTERNAL_ERROR", message: error.message } };
}
