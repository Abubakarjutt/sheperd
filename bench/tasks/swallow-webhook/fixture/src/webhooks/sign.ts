import { createHmac } from "node:crypto";

/** HMAC-SHA256 signature header value for a webhook body. */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
