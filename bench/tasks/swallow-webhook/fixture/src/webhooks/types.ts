export type SendResult = { status: number };
export type Send = (url: string, body: string) => Promise<SendResult>;

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DeliveryError";
  }
}
