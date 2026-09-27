import assert from "node:assert/strict";
import { describe, test } from "node:test";
import installedPackage from "streamotter/package.json" with { type: "json" };
import { DEFAULT_LIMITS, ERROR_CODES, streamError, type ErrorCode } from "streamotter/contracts";
import {
  CONNECTION_STATE_FACTS, DEFAULT_LIMIT_VALUES, ERROR_FACTS, KAFKA_MODES, LIMIT_FACTS, MAP_HANDLER_FAILURE,
  NPM_RELEASE_PAGE, RELEASE_TAG, RELEASE_VERSION, SUBSCRIPTION_STATE_FACTS, SUPPORT_MATRIX, TIMING_FACTS
} from "../src/release-facts.ts";

/**
 * Recursively collects every string value reachable from `value`. Facts are plain
 * data (records, arrays, and small objects of strings/booleans/numbers), so a generic
 * walk finds every `source`/`sources` URL without hand-listing each fact's shape here
 * — the same property that makes new facts automatically covered by the checks below.
 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

const REPO_BLOB_PREFIX = "https://github.com/jfricano/StreamOtter/blob/";
const NPM_PACKAGE_PREFIX = "https://www.npmjs.com/package/streamotter";

describe("release identity", () => {
  test("RELEASE_VERSION is read from the installed package, not hand-typed", () => {
    assert.equal(RELEASE_VERSION, installedPackage.version);
    assert.equal(RELEASE_TAG, `v${installedPackage.version}`);
  });

  test("the npm release page names this exact version, not the floating latest page", () => {
    assert.equal(NPM_RELEASE_PAGE, `${NPM_PACKAGE_PREFIX}/v/${RELEASE_VERSION}`);
  });
});

describe("every source URL points at the release tag", () => {
  const modules = { ERROR_FACTS, SUBSCRIPTION_STATE_FACTS, CONNECTION_STATE_FACTS, LIMIT_FACTS, SUPPORT_MATRIX, KAFKA_MODES, TIMING_FACTS, MAP_HANDLER_FAILURE };

  test("every github.com/jfricano/StreamOtter/blob/... URL uses the pinned tag", () => {
    const urls = collectStrings(modules).filter(value => value.startsWith(REPO_BLOB_PREFIX));
    assert.ok(urls.length > 0, "expected at least one repository source URL");
    for (const url of urls) {
      assert.ok(
        url.startsWith(`${REPO_BLOB_PREFIX}${RELEASE_TAG}/`),
        `${url} does not point at ${RELEASE_TAG}`
      );
    }
  });

  test("no source URL points at a branch (main) or a different tag", () => {
    const urls = collectStrings(modules).filter(value => value.startsWith("https://github.com/jfricano/StreamOtter/"));
    for (const url of urls) {
      assert.ok(!url.includes("/blob/main/"), `${url} points at main, not the pinned release`);
    }
  });

  test("every npm source URL names the pinned version", () => {
    const urls = collectStrings(modules).filter(value => value.startsWith(NPM_PACKAGE_PREFIX));
    for (const url of urls) {
      assert.ok(url.includes(RELEASE_VERSION), `${url} does not name ${RELEASE_VERSION}`);
    }
  });

  test("every fact object exposes at least one source URL", () => {
    for (const [name, record] of Object.entries({ ERROR_FACTS, SUBSCRIPTION_STATE_FACTS, CONNECTION_STATE_FACTS, LIMIT_FACTS })) {
      for (const [key, fact] of Object.entries(record as Record<string, { sources?: readonly string[] }>)) {
        assert.ok(fact.sources !== undefined && fact.sources.length > 0, `${name}.${key} has no source`);
      }
    }
    for (const [name, list] of Object.entries({ SUPPORT_MATRIX, KAFKA_MODES, TIMING_FACTS })) {
      for (const fact of list as readonly { sources: readonly string[] }[]) {
        assert.ok(fact.sources.length > 0, `an entry in ${name} has no source`);
      }
    }
    assert.ok(MAP_HANDLER_FAILURE.sources.length > 0, "MAP_HANDLER_FAILURE has no source");
  });
});

describe("error facts cover exactly the package's ErrorCode union", () => {
  test("ERROR_FACTS has exactly the codes ERROR_CODES lists", () => {
    assert.deepEqual(Object.keys(ERROR_FACTS).sort(), (ERROR_CODES as readonly string[]).slice().sort());
  });

  test("every fact's defaultRetryable matches the package's own default for that code", () => {
    for (const code of ERROR_CODES) {
      const fact = ERROR_FACTS[code as ErrorCode];
      assert.equal(
        fact.defaultRetryable,
        streamError(code as ErrorCode).retryable,
        `ERROR_FACTS.${code}.defaultRetryable does not match streamError("${code}").retryable`
      );
    }
  });

  test("every fact's publicMessage is the package's own message, not a paraphrase", () => {
    for (const code of ERROR_CODES) {
      assert.equal(ERROR_FACTS[code as ErrorCode].publicMessage, streamError(code as ErrorCode).message);
    }
  });
});

describe("limits cover exactly the package's Limits keys", () => {
  test("LIMIT_FACTS and DEFAULT_LIMIT_VALUES have exactly DEFAULT_LIMITS's keys", () => {
    const keys = Object.keys(DEFAULT_LIMITS).sort();
    assert.deepEqual(Object.keys(LIMIT_FACTS).sort(), keys);
    assert.deepEqual(Object.keys(DEFAULT_LIMIT_VALUES).sort(), keys);
  });

  test("DEFAULT_LIMIT_VALUES is the package's own object, not a copy that can drift", () => {
    assert.deepEqual(DEFAULT_LIMIT_VALUES, DEFAULT_LIMITS);
  });
});

describe("the map handler failure case matches the gateway's actual behavior", () => {
  test("the visitor sees SOURCE_UNAVAILABLE while the gateway's own trace shows HANDLER_FAILED", () => {
    assert.equal(MAP_HANDLER_FAILURE.cause, "HANDLER_FAILED");
    assert.equal(MAP_HANDLER_FAILURE.trace.errorCode, "HANDLER_FAILED");
    assert.equal(MAP_HANDLER_FAILURE.sourceStatus.reason, "HANDLER_FAILED");
    assert.equal(MAP_HANDLER_FAILURE.visitor.subscriptionState, "stale");
    assert.equal(MAP_HANDLER_FAILURE.visitor.reason, "SOURCE_UNAVAILABLE");
    assert.notEqual(MAP_HANDLER_FAILURE.visitor.reason, MAP_HANDLER_FAILURE.cause);
  });
});
