import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCleanVersion,
  compareSemver,
  GITHUB_RELEASES_FALLBACK_URL,
  getOrSetOutdatedFirstSeen,
  computeGraceState,
} from "./versionCheck";

describe("versionCheck utilities", () => {
  it("extracts clean semver versions from tags and strings", () => {
    assert.equal(extractCleanVersion("v1.1.1"), "1.1.1");
    assert.equal(extractCleanVersion("Buzz - v1.0.0"), "1.0.0");
    assert.equal(extractCleanVersion("Release 1.2.3.4"), "1.2.3.4");
    assert.equal(extractCleanVersion(""), null);
    assert.equal(extractCleanVersion(null), null);
  });

  it("compares semantic versions accurately", () => {
    assert.equal(compareSemver("1.1.1", "1.1.0"), 1);
    assert.equal(compareSemver("1.1.0", "1.1.1"), -1);
    assert.equal(compareSemver("v1.1.1", "1.1.1"), 0);
    assert.equal(compareSemver("1.10.0", "1.2.0"), 1);
    assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
  });

  it("uses a direct .apk download fallback URL instead of an HTML release page", () => {
    assert.ok(GITHUB_RELEASES_FALLBACK_URL.endsWith(".apk"));
    assert.ok(!GITHUB_RELEASES_FALLBACK_URL.endsWith("/releases/latest"));
  });

  it("preserves earliest outdated timestamp across newer release bumps and enforces lock after grace period", () => {
    const store = new Map<string, string>();
    const prevStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      get length() {
        return store.size;
      },
      key(i: number) {
        return Array.from(store.keys())[i] ?? null;
      },
      getItem(k: string) {
        return store.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        store.set(k, v);
      },
      removeItem(k: string) {
        store.delete(k);
      },
    };

    try {
      const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
      store.set("buzz_outdated_first_seen_1.2.2", String(fourDaysAgo));

      // Even if remote release bumps to 1.2.4, earliest timestamp must not reset
      const resolvedFirstSeen = getOrSetOutdatedFirstSeen("1.2.4", "1.2.0");
      assert.equal(resolvedFirstSeen, fourDaysAgo);

      const grace = computeGraceState(resolvedFirstSeen, Date.now());
      assert.equal(grace.canPassUpdate, false);
      assert.equal(grace.remainingGraceMs, 0);

      const activeGrace = computeGraceState(Date.now() - 1000, Date.now());
      assert.equal(activeGrace.canPassUpdate, true);
    } finally {
      (globalThis as any).localStorage = prevStorage;
    }
  });
});
