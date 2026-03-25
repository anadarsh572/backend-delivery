const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: false
});

async function verify() {
    try {
        console.log('--- Orders API Verification Start ---');

        // Create a Vendor
        const vendorMail = `vendor_${Date.now()}@example.com`;
        const vPhone = `123${Date.now()}`;
        const vRes = await pool.query(
            "INSERT INTO users (name, email, phone, role, password, is_blocked) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            ['Test Vendor Order', vendorMail, vPhone, 'seller', 'hash', false]
        );
        const vendorId = vRes.rows[0].id;

        // Create a Customer
        const custMail = `cust_${Date.now()}@example.com`;
        const cPhone = `321${Date.now()}`;
        const cRes = await pool.query(
            "INSERT INTO users (name, email, phone, role, password, is_blocked) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            ['Test Cust Order', custMail, cPhone, 'customer', 'hash', false]
        );
        const custId = cRes.rows[0].id;

        // 1. Generate token for customer
        const custToken = jwt.sign(
            { id: custId, role: 'customer' },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '1h' }
        );

        // 1a. Generate token for vendor
        const vendorToken = jwt.sign(
            { id: vendorId, role: 'seller' },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '1h' }
        );

        const API_URL = 'http://localhost:5000';

        // 2. Checkout (POST /api/orders)
        console.log('\\n[TEST] POST /api/orders (Checkout)');
        const checkoutRes = await fetch(`${API_URL}/api/orders`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${custToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vendor_id: vendorId,
                total_price: 250,
                address: '123 Test St',
                phone: '01012345678',
                customer_name: 'John Doe',
                items: [{ id: 1, name: 'Pizza', quantity: 2, price: 125 }]
            })
        });
        const checkoutData = await checkoutRes.json();
        if (checkoutRes.ok) {
            console.log('✅ Checkout Success! Order ID:', checkoutData.orderId);
        } else {
            console.error('❌ Checkout Failed:', checkoutData);
            return;
        }

        const newOrderId = checkoutData.orderId;

        // 3. GET /api/vendor/orders
        console.log('\\n[TEST] GET /api/vendor/orders');
        const vendorOrdersRes = await fetch(`${API_URL}/api/vendor/orders`, {
            headers: { 'Authorization': `Bearer ${vendorToken}` }
        });
        const vendorOrdersData = await vendorOrdersRes.json();
        if (vendorOrdersRes.ok && vendorOrdersData.some(o => o.id === newOrderId)) {
            console.log('✅ Vendor Orders Fetch Success! Found the new order.');
        } else {
            console.error('❌ Vendor Orders Fetch Failed or order not found:', vendorOrdersData);
        }

        // 4. PATCH /api/orders/:id/status
        console.log('\\n[TEST] PATCH /api/orders/:id/status (Accepted)');
        const patchRes = await fetch(`${API_URL}/api/orders/${newOrderId}/status`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${vendorToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'accepted' })
        });
        const patchData = await patchRes.json();
        if (patchRes.ok && patchData.status === 'accepted') {
            console.log('✅ Status Update Success! Order is now:', patchData.status);
        } else {
            console.error('❌ Status Update Failed:', patchData);
        }

    } catch (err) {
        console.error('Verification Error:', err.message);
    } finally {
        await pool.end();
    }
}

verify();
