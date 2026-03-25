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

async function updateSchema() {
    try {
        console.log('Adding store_category column to users table...');
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS store_category VARCHAR(100)");
        console.log('Column added successfully.');
    } catch (err) {
        console.error('Error adding column:', err.message);
    } finally {
        await pool.end();
    }
}

updateSchema();
