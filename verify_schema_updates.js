const { Pool } = require('pg');
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
        console.log('--- Verification Start ---');

        // Create user
        const testPhone = '555' + Math.floor(Math.random() * 1000000);
        const userRes = await pool.query(
            "INSERT INTO users (name, email, phone, role, password) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            ['Test Vendor', `test_${Date.now()}@example.com`, testPhone, 'seller', 'password']
        );
        const userId = userRes.rows[0].id;

        // Create store
        const storeRes = await pool.query(
            "INSERT INTO stores (owner_id, name, location) VALUES ($1, $2, $3) RETURNING id",
            [userId, 'Test Store 2', 'Test Location']
        );
        const storeId = storeRes.rows[0].id;

        // Create product with category
        const productRes = await pool.query(
            "INSERT INTO products (store_id, name, price, category) VALUES ($1, $2, $3, $4) RETURNING id, category",
            [storeId, 'Test Product 2', 150, 'test_category']
        );
        console.log('Created product with category:', productRes.rows[0].category);

        // Fetch product by category
        const filterRes = await pool.query(`
            SELECT p.* 
            FROM products p
            WHERE p.category = $1
        `, ['test_category']);

        if (filterRes.rows.length > 0 && filterRes.rows[0].name === 'Test Product 2') {
            console.log('✅ Success: Product found directly by category!');
        } else {
            console.error('❌ Failure: Product not found by category.');
        }

        // Test Order insertion
        const orderRes = await pool.query(
            "INSERT INTO orders (user_id, store_id, total_price, customer_name) VALUES ($1, $2, $3, $4) RETURNING id, customer_name",
            [userId, storeId, 150, 'Test Customer Name']
        );
        console.log('✅ Success: Order created with customer_name:', orderRes.rows[0].customer_name);

    } catch (err) {
        console.error('Verification Error:', err.message);
    } finally {
        await pool.end();
    }
}

verify();
