import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCleanVersion, compareSemver, GITHUB_RELEASES_FALLBACK_URL } from "./versionCheck";

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
});
