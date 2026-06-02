/**
 * Shared domain error type for chat4000 logic that returns errors-as-values via
 * neverthrow `Result<T, AppError>` (Production Standards Rule 2). Boundary code
 * that is inherently throwing/event-driven (matrix-js-sdk, the WS gateway, the
 * registrar's fetch) stays exception-based and routes UNEXPECTED failures to the
 * sink; the Result form is for genuine parse/validation/credential-load paths.
 */

export type AppError =
  | { kind: "notFound" }
  | { kind: "decode"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "unexpected"; cause: unknown };
