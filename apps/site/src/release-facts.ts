/**
 * Typed facts about the pinned StreamOtter release, for `/when-it-breaks`, `/releases`,
 * and `/docs`. Every value that the package itself can supply (error codes, states,
 * default limits) is imported from `streamotter/contracts`, not copied by hand, so this
 * file's `Record<ErrorCode, …>` and friends fail `tsc -p apps/site/tsconfig.json` the
 * moment a code, state, or limit key is added or removed upstream. Values that the
 * package does not export (retry behavior, which handler produces which code, the
 * verified support matrix) are hand-authored from the gateway/client source and the
 * public docs at the pinned tag, each with its own `source` URL. See
 * docs/research/release-facts.md for the full source list and open questions.
 *
 * Reading the local StreamOtter checkout is out of scope for this repository: every
 * claim below is checked against the installed `streamotter` package and the GitHub
 * repository's public docs at the release tag, never against `main`.
 */
import pkg from "streamotter/package.json" with { type: "json" };
import {
  DEFAULT_LIMITS, PUBLIC_MESSAGES,
  type ConnectionState, type ErrorCode, type Limits, type SourceStatus, type SubscriptionState,
  type Trace, type TraceStage
} from "streamotter/contracts";

/** The exact version this file describes; read from the installed package, never hand-typed. */
export const RELEASE_VERSION: string = pkg.version;
/** The GitHub tag that version was published from. Every `source` below resolves under this tag. */
export const RELEASE_TAG = `v${RELEASE_VERSION}`;

const REPO = "https://github.com/jfricano/StreamOtter";
const NPM_PACKAGE = "https://www.npmjs.com/package/streamotter";

/** A path inside the StreamOtter repository, pinned to `RELEASE_TAG`. */
function repoFile(path: string): string {
  return `${REPO}/blob/${RELEASE_TAG}/${path}`;
}
/** A doc inside the repository, pinned to `RELEASE_TAG`, with an optional heading anchor. */
function repoDoc(path: string, anchor?: string): string {
  return anchor === undefined ? repoFile(path) : `${repoFile(path)}#${anchor}`;
}
/** The npm page for this exact published version (not the floating "latest" page). */
export const NPM_RELEASE_PAGE = `${NPM_PACKAGE}/v/${RELEASE_VERSION}`;

const V1_API = "docs/V1_API.md";
const IMPLEMENTATION_STATUS = "docs/IMPLEMENTATION_STATUS.md";

// --- Errors ------------------------------------------------------------------------

export interface ErrorVisibility {
  /** What an application sees through the browser SDK: a StateChange, a StreamError from an "error" listener, both, or neither. */
  browserSdk: string;
  /** What appears in the gateway's trace and `SourceStatus.reason`. The trace is only reachable through a development-mode gateway's management API (`streamotter dev`, or a Failure Lab bench's redacted feed) — the production demo gateway exposes no management routes. */
  gatewayTrace: string;
  /** What the operator sees in the gateway's redacted structured logs (`GatewayLogger`); never credentials or payloads. */
  operatorLog: string;
}

export interface ErrorFact {
  /** The package's own public message for this code (`PUBLIC_MESSAGES`), unedited. */
  publicMessage: string;
  /** A longer explanation of what the code means, beyond the one-line public message. */
  meaning: string;
  /** The code's default `retryable` value, as `streamError(code).retryable` returns it. Verified against the package in the test. */
  defaultRetryable: boolean;
  /** Situations where a specific thrown instance overrides the default above, if any. */
  retryableNotes?: string;
  /** The concrete situations that produce this code, in this release. */
  situations: readonly string[];
  visibility: ErrorVisibility;
  sources: readonly string[];
}

export const ERROR_FACTS: Readonly<Record<ErrorCode, ErrorFact>> = {
  UNAUTHENTICATED: {
    publicMessage: PUBLIC_MESSAGES.UNAUTHENTICATED,
    meaning: "The connection has no valid, unexpired identity. This is the gateway's own umbrella code for 'sign in again'; it is distinct from FORBIDDEN, which means a recognized identity may not see this particular channel.",
    defaultRetryable: true,
    retryableNotes: "The package's default for this code is retryable, but the gateway constructs it with retryable:false for every handshake-time rejection (missing/oversized token, authenticate() returning null, an expired principal, or revocation caught at handshake) and for session revocation. It explicitly passes retryable:true only for a session that closes because the principal's own expiresAt was reached — the one case where simply getting a fresh token is expected to work.",
    situations: [
      "authenticate() returns null, or the token is missing or over 8 KiB: handshake rejected before a connection opens.",
      "authenticate() returns a principal whose expiresAt is already in the past: handshake rejected.",
      "A previously open session's principal.expiresAt is reached while connected: the session closes and tells the client to reconnect with a new token.",
      "The application revokes the principal (Gateway.revoke) between handshake and use, or while authorize/snapshot is pending: the session or subscription closes immediately.",
      "Client-side: the authenticated identityKey changes after reconnect() (a different subject/tenant): the SDK closes every prior subscription with UNAUTHENTICATED before the new identity subscribes fresh.",
      "Client-side: getToken() rejects, times out (10 s), or resolves to an empty string: the client enters auth-required."
    ],
    visibility: {
      browserSdk: "A connection 'state' change to auth-required, or a subscription 'state' change to failed with reason UNAUTHENTICATED (account switch); no so:error frame for the handshake-time cases, since the connection never opens.",
      gatewayTrace: "Handshake rejections are not recorded as trace entries (they happen before any channel is involved); a mid-session revocation or expiry is visible only as the session closing, not a Trace row.",
      operatorLog: "None beyond the connection closing; the gateway does not log routine sign-out or expiry."
    },
    sources: [
      repoDoc(V1_API, "7-authentication-and-access-lifecycle"),
      repoDoc(V1_API, "13-implementation-refinements-contract-revision-02"),
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/runtime/session.ts"),
      repoFile("packages/client/src/client.ts")
    ]
  },
  FORBIDDEN: {
    publicMessage: PUBLIC_MESSAGES.FORBIDDEN,
    meaning: "A recognized identity is not permitted to see this specific channel instance. The gateway also reports an unrecognized channel name or an unsupported channel version as FORBIDDEN to the browser, deliberately, so a visitor cannot enumerate which channels or versions exist.",
    defaultRetryable: false,
    situations: [
      "The application's authorize() handler returns anything other than true, at subscribe time, at any resynchronization attempt, or immediately before a snapshot is delivered.",
      "The subscribed channel name does not exist in the deployed project (internally CHANNEL_NOT_FOUND; reported to the browser as FORBIDDEN).",
      "The subscribed channelVersion does not match the one deployed channel version (internally CHANNEL_VERSION_UNSUPPORTED; reported to the browser as FORBIDDEN).",
      "The application revokes access to this exact channel/params for this subject between authorize checks."
    ],
    visibility: {
      browserSdk: "A so:error frame with code FORBIDDEN and a subscription 'state' change to failed; no data is ever sent for that subscription.",
      gatewayTrace: "Stage authorize, outcome rejected. The trace's errorCode is the real cause (FORBIDDEN, CHANNEL_NOT_FOUND, or CHANNEL_VERSION_UNSUPPORTED) even though the browser only ever receives FORBIDDEN.",
      operatorLog: "No warning is logged for an ordinary denial; it is expected traffic, not a fault."
    },
    sources: [
      repoDoc(V1_API, "7-authentication-and-access-lifecycle"),
      repoFile("packages/gateway/src/runtime/session.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts")
    ]
  },
  INVALID_PARAMS: {
    publicMessage: PUBLIC_MESSAGES.INVALID_PARAMS,
    meaning: "The channel parameters on a subscribe request are structurally invalid: not a plain object, over maxParamsBytes once canonically encoded, or a mismatch against the channel's declared parameter schema. This check runs before authorize or any handler, so it never reaches application code.",
    defaultRetryable: false,
    situations: [
      "params is missing, not an object, or fails canonicalization (for example a non-finite number).",
      "The canonical JSON encoding of params exceeds maxParamsBytes.",
      "A parameter value does not satisfy the channel's paramsSchema (wrong type, out of range, or an unlisted enum value)."
    ],
    visibility: {
      browserSdk: "The so:subscribe acknowledgement itself carries {ok:false, error} with code INVALID_PARAMS; the SDK surfaces this as that subscription's failure. No so:state or so:error frame follows, since no subscription was created.",
      gatewayTrace: "None: this is a protocol-layer rejection before any Trace entry is recorded.",
      operatorLog: "None."
    },
    sources: [
      repoDoc(V1_API, "2-configuration-and-generated-application-contracts"),
      repoFile("packages/gateway/src/runtime/session.ts")
    ]
  },
  CHANNEL_NOT_FOUND: {
    publicMessage: PUBLIC_MESSAGES.CHANNEL_NOT_FOUND,
    meaning: "An operator/diagnostic-only code for a subscribe naming a channel absent from the deployed project. It is never sent to a browser; the SDK only ever sees FORBIDDEN for this situation, so a visitor cannot learn which channels exist.",
    defaultRetryable: false,
    situations: ["A subscribe request names a channel that is not one of the project's configured channels."],
    visibility: {
      browserSdk: "Never delivered; the browser receives FORBIDDEN instead.",
      gatewayTrace: "Stage authorize, outcome rejected, errorCode CHANNEL_NOT_FOUND. Visible through GET /management/v1/traces on a development gateway.",
      operatorLog: "None beyond the trace entry."
    },
    sources: [repoDoc(V1_API, "7-authentication-and-access-lifecycle"), repoFile("packages/gateway/src/runtime/session.ts")]
  },
  CHANNEL_VERSION_UNSUPPORTED: {
    publicMessage: PUBLIC_MESSAGES.CHANNEL_VERSION_UNSUPPORTED,
    meaning: "An operator/diagnostic-only code for a subscribe naming a real channel at a version the gateway does not deploy (V1 deploys exactly one version per channel name). Never sent to a browser; the SDK sees FORBIDDEN.",
    defaultRetryable: false,
    situations: ["A subscribe request's channelVersion does not equal the one version the project deploys for that channel name."],
    visibility: {
      browserSdk: "Never delivered; the browser receives FORBIDDEN instead.",
      gatewayTrace: "Stage authorize, outcome rejected, errorCode CHANNEL_VERSION_UNSUPPORTED.",
      operatorLog: "None beyond the trace entry."
    },
    sources: [repoDoc(V1_API, "7-authentication-and-access-lifecycle"), repoFile("packages/gateway/src/runtime/session.ts")]
  },
  SOURCE_UNAVAILABLE: {
    publicMessage: PUBLIC_MESSAGES.SOURCE_UNAVAILABLE,
    meaning: "The public, normalized reason for 'this channel's source is not healthy right now.' Whatever actually paused or degraded the source (a handler throwing, a broker outage, invalid data, a revision conflict) is collapsed to this one code before it reaches an already-active subscriber, so the browser's vocabulary for 'trust me less right now' stays small. The real cause lives in the gateway's trace and in SourceStatus.reason, never in what the subscriber is told.",
    defaultRetryable: true,
    situations: [
      "The source is degraded or paused when a subscription's synchronization attempt begins (a new subscribe, or a retry): the attempt waits in stale, reporting the source's actual current reason if one is known, or SOURCE_UNAVAILABLE otherwise.",
      "An already-live or already-authorizing subscription's source transitions from ready to not-ready (Kafka rebalance, consumer crash, 12 s without fetch/heartbeat activity, or any pause below): every affected subscription is told stale with reason SOURCE_UNAVAILABLE specifically, regardless of the internal cause.",
      "Client-side: the gateway cannot be reached within the connection attempt, the handshake's transport closes before completing, or a control request (unsubscribe/resync) is issued while disconnected."
    ],
    visibility: {
      browserSdk: "A subscription 'state' change to stale with reason SOURCE_UNAVAILABLE only; no so:error frame is sent for a source-caused pause (fail() is never called), so an 'error' listener is not invoked for this case.",
      gatewayTrace: "The trace's errorCode is the true cause, not SOURCE_UNAVAILABLE: for example HANDLER_FAILED (map handler threw), INVALID_PAYLOAD (bad record or bad map output), TIMEOUT (map handler timed out), or REVISION_CONFLICT (two records mapped to the same revision with different data). SourceStatus.reason carries that same true cause.",
      operatorLog: "A warning naming the source, its new status, and the true reason code — for example \"Source not ready\" or \"Source paused on an unprocessable record; it will not be committed or skipped.\""
    },
    sources: [
      repoDoc(V1_API, "13-implementation-refinements-contract-revision-02"),
      repoDoc(V1_API, "6-source-progress-failures-and-flow-control"),
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts"),
      repoFile("packages/gateway/src/sources/kafka.ts")
    ]
  },
  INVALID_PAYLOAD: {
    publicMessage: PUBLIC_MESSAGES.INVALID_PAYLOAD,
    meaning: "Data did not match its declared JSON contract, at one of several boundaries: the raw source record, a map handler's output, or a snapshot handler's return value. Depending on which boundary, this either pauses the whole source (normalized to SOURCE_UNAVAILABLE for other subscribers) or fails just the one subscription asking for a bad snapshot.",
    defaultRetryable: false,
    retryableNotes: "A snapshot that regresses below revision already delivered on that subscription is reported with this code but is treated as a retryable attempt failure (stale, then automatic backoff) rather than an immediate terminal failure — the SDK's automatic-retry decision is separate from the StreamError.retryable flag.",
    situations: [
      "A raw source record is not valid JSON, exceeds maxSourceRecordBytes, or is a tombstone (V1 gives tombstones no meaning): pauses the source.",
      "A map handler's return value is not an array, exceeds maxMapOutputs, or one of its MappedState entries fails validation: pauses the source.",
      "A snapshot handler's return value is not a {revision, data} object, its data fails the channel's payload schema, or its revision is lower than one already delivered on that subscription: fails that subscription's attempt (or, for the regression case, retries it)."
    ],
    visibility: {
      browserSdk: "Source-caused: stale/SOURCE_UNAVAILABLE, no error frame (see SOURCE_UNAVAILABLE above). Snapshot-caused: a so:error with code INVALID_PAYLOAD and state failed for that one subscription, or stale while the retry policy runs for a regression.",
      gatewayTrace: "Stage validate or map (source records) or snapshot (bad snapshot), outcome failed or rejected, errorCode INVALID_PAYLOAD.",
      operatorLog: "A warning with the source ID, record position, and a redacted reason (never the offending payload)."
    },
    sources: [
      repoDoc(V1_API, "6-source-progress-failures-and-flow-control"),
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts")
    ]
  },
  OVERLOADED: {
    publicMessage: PUBLIC_MESSAGES.OVERLOADED,
    meaning: "The gateway or one connection is over a configured limit, not a data or authorization problem. Every situation below is about volume: too many subscriptions, too many control requests, too much unacknowledged data, or a client that stopped confirming receipts.",
    defaultRetryable: true,
    situations: [
      "A connection tries to open more than maxSubscriptionsPerConnection subscriptions.",
      "A connection sends control requests (subscribe/unsubscribe/resync) faster than controlRequestsPerSecond, burst 40.",
      "A subscription's pending byte budget (maxPendingBytesPerSubscription, or the connection/gateway-wide budgets above it) is exhausted before the client acknowledges outstanding frames.",
      "A client does not send a receipt within receiptTimeoutMs (5 s): its whole connection is closed with OVERLOADED."
    ],
    visibility: {
      browserSdk: "A rejected subscribe/control acknowledgement, a subscription 'state' change to stale (buffer overflow, retried with backoff) or resync-required (attempts exhausted), or the whole connection closing (receipt timeout).",
      gatewayTrace: "Stage queue, outcome rejected, errorCode OVERLOADED for a buffer overflow.",
      operatorLog: "None beyond the connection or subscription outcome; this is treated as expected back-pressure, not a fault."
    },
    sources: [
      repoDoc(V1_API, "6-source-progress-failures-and-flow-control"),
      repoFile("packages/gateway/src/runtime/session.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts")
    ]
  },
  RESYNC_REQUIRED: {
    publicMessage: PUBLIC_MESSAGES.RESYNC_REQUIRED,
    meaning: "Automatic synchronization gave up for this incident after maxSyncAttempts (3) tries with 1 s then 2 s backoff. It is not a dead end: calling resync() explicitly starts a fresh attempt.",
    defaultRetryable: true,
    situations: [
      "Three consecutive synchronization attempts failed (source outage, snapshot timeout, or handler failure that keeps recurring) without reaching live.",
      "The SDK detects a protocol violation on delivered frames (a sequence gap, an unexpected future receipt) more times than its retry budget allows."
    ],
    visibility: {
      browserSdk: "A subscription 'state' change to resync-required; ready() and resync() both reject pending waits with this code until resync() is called.",
      gatewayTrace: "The attempts leading up to it each have their own trace entries under their real cause; there is no separate trace row for exhaustion itself.",
      operatorLog: "None beyond the individual attempt failures already logged."
    },
    sources: [
      repoDoc(V1_API, "5-states-and-synchronization"),
      repoFile("packages/gateway/src/runtime/subscription.ts")
    ]
  },
  UNSUPPORTED_CAPABILITY: {
    publicMessage: PUBLIC_MESSAGES.UNSUPPORTED_CAPABILITY,
    meaning: "The client asked for something this protocol version does not have: an unknown Socket.IO event, an unknown field on a known request (protocol forward-compatibility), or a different protocolVersion at handshake.",
    defaultRetryable: false,
    situations: [
      "The socket emits an event other than so:subscribe/so:unsubscribe/so:resync/so:receipt.",
      "A subscribe/unsubscribe/resync payload carries a field the gateway does not recognize (for example a future recovery option).",
      "The handshake's protocolVersion is not 1."
    ],
    visibility: {
      browserSdk: "A rejected control acknowledgement or a handshake connect_error; this would only happen with a mismatched SDK/gateway version, not from normal application use.",
      gatewayTrace: "Not recorded as a Trace row; it is a protocol-layer rejection.",
      operatorLog: "None."
    },
    sources: [
      repoDoc(V1_API, "8-socketio-protocol-v1"),
      repoFile("packages/gateway/src/runtime/session.ts")
    ]
  },
  INVALID_REQUEST: {
    publicMessage: PUBLIC_MESSAGES.INVALID_REQUEST,
    meaning: "The request or frame itself is malformed at the protocol level, independent of channel parameters: a bad UUID, a missing acknowledgement callback, a reused requestId with a different payload, a malformed receipt, or (SDK-detected) a sequence gap or premature receipt.",
    defaultRetryable: false,
    situations: [
      "subscriptionId or requestId is not a UUID, or a control call has no acknowledgement callback.",
      "A requestId already used on this connection is reused with a different payload.",
      "A so:receipt frame is missing a field or has an out-of-range sequence.",
      "A management API trace cursor is malformed (not from a valid page).",
      "Client-side: a data frame arrives with a sequence gap, or a receipt is acknowledged for a frame never sent — the affected subscription fails and needs fresh synchronization."
    ],
    visibility: {
      browserSdk: "A rejected control acknowledgement, an unsolicited so:error, or (for the SDK-detected case) that subscription's failure and a required resynchronization.",
      gatewayTrace: "Not recorded for ordinary malformed requests; the management API's malformed-cursor case is also not itself a Trace row.",
      operatorLog: "None."
    },
    sources: [
      repoDoc(V1_API, "8-socketio-protocol-v1"),
      repoFile("packages/gateway/src/runtime/session.ts"),
      repoFile("packages/gateway/src/runtime/traces.ts")
    ]
  },
  CONFIG_INVALID: {
    publicMessage: PUBLIC_MESSAGES.CONFIG_INVALID,
    meaning: "The gateway's own configuration or handler registry is invalid. This is a deployment/code defect caught at construction or startup, before any listener opens — it can never occur on an open connection and is never sent to a browser.",
    defaultRetryable: false,
    situations: [
      "createGateway() is given an invalid handler registry or invalid development options.",
      "A source references an unknown connection profile, or mode is neither development nor production.",
      "Production configuration is missing a required secret or CA file, or a Kafka connection profile's CA file cannot be read."
    ],
    visibility: {
      browserSdk: "Never; the gateway never finishes starting, so no connection can open.",
      gatewayTrace: "Never; there is no running gateway to record a trace.",
      operatorLog: "The CLI prints the validation issue and exits 2 (invalid configuration) without printing any secret value."
    },
    sources: [
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/sources/kafka.ts")
    ]
  },
  TIMEOUT: {
    publicMessage: PUBLIC_MESSAGES.TIMEOUT,
    meaning: "A deadline elapsed: a server handler (authorize, snapshot, or map) ran past handlerTimeoutMs, snapshot admission took longer than snapshotTimeoutMs, or a client-side wait (ready(), resync(), the initial connect) ran past its own timeout.",
    defaultRetryable: true,
    situations: [
      "A map handler does not settle within handlerTimeoutMs (2,000 ms): pauses the source, normalized to SOURCE_UNAVAILABLE for other subscribers.",
      "An authorize or snapshot handler does not settle within handlerTimeoutMs, or snapshot admission exceeds snapshotTimeoutMs (10,000 ms, including the wait for a free snapshot slot): fails that subscription's attempt (stale, then retried).",
      "Client-side: a ready()/resync() wait, or the client's initial connection wait, exceeds its own timeoutMs."
    ],
    visibility: {
      browserSdk: "Source-caused: stale/SOURCE_UNAVAILABLE. Subscription-attempt-caused: stale, then retried per the backoff policy. Client-side wait: that specific promise rejects with TIMEOUT; the subscription or connection keeps running underneath it.",
      gatewayTrace: "Stage map, authorize, or snapshot, outcome failed, errorCode TIMEOUT.",
      operatorLog: "A warning naming the stage and the source or channel."
    },
    sources: [
      repoDoc(V1_API, "3-server-handlers-and-gateway-lifecycle"),
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts"),
      repoFile("packages/client/src/waiters.ts")
    ]
  },
  CANCELLED: {
    publicMessage: PUBLIC_MESSAGES.CANCELLED,
    meaning: "A purely local, client-side cancellation: an AbortSignal passed to a wait fired, or unsubscribe() cancelled a pending attempt. The gateway is never involved and never sees this code.",
    defaultRetryable: false,
    situations: [
      "The AbortSignal passed to ready()/resync()/the initial connect wait fires before the wait resolves.",
      "unsubscribe() cancels a subscription's in-flight synchronization attempt locally."
    ],
    visibility: {
      browserSdk: "The specific promise rejects with CANCELLED; no network message is sent for this reason.",
      gatewayTrace: "Never; this never reaches the gateway.",
      operatorLog: "Never."
    },
    sources: [repoFile("packages/client/src/waiters.ts"), repoFile("packages/client/src/subscription.ts")]
  },
  CLIENT_CLOSED: {
    publicMessage: PUBLIC_MESSAGES.CLIENT_CLOSED,
    meaning: "A call was made on an SDK client after close(). Entirely local; create a new client instead.",
    defaultRetryable: false,
    situations: ["subscribe(), reconnect(), or a control call runs after close() has already resolved."],
    visibility: {
      browserSdk: "The call throws or rejects synchronously with CLIENT_CLOSED.",
      gatewayTrace: "Never; a closed client has already released its transport.",
      operatorLog: "Never."
    },
    sources: [repoFile("packages/client/src/client.ts"), repoFile("packages/client/src/subscription.ts")]
  },
  HANDLER_FAILED: {
    publicMessage: PUBLIC_MESSAGES.HANDLER_FAILED,
    meaning: "Application handler code threw, rejected, or (for authenticate) returned a malformed result. Which handler failed determines the blast radius: a map failure pauses the whole source and is normalized away for other subscribers; an authorize/snapshot failure only fails the one subscription asking; a listener failure never leaves the browser at all.",
    defaultRetryable: true,
    situations: [
      "map() throws or rejects while processing a source record: pauses the source (nothing is committed or skipped); every other subscription reading that source is told stale with reason SOURCE_UNAVAILABLE, never HANDLER_FAILED directly.",
      "authorize() or snapshot() throws or rejects for one subscription's own attempt: that subscription alone fails terminally with reason HANDLER_FAILED, delivered to the browser directly (no normalization, since it is not a shared-source problem).",
      "authenticate() throws, times out, or returns a value that is not a valid Principal (missing fields, or an expiresAt that is not a finite future timestamp): the handshake is rejected with HANDLER_FAILED.",
      "Client-side, local only: an application's own .on(\"data\") or .on(\"state\") listener throws synchronously or its returned promise rejects: the SDK converts this into a local HANDLER_FAILED and fails that subscription without any round trip to the gateway."
    ],
    visibility: {
      browserSdk: "The map case: only stale/SOURCE_UNAVAILABLE, no direct mention of HANDLER_FAILED. The authorize/snapshot/authenticate and local-listener cases: a so:error (or a locally constructed StreamError) with code HANDLER_FAILED and, for a subscription, state failed.",
      gatewayTrace: "Stage map, authorize, or snapshot, outcome failed, errorCode HANDLER_FAILED — this is the one place the real cause is visible for the map case. Requires a development-mode gateway's management API or a Failure Lab bench's redacted feed; the production demo gateway exposes no trace endpoint.",
      operatorLog: "A warning with the stage, channel or source ID, and the handler's (redacted) error description; for the map case, exactly: \"Source paused on an unprocessable record; it will not be committed or skipped.\" resumeSource() is required after the operator fixes the handler or its data — the paused record is retried, never skipped."
    },
    sources: [
      repoDoc(V1_API, "13-implementation-refinements-contract-revision-02"),
      repoFile("packages/gateway/src/runtime/gateway.ts"),
      repoFile("packages/gateway/src/runtime/subscription.ts"),
      repoFile("packages/client/src/subscription.ts")
    ]
  },
  REVISION_CONFLICT: {
    publicMessage: PUBLIC_MESSAGES.REVISION_CONFLICT,
    meaning: "Two source records mapped to the same channel-instance revision with different canonical data — a mapping or upstream-data bug, not a transient condition. It is the specification's own worked example of a cause that is normalized to SOURCE_UNAVAILABLE for subscribers.",
    defaultRetryable: false,
    situations: ["A record's mapped output has the same revision as one already admitted for that channel instance, but the data differs (a non-idempotent replay or a mapping bug)."],
    visibility: {
      browserSdk: "Only stale/SOURCE_UNAVAILABLE; REVISION_CONFLICT itself never reaches the browser.",
      gatewayTrace: "Stage queue, outcome rejected, errorCode REVISION_CONFLICT; also SourceStatus.reason for the paused source.",
      operatorLog: "A warning naming the source, the position, and the conflicting revision."
    },
    sources: [
      repoDoc(V1_API, "13-implementation-refinements-contract-revision-02"),
      repoDoc(V1_API, "5-states-and-synchronization"),
      repoFile("packages/gateway/src/runtime/gateway.ts")
    ]
  },
  TRACE_CURSOR_EXPIRED: {
    publicMessage: PUBLIC_MESSAGES.TRACE_CURSOR_EXPIRED,
    meaning: "A management-API-only code: a GET /management/v1/traces cursor is from a different gateway run, or older than the retained trace window (maxTraceEntries/maxTraceBytes). Never seen by a browser SDK.",
    defaultRetryable: false,
    situations: ["A trace cursor names a gateway run ID other than the current one, or points before the oldest retained trace."],
    visibility: {
      browserSdk: "Never; browsers do not call the management API.",
      gatewayTrace: "This error is about the trace API itself, so it is not a Trace row; the management API responds 410 with this code.",
      operatorLog: "None beyond the 410 response to whichever tool (workbench, or a Failure Lab bench's trace poller) sent the stale cursor."
    },
    sources: [repoDoc(V1_API, "10-management-api-and-workbench"), repoFile("packages/gateway/src/runtime/traces.ts")]
  },
  INTERNAL: {
    publicMessage: PUBLIC_MESSAGES.INTERNAL,
    meaning: "An unclassified fault with a correlation ID: a management API route throwing unexpectedly, a transport-level error the gateway did not anticipate, or the SDK's last-resort fallback when a terminal frame arrives with no specific reason.",
    defaultRetryable: true,
    situations: [
      "A management API handler throws an error the router did not expect: answered 500 with code INTERNAL.",
      "The Socket.IO transport reports an unexpected middleware error.",
      "Client-side: a subscription's 'failed' or 'closed' frame carries no reason and no other error is on hand."
    ],
    visibility: {
      browserSdk: "A so:error or a locally constructed StreamError with code INTERNAL and a requestId for correlation.",
      gatewayTrace: "Not a distinct stage of its own; whatever stage was running when the unexpected fault occurred.",
      operatorLog: "An error-level log with the correlation ID and a redacted description."
    },
    sources: [repoFile("packages/gateway/src/transport/socketio.ts"), repoFile("packages/gateway/src/management/index.ts")]
  }
};

// --- States ------------------------------------------------------------------------

export interface StateFact {
  description: string;
  sources: readonly string[];
}

export const SUBSCRIPTION_STATE_FACTS: Readonly<Record<SubscriptionState, StateFact>> = {
  idle: {
    description: "Created by subscribe(); its first synchronization attempt is scheduled for the next microtask, so listeners attached synchronously after subscribe() cannot miss it.",
    sources: [repoDoc(V1_API, "4-browser-sdk")]
  },
  authorizing: {
    description: "Running (or awaiting) the authorize() handler for the current attempt. Announced under the previous epoch on a retry, or the empty epoch before the first attempt.",
    sources: [repoDoc(V1_API, "13-implementation-refinements-contract-revision-02")]
  },
  synchronizing: {
    description: "Authorized, the source is ready, and the snapshot handler has been called; buffering live updates behind a captured drain boundary until the snapshot and everything through that boundary reach the SDK.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization")]
  },
  live: {
    description: "Synchronized through the drain boundary while the source stays healthy; full-state updates continue in revision order. This means the channel is caught up to that boundary, not that wall-clock time has passed or that the application has rendered anything.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization")]
  },
  stale: {
    description: "Not currently delivering updates: waiting for the source, retrying after an attempt failure, or told the connection dropped. Comes with a `reason` (an ErrorCode) in every case that has one; a source problem's reason is always the normalized SOURCE_UNAVAILABLE, never the specific cause.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization"), repoDoc(V1_API, "13-implementation-refinements-contract-revision-02")]
  },
  "resync-required": {
    description: "Automatic retries (3 attempts, 1 s then 2 s backoff) were exhausted for this incident. Call resync() to try again explicitly; the wire spelling is exactly 'resync-required'.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization")]
  },
  failed: {
    description: "Terminal: denied (FORBIDDEN) or a handler failed (HANDLER_FAILED, or an invalid snapshot's INVALID_PAYLOAD) for this specific subscription. The subscription is removed server-side; create a new one.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization"), repoDoc(V1_API, "13-implementation-refinements-contract-revision-02")]
  },
  closed: {
    description: "Terminal, no error: unsubscribe() completed, or the owning client closed. Every state can reach closed through cleanup; the specification's diagram abbreviates that.",
    sources: [repoDoc(V1_API, "5-states-and-synchronization")]
  }
};

export const CONNECTION_STATE_FACTS: Readonly<Record<ConnectionState, StateFact>> = {
  idle: {
    description: "createClient() has returned but no connection attempt has started.",
    sources: [repoDoc(V1_API, "4-browser-sdk")]
  },
  connecting: {
    description: "Establishing the Socket.IO transport and completing the authenticated handshake; so:hello must arrive within 10 seconds.",
    sources: [repoDoc(V1_API, "8-socketio-protocol-v1")]
  },
  connected: {
    description: "The handshake completed; subscriptions may begin or continue synchronizing.",
    sources: [repoDoc(V1_API, "4-browser-sdk")]
  },
  reconnecting: {
    description: "The transport was lost and the client is retrying with full-jitter backoff (500 ms base, capped at 30 s) while at least one subscription is active.",
    sources: [repoDoc(V1_API, "4-browser-sdk")]
  },
  "auth-required": {
    description: "getToken() failed or timed out, or the gateway rejected authentication; automatic retries are suspended. Call reconnect() to resume.",
    sources: [repoDoc(V1_API, "4-browser-sdk"), repoDoc(V1_API, "13-implementation-refinements-contract-revision-02")]
  },
  closed: {
    description: "close() was called: permanent. Every subsequent call on this client fails with CLIENT_CLOSED.",
    sources: [repoDoc(V1_API, "4-browser-sdk")]
  }
};

// --- Limits --------------------------------------------------------------------------

/** The package's own defaults, re-exported unmodified so this file can never drift from the numbers it describes. */
export const DEFAULT_LIMIT_VALUES: Readonly<Limits> = DEFAULT_LIMITS;

export interface LimitFact {
  description: string;
  sources: readonly string[];
}

export const LIMIT_FACTS: Readonly<Record<keyof Limits, LimitFact>> = {
  maxConnections: {
    description: "The most connections the gateway accepts at once; PLAN.md's hosted demo starts this at 300, below the package default, to be measured on the real host.",
    sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")]
  },
  maxSubscriptionsPerConnection: {
    description: "The most subscriptions one connection may open; PLAN.md's hosted demo starts this at 12.",
    sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")]
  },
  maxSourceRecordBytes: { description: "The largest raw source record (Kafka value or fixture value) the gateway will decode; larger records pause the source.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxDataFrameBytes: { description: "The largest serialized so:data (or snapshot) frame the gateway will send; a larger snapshot fails that subscription with INVALID_PAYLOAD.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxParamsBytes: { description: "The largest canonical-JSON encoding of a subscribe request's params.", sources: [repoDoc(V1_API, "2-configuration-and-generated-application-contracts")] },
  maxPendingFramesPerSubscription: { description: "How many undelivered frames one subscription may queue before it is treated as overflowing.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxPendingBytesPerSubscription: { description: "The byte budget for one subscription's undelivered frames.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxPendingBytesPerConnection: { description: "The byte budget shared by every subscription on one connection.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxPendingBytesGateway: { description: "The byte budget shared by every connection on the gateway (64 MiB by default); not a bound on total process memory or native broker buffers.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxMapOutputs: { description: "The most MappedState entries one map() call may return for one source record and channel; more pauses the source.", sources: [repoDoc(V1_API, "3-server-handlers-and-gateway-lifecycle")] },
  maxConcurrentSnapshots: { description: "How many snapshot() calls may be in flight at once, gateway-wide; a subscription waits for a slot, counted against its snapshotTimeoutMs.", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  handlerTimeoutMs: { description: "The deadline for one call to authorize(), snapshot(), or map() (2,000 ms by default).", sources: [repoDoc(V1_API, "3-server-handlers-and-gateway-lifecycle")] },
  snapshotTimeoutMs: { description: "The deadline for a subscription's snapshot phase, including the wait for a free snapshot slot (10,000 ms by default).", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  receiptTimeoutMs: { description: "How long the gateway waits for a client to acknowledge a sent frame before closing that connection (5,000 ms by default).", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control")] },
  maxSyncAttempts: { description: "How many synchronization attempts one incident gets (with 1 s then 2 s backoff) before the subscription enters resync-required (3 by default).", sources: [repoDoc(V1_API, "5-states-and-synchronization")] },
  maxTraceEntries: { description: "The most trace rows the gateway retains in memory at once; older rows age out.", sources: [repoDoc(V1_API, "10-management-api-and-workbench")] },
  maxTraceBytes: { description: "The byte budget for retained trace rows.", sources: [repoDoc(V1_API, "10-management-api-and-workbench")] },
  maxControlFrameBytes: { description: "The largest control-channel payload (subscribe/unsubscribe/resync/receipt) the gateway will parse.", sources: [repoDoc(V1_API, "8-socketio-protocol-v1")] },
  controlRequestsPerSecond: { description: "The sustained rate of control requests one connection may make (burst capacity is twice this rate: 20/s sustained, burst 40, by default).", sources: [repoDoc(V1_API, "6-source-progress-failures-and-flow-control"), repoFile("packages/gateway/src/runtime/session.ts")] }
};

// --- Verified support matrix --------------------------------------------------------

export type VerificationStatus = "verified" | "implemented-unverified" | "unverified";

export interface SupportFact {
  component: string;
  detail: string;
  status: VerificationStatus;
  note?: string;
  sources: readonly string[];
}

export const SUPPORT_MATRIX: readonly SupportFact[] = [
  { component: "Node.js", detail: "24.21.0", status: "verified", note: "Full suite; the specification's target version.", sources: [repoDoc(IMPLEMENTATION_STATUS, "environment-used-for-the-results-below")] },
  { component: "Node.js", detail: "26.9.0", status: "verified", note: "Full suite; timings in the status doc are from this version.", sources: [repoDoc(IMPLEMENTATION_STATUS, "environment-used-for-the-results-below")] },
  { component: "Socket.IO (server and client)", detail: "4.8.3", status: "verified", note: "Pinned; server and client kept at the identical version.", sources: [repoDoc(IMPLEMENTATION_STATUS, "environment-used-for-the-results-below")] },
  { component: "KafkaJS", detail: "2.2.4", status: "verified", note: "Pinned behind an internal adapter; two KafkaJS defects at this version are worked around inside it.", sources: [repoDoc(IMPLEMENTATION_STATUS, "decisions-and-deviations-worth-knowing")] },
  { component: "Apache Kafka", detail: "4.1.2, single-node KRaft", status: "verified", note: "The only broker version exercised; other versions are unverified (see the Kafka modes below).", sources: [repoDoc(IMPLEMENTATION_STATUS, "environment-used-for-the-results-below")] },
  { component: "Browsers", detail: "Chromium (automated and manual checks)", status: "verified", sources: [repoDoc(IMPLEMENTATION_STATUS, "limitations-and-open-items")] },
  { component: "Browsers", detail: "Firefox", status: "unverified", note: "Explicitly untested by the package's own test suite.", sources: [repoDoc(IMPLEMENTATION_STATUS, "limitations-and-open-items")] },
  { component: "Browsers", detail: "Safari / WebKit", status: "unverified", note: "Explicitly untested by the package's own test suite.", sources: [repoDoc(IMPLEMENTATION_STATUS, "limitations-and-open-items")] },
  { component: "Reverse proxies", detail: "Caddy (loopback, private CA)", status: "verified", note: "The one proxy exercised; nginx and cloud load balancers are unverified — the package's stated requirements are WebSocket-upgrade forwarding on the socket path and passing the browser's Origin header.", sources: [repoDoc(IMPLEMENTATION_STATUS, "limitations-and-open-items")] }
];

export const KAFKA_MODES: readonly SupportFact[] = [
  { component: "Kafka connection", detail: "Plaintext (development only; rejected in production)", status: "verified", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "TLS with a supplied CA file", status: "verified", note: "Production gateway.", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "TLS + SASL PLAIN", status: "verified", note: "Production gateway.", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "TLS + SASL SCRAM-SHA-256", status: "verified", note: "Production gateway.", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "TLS + SASL SCRAM-SHA-512", status: "verified", note: "Production gateway. This is the mode the hosted Lontra Creek demo uses.", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "TLS with system trust (tls: {})", status: "implemented-unverified", note: "Needs a publicly trusted broker certificate to verify.", sources: [repoDoc(IMPLEMENTATION_STATUS)] },
  { component: "Kafka connection", detail: "Other Kafka broker versions, managed Kafka services, or the repository's Docker Compose alternative", status: "unverified", sources: [repoDoc(IMPLEMENTATION_STATUS)] }
];

// --- Operational timing (not exported by the package; hand-recorded from source) ---

export interface TimingFact {
  name: string;
  ms: number;
  description: string;
  /** Not part of the package's public API — record on every release upgrade (R.1). */
  handCopied: true;
  sources: readonly string[];
}

export const TIMING_FACTS: readonly TimingFact[] = [
  {
    name: "kafkaSourceWatchdogMs",
    ms: 12_000,
    description: "How long a Kafka source can go without fetch/heartbeat activity before the gateway marks it degraded (in addition to rebalance and consumer-crash detection). This constant is internal to the gateway's Kafka adapter, not exported by @streamotter/contracts, so it must be re-checked by hand on every release upgrade rather than imported.",
    handCopied: true,
    sources: [repoFile("packages/gateway/src/sources/kafka.ts"), repoDoc(IMPLEMENTATION_STATUS, "decisions-and-deviations-worth-knowing")]
  },
  {
    name: "kafkaOutageDetectedMeasuredS",
    ms: 13_000,
    description: "The package's own measured time to stale after a broker outage in its verification run (13.0 s), a hair over the 12 s watchdog above; live again within 4.2 s of the broker restart script returning. This is the package's measurement, on its own test hardware — not a claim about the Lontra Creek deployment, which must measure its own timings (see PLAN.md and the E2.0 relay-cut spike).",
    handCopied: true,
    sources: [repoDoc(IMPLEMENTATION_STATUS, "verification-commands-and-results")]
  }
];

// --- The map handler failure: SOURCE_UNAVAILABLE to the visitor, HANDLER_FAILED in the trace ---

export interface MapHandlerFailureFact {
  summary: string;
  cause: ErrorCode;
  sourceStatus: { status: SourceStatus["status"]; reason: ErrorCode };
  trace: { stage: TraceStage; outcome: Trace["outcome"]; errorCode: ErrorCode };
  operatorLog: string;
  visitor: { subscriptionState: SubscriptionState; reason: ErrorCode };
  recovery: string;
  sources: readonly string[];
}

/**
 * The case every failure-mode page must get right: a map() handler throws while
 * processing one source record (the Failure Lab's "fouled sensor" scenario removes a
 * gauge's calibration table so its map handler throws on the next reading). Verified
 * directly against the gateway's source: `#process()` in runtime/gateway.ts calls
 * `pause("map", "HANDLER_FAILED", …)`, which traces stage "map" / outcome "failed" /
 * errorCode "HANDLER_FAILED" and sets `SourceStatus.reason` to "HANDLER_FAILED" — but
 * the subscriber-facing transition in the same function (`#setSourceStatus`) calls
 * `subscription.onSourceUnavailable("SOURCE_UNAVAILABLE")` with that string literal,
 * not the source's real reason. So a visitor already watching that channel sees only
 * stale/SOURCE_UNAVAILABLE; the real cause, HANDLER_FAILED, is visible only in the
 * gateway's trace and SourceStatus — reachable through a development-mode gateway's
 * management API, such as a Failure Lab bench's redacted trace feed, never through the
 * production demo gateway itself.
 */
export const MAP_HANDLER_FAILURE: MapHandlerFailureFact = {
  summary: "A map() handler throws while processing a source record: the source pauses, the visitor's views go stale with SOURCE_UNAVAILABLE, and the gateway's trace shows the real cause, HANDLER_FAILED.",
  cause: "HANDLER_FAILED",
  sourceStatus: { status: "paused", reason: "HANDLER_FAILED" },
  trace: { stage: "map", outcome: "failed", errorCode: "HANDLER_FAILED" },
  operatorLog: "Source paused on an unprocessable record; it will not be committed or skipped.",
  visitor: { subscriptionState: "stale", reason: "SOURCE_UNAVAILABLE" },
  recovery: "The record is neither committed nor skipped. After the operator corrects the handler or the data and calls resumeSource(), the gateway retries that exact record; nothing is lost or replayed out of order. Every subscription waiting on that source resynchronizes once it reports ready.",
  sources: [
    repoDoc(V1_API, "13-implementation-refinements-contract-revision-02"),
    repoDoc(V1_API, "6-source-progress-failures-and-flow-control"),
    repoFile("packages/gateway/src/runtime/gateway.ts")
  ]
};
