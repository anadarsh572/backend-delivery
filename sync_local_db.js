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

async function syncSchema() {
    try {
        console.log('Adding category to products...');
        await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100)');
        console.log('Adding customer_name to orders...');
        await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(150)');
        console.log('✅ Local schema synced successfully.');
    } catch (err) {
        console.error('Error syncing schema:', err.message);
    } finally {
        await pool.end();
    }
}

syncSchema();
