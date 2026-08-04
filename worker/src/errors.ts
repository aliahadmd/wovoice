export type ErrorCode =
  | "AUTHENTICATION_FAILED"
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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(error: ApiError, requestId: string): Response {
  return Response.json(
    {
      requestId,
      error: {
        code: error.code,
        retryable: error.retryable,
        message: error.message,
      },
    },
    { status: error.status },
  );
}
