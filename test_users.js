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

async function testUsers() {
    try {
        console.log('Testing users table...');
        const res = await pool.query("SELECT id, name, email, role, is_blocked FROM users");
        console.log('Users found:', res.rows.length);
        console.log('User sample:', JSON.stringify(res.rows, null, 2));
        
        // Also check columns
        const cols = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        `);
        console.log('Columns in users table:', cols.rows.map(c => c.column_name).join(', '));
        
    } catch (err) {
        console.error('Error during test:', err);
    } finally {
        await pool.end();
    }
}

testUsers();
