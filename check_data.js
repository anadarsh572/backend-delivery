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

async function checkData() {
    try {
        console.log('--- Products Sample ---');
        const products = await pool.query("SELECT * FROM products LIMIT 1");
        console.log(products.rows[0]);

        console.log('--- Users Sample ---');
        const users = await pool.query("SELECT * FROM users LIMIT 1");
        console.log(users.rows[0]);

        console.log('--- Stores Sample ---');
        const stores = await pool.query("SELECT * FROM stores LIMIT 1");
        console.log(stores.rows[0]);

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkData();
