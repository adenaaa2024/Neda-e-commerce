/**
 * Minimal AWS SigV4 signing for Amazon Selling Partner API requests.
 * Uses process env or caller-supplied keys — never log secrets.
 */

import { createHash, createHmac } from "node:crypto";

export type AwsSigningCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export type SignSpApiRequestInput = {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  region?: string;
  service?: string;
  credentials: AwsSigningCredentials;
};

/**
 * Returns headers to merge into fetch (Authorization, x-amz-date, host, optional session token).
 */
export function signSpApiRequest(input: SignSpApiRequestInput): Record<string, string> {
  const method = input.method.toUpperCase();
  const host = input.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const region = input.region?.trim() || "us-east-1";
  const service = input.service?.trim() || "execute-api";
  const body = input.body ?? "";
  const payloadHash = sha256Hex(body);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);

  const qp = new URLSearchParams(input.query ?? {});
  const canonicalQuery = [...qp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const baseHeaders: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    ...(input.headers ?? {}),
  };
  if (input.credentials.sessionToken?.trim()) {
    baseHeaders["x-amz-security-token"] = input.credentials.sessionToken.trim();
  }

  const signedHeaderNames = Object.keys(baseHeaders)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((k) => {
      const orig = Object.keys(baseHeaders).find((h) => h.toLowerCase() === k) ?? k;
      return `${k}:${String(baseHeaders[orig]).trim()}\n`;
    })
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = signingKey(input.credentials.secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  const authorization = [
    "AWS4-HMAC-SHA256 Credential=",
    `${input.credentials.accessKeyId}/${credentialScope}`,
    `, SignedHeaders=${signedHeaders}`,
    `, Signature=${signature}`,
  ].join("");

  return {
    ...baseHeaders,
    Authorization: authorization,
  };
}
