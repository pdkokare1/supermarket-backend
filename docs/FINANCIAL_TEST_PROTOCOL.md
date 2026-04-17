# Financial Integrity & Dry Run Protocol

Before opening the storefront to public traffic, the financial ledgers must be stress-tested to ensure zero floating-point mathematical drift across the Vercel-to-Railway bridge.

## Phase 3: The "Rs 10" Live Dry Run

1. **The Transaction:**
   * Access the customer-facing Vercel frontend.
   * Add a low-value test item (e.g., Rs 10) to the cart.
   * Process the checkout as "Instant Delivery" via "Cash on Delivery".
2. **The Refund & Idempotency Check:**
   * Open the Admin Dashboard and navigate to the **Live Operations Center**.
   * Process a "Partial Refund" of Rs 2 on the active order.
   * Attempt to rapidly click the refund button multiple times to simulate a lagging connection. 
   * **Success State:** The Redis Idempotency Engine on Railway will drop the duplicate clicks, ensuring the total remains exactly Rs 8.
3. **The End-of-Day (EOD) Verification:**
   * Close the active shift in the Admin Dashboard and generate the EOD Report.
   * **Success State:** The expected cash must read exactly `8.00` with zero decimal drift (e.g., it must not read `8.000000000000002`).
4. **Analytics Allocation Check:**
   * Open the **Business Insights** tab.
   * Verify that the Materialized P&L Rollup successfully processed the transaction.
   * Confirm that the backend growth analytics are correctly mirroring your strategic financial allocations (Marketing/Growth at 65%, Operations/Legal at 10%, Infrastructure at 25%) against the newly established Customer Lifetime Value (LTV) metrics.
