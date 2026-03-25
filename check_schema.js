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

async function checkSchema() {
    try {
        console.log('--- Products Table ---');
        const productsInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'products'");
        console.table(productsInfo.rows);

        console.log('--- Users Table ---');
        const usersInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'");
        console.table(usersInfo.rows);

        console.log('--- Stores Table ---');
        const storesInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'stores'");
        console.table(storesInfo.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkSchema();
