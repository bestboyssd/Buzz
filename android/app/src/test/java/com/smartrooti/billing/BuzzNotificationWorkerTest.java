package com.smartrooti.billing;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class BuzzNotificationWorkerTest {
    @Test
    public void deterministicIdMatchesJavascriptImplementation() {
        assertEquals(10001, BuzzNotificationWorker.deterministicId(""));
        assertEquals(10001, BuzzNotificationWorker.deterministicId(null));
        assertEquals(326053740, BuzzNotificationWorker.deterministicId("admin_broadcast_1700000000000"));
        assertEquals(470733477, BuzzNotificationWorker.deterministicId("offline_conflict_bill_123"));
        assertEquals(141217742, BuzzNotificationWorker.deterministicId("stock_canonical_out_of_stock_p1_0"));
    }

    @Test
    public void deterministicIdStaysWithinNotificationBounds() {
        String[] keys = new String[] {
            "stock_alert_evt_1",
            "global_security_alert_1700000000000",
            "security_alert_evt_99",
            "a".repeat(200)
        };
        for (String key : keys) {
            int id = BuzzNotificationWorker.deterministicId(key);
            assertTrue("ID should be >= 10000", id >= 10000);
            assertTrue("ID should be < 800010000", id < 800010000);
            assertEquals(id, BuzzNotificationWorker.deterministicId(key));
        }
    }
}
