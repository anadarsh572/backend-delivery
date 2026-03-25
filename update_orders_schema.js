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
        console.log('🔄 Updating orders table schema...');
        
        // Rename columns if they exist
        const queries = [
            `DO $$ 
            BEGIN 
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='store_id') THEN 
                    ALTER TABLE orders RENAME COLUMN store_id TO vendor_id; 
                END IF; 
                
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_address') THEN 
                    ALTER TABLE orders RENAME COLUMN delivery_address TO address; 
                END IF;

                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='customer_phone') THEN 
                    ALTER TABLE orders RENAME COLUMN customer_phone TO phone; 
                END IF;
            END $$;`,
            
            // Add items column
            `ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB;`
        ];

        for (let q of queries) {
            await pool.query(q);
        }

        console.log('✅ Orders table schema updated successfully.');
    } catch (err) {
        console.error('❌ Error updating schema:', err.message);
    } finally {
        await pool.end();
    }
}

updateSchema();
