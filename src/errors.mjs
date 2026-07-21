export class ConvictionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ConvictionError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) {
    throw new ConvictionError(code, message, details);
  }
}

