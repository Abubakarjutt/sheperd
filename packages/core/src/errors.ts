export class RewireError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "RewireError";
    this.code = code;
    this.hint = hint;
  }
}
