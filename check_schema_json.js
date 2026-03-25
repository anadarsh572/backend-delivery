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
        const productsInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'products'");
        const usersInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'");
        const storesInfo = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'stores'");

        console.log(JSON.stringify({
            products: productsInfo.rows,
            users: usersInfo.rows,
            stores: storesInfo.rows
        }, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

checkSchema();
