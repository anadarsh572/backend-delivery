const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function migrate() {
    try {
        console.log('🔄 Starting migration: is_active -> is_blocked');
        
        // 1. Rename the column if it exists
        await pool.query(`
            DO $$ 
            BEGIN 
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_active') THEN 
                    ALTER TABLE users RENAME COLUMN is_active TO is_blocked; 
                    -- 2. Flip values: is_active=true (active) becomes is_blocked=false (not blocked)
                    UPDATE users SET is_blocked = NOT is_blocked;
                    RAISE NOTICE 'Column renamed and values flipped.';
                ELSE
                    RAISE NOTICE 'Column is_active does not exist, skipping rename.';
                END IF; 
            END $$;
        `);

        console.log('✅ Migration completed successfully.');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
    } finally {
        await pool.end();
    }
}

migrate();
