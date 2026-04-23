import { tmpdir } from "node:os";
import { join } from "node:path";

export const INTERCEPT_COMMAND_NAME = "intercept";
export const UNKNOWN_SESSION_ID = "unknown-session";
export const INTERCEPT_DUMP_ROOT = join(tmpdir(), "opencode-interceptor");
export const INTERCEPT_RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const INTERCEPT_USAGE = "Usage: `/intercept`, `/intercept on`, or `/intercept off`.";

export const INTERCEPT_STATUS_TITLE = "## Interceptor Status";
export const INTERCEPT_ENABLED_TITLE = "## Interceptor Enabled";
export const INTERCEPT_DISABLED_TITLE = "## Interceptor Disabled";
export const INTERCEPT_USAGE_TITLE = "## Interceptor Usage";

export const INTERCEPT_CAPTURE_SEQUENCE_PAD = 3;
export const INTERCEPT_REQUEST_FILE_SUFFIX = ".request.json";
export const INTERCEPT_RESPONSE_FILE_SUFFIX = ".response.json";
export const INTERCEPT_META_FILE_SUFFIX = ".meta.json";
