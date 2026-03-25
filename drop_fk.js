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

async function run() {
  try {
      console.log('Terminating other connections...');
      await pool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = current_database()
          AND pid <> pg_backend_pid();
      `);
      console.log('Dropping constraint...');
      await pool.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_store_id_fkey');
      console.log('Dropped FK constraint successfully');
  } catch(e) {
      console.error(e);
  } finally {
      await pool.end();
  }
}
run();
