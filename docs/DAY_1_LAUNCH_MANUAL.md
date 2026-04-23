# DailyPick: Day 1 Operations & Go-Live Manual

This document contains the strict operational procedures to initialize the DailyPick cloud infrastructure and verify physical POS hardware.

## Phase 1: Master Database Initialization (The Cold Boot)
Because the platform is hosted on Railway, we bypass local terminal scripts and initialize the MongoDB Atlas database directly through the secure production endpoint.

1. **Create the Master Admin:**
   * Open a web browser.
   * Navigate to your live backend deployment: 
     `https://dailypick-backend-production-05d6.up.railway.app/api/auth/setup?key=YOUR_SETUP_KEY`
   * *(Note: Replace `YOUR_SETUP_KEY` with the exact string defined in your Railway environment variables).*
   * **Success State:** The browser will return a JSON response confirming the Master Admin has been generated.
2. **Initialize the Catalog:**
   * Log into the DailyPick Admin Dashboard (hosted on Vercel) using the newly created credentials.
   * Navigate to the **Inventory Management** tab.
   * Upload your initial supermarket CSV file to trigger the memory-safe bulk processing pipeline.

## Phase 2: POS Hardware & Edge Synchronization Test
DailyPick is designed to survive ISP outages at the physical store. This protocol verifies the Service Worker and IndexedDB queues.

1. **Install the PWA:**
   * Open the Vercel Admin URL on the physical store tablet/computer.
   * Click "Install App" in the browser address bar to lock the dashboard to the device's home screen.
2. **Scanner Verification:**
   * Open the **In-Store Register** (POS) view.
   * Scan a physical barcode using your USB/Bluetooth scanner. Ensure the scanner is configured to send a carriage return (Enter key) after scanning. The item should instantly populate in the cart via the optimized Command Search.
3. **The Offline Queue Test:**
   * Physically disconnect the tablet from Wi-Fi.
   * Ring up a dummy cash transaction and click "Checkout".
   * **Success State:** A toast notification will appear stating "Offline Mode: Action queued for background sync."
   * Reconnect the tablet to Wi-Fi.
   * **Success State:** Within 30 seconds, the Service Worker will silently flush the outbox, transmitting the payload to Railway with an `Idempotency-Key` to prevent double-billing.

## Phase 3: Pre-Launch Load Testing & QA Protocol
Before driving live traffic, prove the backend locks and container scaling by executing the Artillery stress test.

1. **Execute the Simulation:**
   * Open your local terminal.
   * Run the command: `npx artillery run load-test.yml`
2. **Monitor the Pipeline:**
   * Open your Railway Dashboard. Navigate to "Metrics".
   * Ensure CPU does not hit 100% and MongoDB connections do not exhaust during the 500 req/sec spike.
   * **Success State:** Artillery terminal outputs 0 failed HTTP requests, confirming the atomic Idempotency locks successfully caught concurrent duplicates.
