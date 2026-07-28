export type ErrorCode =
  | "INVALID_REQUEST"
  | "PATH_OUTSIDE_ROOT"
  | "ROOT_DISABLED"
  | "NOT_FOUND"
  | "NAME_CONFLICT"
  | "FILE_CHANGED"
  | "TOO_LARGE"
  | "UNSUPPORTED_FILE"
  | "READ_ONLY_ROOT"
  | "SEARCH_LIMIT_REACHED"
  | "RESULT_PATH_UNAVAILABLE"
  | "SCAN_JOB_EXPIRED"
  | "SCAN_NOT_READY";

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
