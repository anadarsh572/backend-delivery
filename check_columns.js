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

async function checkColumns() {
    try {
        const usersRes = await pool.query("SELECT * FROM users LIMIT 0");
        console.log('Users columns:', usersRes.fields.map(f => f.name));

        const storesRes = await pool.query("SELECT * FROM stores LIMIT 0");
        console.log('Stores columns:', storesRes.fields.map(f => f.name));

        const productsRes = await pool.query("SELECT * FROM products LIMIT 0");
        console.log('Products columns:', productsRes.fields.map(f => f.name));

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkColumns();
