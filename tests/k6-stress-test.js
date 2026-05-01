/* tests/k6-stress-test.js */

import http from 'k6/http';
import { check, sleep } from 'k6';

// Simulate 50 concurrent users constantly hammering the checkout for 30 seconds
export const options = {
    vus: 50,
    duration: '30s',
};

export default function () {
    // Point this to your local or staging server
    const url = 'http://127.0.0.1:3000/api/orders'; 

    // Generating a unique idempotency key for every virtual user
    const idempotencyKey = `K6-TEST-${__VU}-${__ITER}-${Math.random()}`;

    const payload = JSON.stringify({
        customerName: `Stress Test User ${__VU}`,
        customerPhone: `+9199999${__VU.toString().padStart(5, '0')}`,
        deliveryAddress: 'K6 Load Test HQ',
        deliveryType: 'Instant',
        paymentMethod: 'Cash on Delivery',
        storeId: '60d5ecb54cb7c1332f123456', // Replace with a real store ID from your DB
        items: [
            {
                productId: '60d5ecb54cb7c1332f987654', // Replace with a real product ID
                variantId: 'VAR-100',
                name: 'K6 Stress Test Item',
                qty: 1,
                price: 150
            }
        ]
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'idempotency-key': idempotencyKey,
            // 'Authorization': 'Bearer YOUR_TEST_TOKEN' // Uncomment if auth is enforced on checkout
        },
    };

    // Fire the request
    const res = http.post(url, payload, params);

    // Assert that the server successfully handled the load without 500 errors
    check(res, {
        'is status 201': (r) => r.status === 201,
        'is not 500 internal error': (r) => r.status !== 500,
        'is not 429 rate limited': (r) => r.status !== 429, // Adjust if your Defense Matrix catches this!
    });

    // Small sleep to simulate realistic human delay between attempts
    sleep(1);
}
