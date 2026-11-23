export class UploadNotFoundError extends Error {
  constructor(readonly name_: string) {
    super(`upload not found: ${name_}`);
    this.name = "UploadNotFoundError";
  }
}

export class UploadPathError extends Error {
  constructor(readonly attempted: string) {
    super(`upload path escapes the uploads root: ${attempted}`);
    this.name = "UploadPathError";
  }
}
