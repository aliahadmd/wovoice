export type ErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTH_REQUIRED"
  | "TOKEN_EXPIRED"
  | "INVALID_CODE"
  | "EMAIL_RATE_LIMITED"
  | "EMAIL_SEND_FAILED"
  | "USER_QUOTA_EXCEEDED"
  | "SERVICE_DAILY_LIMIT_REACHED"
  | "SYNC_CONFLICT"
  | "ADMIN_REQUIRED"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_BANNED"
  | "INVALID_STATUS_TRANSITION"
  | "UPGRADE_REQUIRED"
  | "INVALID_REQUEST"
  | "INVALID_AUDIO"
  | "AUDIO_TOO_LONG"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INFERENCE_FAILED"
  | "INFERENCE_TIMEOUT"
  | "NOT_FOUND";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(error: ApiError, requestId: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (error.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", error.retryAfterSeconds.toString());
  }
  return Response.json(
    {
      requestId,
      error: {
        code: error.code,
        retryable: error.retryable,
        message: error.message,
      },
    },
    { status: error.status, headers },
  );
}
