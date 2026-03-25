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

        // 1. Create a test user (seller)
        const testCategory = 'test_electronics_' + Date.now();
        const userRes = await pool.query(
            "INSERT INTO users (name, email, phone, role, password, store_category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            ['Test Seller', `test_${Date.now()}@example.com`, '555' + Math.floor(Math.random() * 1000000), 'seller', 'password', testCategory]
        );
        const userId = userRes.rows[0].id;
        console.log('Created test user with ID:', userId, 'and category:', testCategory);

        // 2. Create a store for the user
        const storeRes = await pool.query(
            "INSERT INTO stores (owner_id, name, location) VALUES ($1, $2, $3) RETURNING id",
            [userId, 'Test Store', 'Test Location']
        );
        const storeId = storeRes.rows[0].id;
        console.log('Created test store with ID:', storeId);

        // 3. Create a product for the store
        await pool.query(
            "INSERT INTO products (store_id, name, price) VALUES ($1, $2, $3)",
            [storeId, 'Test Product', 100]
        );
        console.log('Created test product');

        // 4. Test filtering
        console.log('Testing filter...');
        const filterRes = await pool.query(`
            SELECT p.* 
            FROM products p
            JOIN stores s ON p.store_id = s.id
            JOIN users u ON s.owner_id = u.id
            WHERE u.store_category = $1
        `, [testCategory]);

        if (filterRes.rows.length > 0 && filterRes.rows[0].name === 'Test Product') {
            console.log('✅ Success: Product found with correct category filter!');
        } else {
            console.error('❌ Failure: Product not found with category filter.');
            console.log('Result:', filterRes.rows);
        }

        // 5. Cleanup (optional, but good practice)
        // await pool.query("DELETE FROM products WHERE store_id = $1", [storeId]);
        // await pool.query("DELETE FROM stores WHERE id = $1", [storeId]);
        // await pool.query("DELETE FROM users WHERE id = $1", [userId]);
        // console.log('Cleanup done.');

    } catch (err) {
        console.error('Verification Error:', err.message);
    } finally {
        await pool.end();
    }
}

verify();
