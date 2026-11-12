import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStockTransition,
  formatStockAlertNotification,
  wasStockTransitionRecentlyHandled,
  markStockTransitionHandled,
  shouldNotifyFeedStockAlert,
  shouldSuppressInitialInstallStockReminder,
} from "./stockAlerts";
import {
  buildCanonicalStockKey,
  getDeterministicNotificationId,
} from "./utils";

describe("stockAlerts instant transition detection", () => {
  it("classifies stock drops crossing out-of-stock, critical-low, and low-stock thresholds", () => {
    assert.equal(classifyStockTransition(5, 0), "out_of_stock");
    assert.equal(classifyStockTransition(1, 0), "out_of_stock");
    assert.equal(classifyStockTransition(0, 0), null);
    assert.equal(classifyStockTransition(6, 3), "critical_low");
    assert.equal(classifyStockTransition(3, 2), null);
    assert.equal(classifyStockTransition(15, 10), "low_stock");
    assert.equal(classifyStockTransition(9, 8), null);
    assert.equal(classifyStockTransition(2, 12), null);
  });

  it("formats clear notification titles and bodies for each severity", () => {
    const oos = formatStockAlertNotification({
      productName: "Amul Milk",
      type: "out_of_stock",
      stock: 0,
    });
    assert.match(oos.title, /Out of Stock/i);
    assert.match(oos.body, /Amul Milk/);

    const crit = formatStockAlertNotification({
      productName: "Bread",
      type: "critical_low",
      stock: 2,
    });
    assert.match(crit.title, /Critical Low/i);
    assert.match(crit.body, /2 units/);
  });

  it("deduplicates recently handled stock transitions cleanly", () => {
    assert.equal(wasStockTransitionRecentlyHandled("p1", "out_of_stock", 0), false);
    markStockTransitionHandled("p1", "out_of_stock", 0);
    assert.equal(wasStockTransitionRecentlyHandled("p1", "out_of_stock", 0), true);
    assert.equal(wasStockTransitionRecentlyHandled("p2", "out_of_stock", 0), false);
  });

  it("builds canonical stock keys consistently", () => {
    assert.equal(
      buildCanonicalStockKey("out_of_stock", "prod-1", -3),
      "stock_canonical_out_of_stock_prod-1_0"
    );
    assert.equal(
      buildCanonicalStockKey("low_stock", "prod-2", 2.9),
      "stock_canonical_low_stock_prod-2_2"
    );
  });

  it("produces deterministic bounded notification IDs matching native hash logic", () => {
    const samples = [
      "",
      "admin_broadcast_1700000000000",
      "offline_conflict_bill_123",
      "stock_canonical_out_of_stock_p1_0",
    ];
    for (const key of samples) {
      const id = getDeterministicNotificationId(key);
      assert.equal(id, getDeterministicNotificationId(key));
      assert.ok(id >= 10000 && id < 800010000, `Expected bounded ID for ${key}, got ${id}`);
    }
    assert.equal(getDeterministicNotificationId(""), 10001);
    assert.equal(getDeterministicNotificationId("admin_broadcast_1700000000000"), 326053740);
    assert.equal(getDeterministicNotificationId("offline_conflict_bill_123"), 470733477);
    assert.equal(getDeterministicNotificationId("stock_canonical_out_of_stock_p1_0"), 141217742);
  });

  it("suppresses historical stock_alerts_feed notifications on fresh install or initial snapshot", () => {
    const installTime = 1700000000000;
    // Fresh install (no prior notified history, first snapshot) -> must NOT notify even for a very recent alert
    assert.equal(
      shouldNotifyFeedStockAlert({
        eventTimestamp: installTime - 5000,
        baselineTimestamp: installTime,
        isFirstSnapshot: true,
        hasPriorNotifiedHistory: false,
        fromSelf: false,
        alreadyHandledNative: false,
        recentlyHandledLocal: false,
      }),
      false
    );

    // Subsequent snapshot, but alert timestamp is older than baseline -> must NOT notify
    assert.equal(
      shouldNotifyFeedStockAlert({
        eventTimestamp: installTime - 1000,
        baselineTimestamp: installTime,
        isFirstSnapshot: false,
        hasPriorNotifiedHistory: true,
        fromSelf: false,
        alreadyHandledNative: false,
        recentlyHandledLocal: false,
      }),
      false
    );

    // Live stock drop occurring AFTER install baseline on another device -> MUST notify
    assert.equal(
      shouldNotifyFeedStockAlert({
        eventTimestamp: installTime + 5000,
        baselineTimestamp: installTime,
        isFirstSnapshot: false,
        hasPriorNotifiedHistory: true,
        fromSelf: false,
        alreadyHandledNative: false,
        recentlyHandledLocal: false,
      }),
      true
    );
  });

  it("suppresses initial out-of-stock reminder on fresh install or first user login on device", () => {
    assert.equal(
      shouldSuppressInitialInstallStockReminder({
        hasDeviceBaselineSeeded: false,
        hasUserBaselineSeeded: false,
        isBrandNewAccount: false,
      }),
      true
    );
    assert.equal(
      shouldSuppressInitialInstallStockReminder({
        hasDeviceBaselineSeeded: true,
        hasUserBaselineSeeded: false,
        isBrandNewAccount: false,
      }),
      true
    );
    assert.equal(
      shouldSuppressInitialInstallStockReminder({
        hasDeviceBaselineSeeded: true,
        hasUserBaselineSeeded: true,
        isBrandNewAccount: false,
      }),
      false
    );
  });
});

