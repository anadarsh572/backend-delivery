require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();
const allowedOrigins = [
    'https://backend-delivery-ten.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5000'
];

app.use(cors({
    origin: function (origin, callback) {
        // السماح بطلبات الـ Localhost وأي رابط من قائمة الـ Whitelist أو بدون origin
        if (!origin || 
            allowedOrigins.includes(origin) || 
            origin.includes('localhost') || 
            origin.includes('127.0.0.1')
        ) {
            callback(null, true);
        } else {
            console.log('Blocked by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));
app.use(express.json());

// 📝 Logger بسيط عشان نعرف إيه اللي بيحصل في السيرفر
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// الربط مع قاعدة البيانات (محلي أو سحابي)
const poolConfig = process.env.DATABASE_URL 
    ? { 
        connectionString: process.env.DATABASE_URL, 
        ssl: { rejectUnauthorized: false } 
      }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        ssl: false
      };

const pool = new Pool(poolConfig);

// 🛠️ وظيفة تحديث قاعدة البيانات تلقائياً
let migrationLogs = [];

const updateDatabaseSchema = async () => {
    migrationLogs = [];
    try {
        migrationLogs.push('🔄 Starting database schema update...');
        const queries = [
            `CREATE TABLE IF NOT EXISTS stores (id SERIAL PRIMARY KEY);`,
            `ALTER TABLE stores ADD COLUMN IF NOT EXISTS name CHARACTER VARYING(255);`,
            `ALTER TABLE stores ADD COLUMN IF NOT EXISTS owner_id INTEGER;`,
            `ALTER TABLE stores ADD COLUMN IF NOT EXISTS category CHARACTER VARYING(100);`,
            `ALTER TABLE stores ALTER COLUMN name DROP NOT NULL;`,
            `ALTER TABLE stores ALTER COLUMN owner_id DROP NOT NULL;`,
            `ALTER TABLE stores ALTER COLUMN category DROP NOT NULL;`,
            `DO $$ 
            BEGIN 
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='store_name') THEN 
                    UPDATE stores SET name = store_name WHERE name IS NULL;
                    EXECUTE 'ALTER TABLE stores ALTER COLUMN store_name DROP NOT NULL';
                END IF; 
            END $$;`,
            `DO $$ 
            BEGIN 
                -- Rename vendor_id back to store_id in orders table for consistency
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='vendor_id') THEN 
                    ALTER TABLE orders RENAME COLUMN vendor_id TO store_id;
                END IF;

                -- Add payment_method column with default value
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='payment_method') THEN 
                    ALTER TABLE orders ADD COLUMN payment_method CHARACTER VARYING(50) DEFAULT 'Cash on Delivery';
                END IF;

                -- Alignment for new strict mapping
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='customer_phone') THEN 
                    ALTER TABLE orders ADD COLUMN customer_phone CHARACTER VARYING(20);
                    -- Migrate existing data if phone exists
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='phone') THEN
                        UPDATE orders SET customer_phone = phone WHERE customer_phone IS NULL;
                    END IF;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='customer_address') THEN 
                    ALTER TABLE orders ADD COLUMN customer_address TEXT;
                    -- Migrate existing data if address exists
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='address') THEN
                        UPDATE orders SET customer_address = address WHERE customer_address IS NULL;
                    END IF;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='items_price') THEN 
                    ALTER TABLE orders ADD COLUMN items_price NUMERIC(10,2);
                END IF;

                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_fee') THEN 
                    ALTER TABLE orders ADD COLUMN delivery_fee NUMERIC(10,2) DEFAULT 15;
                END IF;
            END $$;`
        ];

        for (let q of queries) {
            try {
                await pool.query(q);
                migrationLogs.push(`✅ Success: ${q.substring(0, 40)}...`);
            } catch (err) {
                migrationLogs.push(`❌ Failed Query: ${err.message}`);
                console.warn(`Query failed: ${q}`, err.message);
            }
        }
        migrationLogs.push('✅ Schema update cycle completed.');
    } catch (err) {
        migrationLogs.push(`🔴 CRITICAL Migration Error: ${err.message}`);
        console.error('❌ Database migration error:', err.message);
    }
};

// اختبار الاتصال عند التشغيل وتشغيل التحديثات
pool.connect(async (err, client, release) => {
    if (err) {
        return console.error('❌ Error acquiring client:', err.stack);
    }
    console.log('✅ Connected to PostgreSQL successfully!');
    release();
    
    // تشغيل التحديث التلقائي
    await updateDatabaseSchema();
});

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client:', err);
});

// ==========================================
// Middlewares الحماية (Security)
// ==========================================

// 1. التأكد من التوكن (هل المستخدم مسجل دخول؟)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "لازم تسجل دخول الأول" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "التوكن بتاعك منتهي أو غلط" });
        req.user = user;
        next();
    });
};

// 2. التأكد من الرتبة (هل هو مشرف؟)
const authorizeAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: "ممنوع! المنطقة دي للمشرفين فقط" });
    }
};
// بوديجارد البائع
const authorizeSeller = (req, res, next) => {
    if (req.user && (req.user.role === 'seller' || req.user.role === 'vendor' || req.user.role === 'admin')) {
        next();
    } else {
        res.status(403).json({ error: "لازم تكون صاحب مطعم عشان تدخل هنا" });
    }
};

// API لجلب طلبات للتاجر المسجل دخوله
app.get('/api/vendor/orders', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const userId = req.user.id;
        // أولاً: بنجيب معرف المتجر (store_id) الخاص بصاحب الحساب
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [userId]);
        
        if (storeResult.rows.length === 0) {
            return res.status(404).json({ error: "لا يوجد متجر لهذا الحساب" });
        }
        
        const storeId = storeResult.rows[0].id;

        // ثانياً: بنفلتر الطلبات بناءً على store_id المتجر
        const result = await pool.query(
            "SELECT * FROM orders WHERE store_id = $1 ORDER BY created_at DESC",
            [storeId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Vendor Orders Fetch Error:", err);
        res.status(500).json({ error: "فشل جلب طلبات التاجر", details: err.message });
    }
});

// API لجلب إحصائيات التاجر (عدد الطلبات، الأرباح، المعلقة)
app.get('/api/vendor/stats', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const vendorId = req.user.id;
        // Get store_id first
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [vendorId]);
        if (storeResult.rows.length === 0) return res.status(404).json({ error: "لا يوجد متجر لهذا الحساب" });
        const storeId = storeResult.rows[0].id;

        const statsQuery = `
            SELECT 
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending_orders,
                SUM(CASE WHEN status = 'Delivered' THEN total_price ELSE 0 END) as total_revenue
            FROM orders 
            WHERE store_id = $1
        `;
        const result = await pool.query(statsQuery, [storeId]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Vendor Stats Error:", err);
        res.status(500).json({ error: "فشل جلب الإحصائيات" });
    }
});

// API لجلب منتجات التاجر فقط
app.get('/api/vendor/products', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const vendorId = req.user.id;
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [vendorId]);
        if (storeResult.rows.length === 0) return res.status(404).json({ error: "المتجر غير موجود" });
        const storeId = storeResult.rows[0].id;

        const result = await pool.query("SELECT * FROM products WHERE store_id = $1 ORDER BY id DESC", [storeId]);
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Vendor Fetch Products Error:", err);
        res.status(500).json({ error: "فشل جلب المنتجات الخاصة بك" });
    }
});

// ==========================================
// APIs المستخدمين (Users & Auth)
// ==========================================

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, role, address, password, store_category } = req.body;
        
        // التحقق من نوع الحساب المختار
        let finalRole = 'user';
        let is_blocked = false;
        let finalStoreCategory = null;
        
        if (role === 'seller' || role === 'vendor' || role === 'بائع') {
            finalRole = 'seller';
            is_blocked = true; // Pending admin approval
            finalStoreCategory = store_category || 'restaurant'; 
        }

        const trimmedPassword = password ? password.trim() : '';
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(trimmedPassword, salt);
        
        const newUser = await pool.query(
            "INSERT INTO users (name, email, phone, role, address, password, is_blocked, store_category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, role, is_blocked, store_category",
            [name, email, phone, finalRole, address, hashedPassword, is_blocked, finalStoreCategory]
        );
        res.status(201).json({ 
            message: "Account created successfully!", 
            user: newUser.rows[0],
            status: finalRole === 'seller' ? 'pending' : 'active'
        });
    } catch (err) {
        console.error("❌ Register Error Details:", err);
        res.status(500).json({ error: "فشل إنشاء الحساب: " + err.message });
    }
});

// --- 2. API تسجيل الدخول (Login) مع حماية الحظر ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // 1. البحث عن المستخدم
        const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "الايميل غير مسجل عندنا" });
        }

        const user = userResult.rows[0];

        // 2. الكارت الأحمر (التحقق من الحظر)
        // لو الأدمن خلى is_blocked = true، السيرفر هيوقف العملية هنا
        if (user.is_blocked === true) {
            return res.status(403).json({ error: "حسابك محظور يا صاحبي.. راجع الإدارة!" });
        }

        // 3. مقارنة الباسورد
        const trimmedPassword = password ? password.trim() : '';
        const validPassword = await bcrypt.compare(trimmedPassword, user.password);
        
        console.log(`[Login Verify] Email: ${email} | Result (true/false):`, validPassword);

        if (!validPassword) {
            return res.status(400).json({ error: "الباسورد غلط يا صاحبي" });
        }

        let has_store = false;
        let store_id = null;
        if (user.role === 'seller' || user.role === 'vendor') {
            const storeCheck = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [user.id]);
            if (storeCheck.rows.length > 0) {
                has_store = true;
                store_id = storeCheck.rows[0].id;
            }
        }

        // 5. إنشاء الـ Token (كارت الدخول) مع التأكد من وجود الـ Secret
        if (!process.env.JWT_SECRET) {
            console.error("❌ JWT_SECRET is missing from environment variables!");
            return res.status(500).json({ error: "خطأ في إعدادات السيرفر (JWT)" });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // 6. الرد النهائي
        res.json({
            message: "Login successful",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                has_store: has_store,
                store_id: store_id
            }
        });

    } catch (err) {
        console.error("❌ Login Error Details:", err);
        res.status(500).json({ error: "فشل تسجيل الدخول: " + err.message });
    }
});

// --- 3. Google Social Login ---
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        
        // 1. Verify Google Token
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { email, name, picture } = payload;

        // 2. Check if user exists
        let userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        let user;

        if (userResult.rows.length === 0) {
            // 3. Create new user if not exists
            const randomPassword = crypto.randomBytes(16).toString('hex');
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(randomPassword, salt);
            
            const newUser = await pool.query(
                "INSERT INTO users (name, email, role, password, is_blocked) VALUES ($1, $2, $3, $4, $5) RETURNING *",
                [name, email, 'customer', hashedPassword, false]
            );
            user = newUser.rows[0];
        } else {
            user = userResult.rows[0];
        }

        // 4. Check block status
        if (user.is_blocked === true) {
            return res.status(403).json({ error: "حسابك محظور راجع الإدارة" });
        }

        // 5. Generate JWT
        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        let has_store = false;
        let store_id = null;
        if (user.role === 'seller' || user.role === 'vendor') {
            const storeCheck = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [user.id]);
            if (storeCheck.rows.length > 0) {
                has_store = true;
                store_id = storeCheck.rows[0].id;
            }
        }

        res.json({
            message: "Login successful with Google",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                has_store: has_store,
                store_id: store_id
            }
        });

    } catch (err) {
        console.error("Google Auth Error:", err.message);
        res.status(400).json({ error: "فشل الدخول بحساب جوجل" });
    }
});

// --- 3b. Verify Token & Get Current User ---
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userResult = await pool.query("SELECT id, name, email, role FROM users WHERE id = $1", [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userResult.rows[0];
        
        let has_store = false;
        let store_id = null;
        if (user.role === 'seller' || user.role === 'vendor') {
            const storeCheck = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [user.id]);
            if (storeCheck.rows.length > 0) {
                has_store = true;
                store_id = storeCheck.rows[0].id;
            }
        }

        res.json({
            user: {
                ...user,
                has_store,
                store_id
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 4. User Profile ---
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Fetch user data
        const userResult = await pool.query(
            "SELECT id, name, email, phone, role, is_blocked FROM users WHERE id = $1",
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "المستخدم غير موجود" });
        }

        const userData = userResult.rows[0];

        // Check store status
        let has_store = false;
        let store_id = null;
        if (userData.role === 'seller' || userData.role === 'vendor') {
            const storeCheck = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [userId]);
            if (storeCheck.rows.length > 0) {
                has_store = true;
                store_id = storeCheck.rows[0].id;
            }
        }

        // Fetch last 5 orders
        const ordersResult = await pool.query(
            "SELECT id, created_at, total_price, status FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
            [userId]
        );

        res.json({
            user: {
                ...userData,
                has_store,
                store_id
            },
            recent_orders: ordersResult.rows
        });
    } catch (err) {
        console.error("❌ Get Profile Error:", err);
        res.status(500).json({ error: "فشل جلب بيانات البروفايل: " + err.message });
    }
});

app.patch('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, phone } = req.body;

        // Validation
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: "الاسم مطلوب ولا يمكن أن يكون فارغاً" });
        }

        if (!phone || typeof phone !== 'string' || phone.trim() === '') {
            return res.status(400).json({ error: "رقم الهاتف مطلوب ولا يمكن أن يكون فارغاً" });
        }

        // Update user
        const updateResult = await pool.query(
            "UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING name, email, phone, role",
            [name.trim(), phone.trim(), userId]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: "المستخدم غير موجود" });
        }

        res.json({
            message: "تم تحديث البيانات بنجاح",
            user: updateResult.rows[0]
        });

    } catch (err) {
        console.error("❌ Update Profile Error:", err);
        res.status(500).json({ error: "فشل تحديث بيانات البروفايل: " + err.message });
    }
});

// ==========================================
// APIs المنتجات والطلبات (Products & Orders)
// ==========================================

app.post('/api/products', async (req, res) => {
    try {
        const { store_id, name, description, price, image_url, category } = req.body;
        const newProduct = await pool.query(
            "INSERT INTO products (store_id, name, description, price, image_url, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [store_id, name, description, price, image_url, category]
        );
        res.status(201).json(newProduct.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Error adding product" });
    }
});

app.get('/api/orders/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const limit = parseInt(req.query.limit) || 10;
        const offset = parseInt(req.query.offset) || 0;

        const orders = await pool.query(
            `SELECT o.*, u.name as driver_name, u.phone as driver_phone
             FROM orders o
             LEFT JOIN users u ON o.driver_id = u.id
             WHERE o.user_id = $1 
             ORDER BY o.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        res.json(orders.rows);
    } catch (err) {
        res.status(500).json({ error: "Error fetching orders" });
    }
});

// --- 5. API إنشاء طلب جديد (Checkout) ---
app.post('/api/orders', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.id;
        const { 
            store_id, 
            vendor_id, 
            total_price, 
            items_price,
            delivery_fee,
            items, 
            customer_address,
            customer_phone, 
            customer_name,
            payment_method 
        } = req.body;

        // Alignment for mapping
        const finalStoreId = store_id || vendor_id;
        const finalAddress = customer_address;
        const finalPhone = customer_phone;
        const finalPaymentMethod = payment_method || 'cash';
        const finalDeliveryFee = parseFloat(delivery_fee) || 15;

        if (!finalStoreId) {
            return res.status(400).json({ error: "معرف المتجر (store_id) مطلوب" });
        }

        if (!items || items.length === 0) {
            return res.status(400).json({ error: "السلة فاضية يا بطل!" });
        }

        // حساب items_price لو مش موجود
        let calculatedItemsPrice = 0;
        const parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
        
        if (items_price) {
            calculatedItemsPrice = parseFloat(items_price) || 0;
        } else {
            calculatedItemsPrice = parsedItems.reduce((acc, item) => {
                const price = parseFloat(item.price) || 0;
                const quantity = parseInt(item.quantity) || 1;
                return acc + (price * quantity);
            }, 0);
        }

        // التأكد من أن السعر الإجمالي مظبوط (لو مش موجود نجمع items_price + delivery_fee)
        const finalTotalPrice = total_price || (calculatedItemsPrice + finalDeliveryFee);

        // items should be sent as direct object for jsonb columns in pg
        const finalItemsJson = typeof items === 'string' ? items : JSON.stringify(items);

        const orderResult = await pool.query(
            "INSERT INTO orders (user_id, store_id, total_price, items_price, delivery_fee, customer_address, customer_phone, customer_name, items, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
            [user_id, finalStoreId, finalTotalPrice, calculatedItemsPrice, finalDeliveryFee, finalAddress, finalPhone, customer_name, finalItemsJson, finalPaymentMethod]
        );
        const orderId = orderResult.rows[0].id;

        res.status(200).json({ status: "success", message: "تم استقبال الطلب بنجاح وحفظه في قاعدة البيانات", orderId });
    } catch (err) {
        console.error("❌ خطأ في إنشاء الطلب:", err);
        res.status(500).json({ 
            error: "حصلت مشكلة واحنا بنأكد الطلب", 
            details: err.message,
            hint: "تأكد من أن أسماء الأعمدة في قاعدة البيانات مطابقة (store_id, payment_method, address, items, items_price, delivery_fee)"
        });
    }
});

// مسار تحديث الحالة 
app.patch('/api/orders/:id/status', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.id;
        
        // 1. التأكد من حالة الطلب المرسلة
        const validStatuses = ['Pending', 'accepted', 'rejected', 'Delivered', 'OnTheWay', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: "حالة الطلب غير صالحة" });
        }

        // 2. التحقق من أن هذا الطلب يخص متجر هذا المستخدم (البائع)
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [userId]);
        if (storeResult.rows.length === 0) {
            return res.status(403).json({ error: "ليس لديك مطعم مسجل" });
        }
        const storeIdFromUser = storeResult.rows[0].id;

        // التحقق من ملكية الطلب للمتجر قبل التعديل
        const orderCheck = await pool.query("SELECT store_id FROM orders WHERE id = $1", [id]);
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: "الطلب غير موجود" });
        }
        
        if (orderCheck.rows[0].store_id !== storeIdFromUser) {
            return res.status(403).json({ error: "لا يمكنك تعديل طلب لا يخص متجرك" });
        }

        // 3. تحديث الحالة
        const updatedOrder = await pool.query(
            "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );
        
        res.json(updatedOrder.rows[0]);
    } catch (err) {
        console.error("Update Status Error:", err);
        res.status(500).json({ error: "فشل تحديث حالة الطلب" });
    }
});

// استلام المندوب للطلب
app.put('/api/orders/:id/accept-delivery', async (req, res) => {
    try {
        const { id } = req.params;
        const { driver_id } = req.body;
        const updatedOrder = await pool.query(
            "UPDATE orders SET driver_id = $1, status = 'OnTheWay' WHERE id = $2 RETURNING *",
            [driver_id, id]
        );
        res.json(updatedOrder.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Accept failed" });
    }
});

// طلبات المطعم (ببيانات العميل والمندوب)
app.get('/api/orders/store/:storeId', async (req, res) => {
    try {
        const { storeId } = req.params;
        const limit = parseInt(req.query.limit) || 10;
        const offset = parseInt(req.query.offset) || 0;

        const storeOrders = await pool.query(
            `SELECT o.*, u1.name as customer_name, u2.name as driver_name
             FROM orders o
             JOIN users u1 ON o.user_id = u1.id 
             LEFT JOIN users u2 ON o.driver_id = u2.id 
             WHERE o.store_id = $1 
             ORDER BY o.created_at DESC
             LIMIT $2 OFFSET $3`,
            [storeId, limit, offset]
        );
        res.json(storeOrders.rows);
    } catch (err) {
        console.error("❌ Error fetching store orders:", err);
        res.status(500).json({ error: "Error fetching store orders", details: err.message });
    }
});

// ==========================================
// 🔒 APIs المشرف السرية (Admin Only)
// ==========================================

// --- 9. جلب كافة المستخدمين (للأدمن فقط) ---
app.get('/api/admin/users', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        // يجلب كل المستخدمين مع بياناتهم (الاسم، الإيميل، الحالة، الدور، وتصنيف المتجر store_category)
        const result = await pool.query("SELECT id, name, email, phone, role, is_blocked, store_category, created_at FROM users ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Fetch Users Error:", err.message);
        res.status(500).json({ error: "فشل جلب المستخدمين" });
    }
});

// --- 9b. جلب كافة البائعين/المتاجر (للأدمن فقط) ---
app.get('/api/admin/vendors', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.phone, s.name as store_name, s.category, s.subscription_status 
             FROM users u 
             JOIN stores s ON u.id = s.owner_id 
             WHERE u.role = 'seller' OR u.role = 'vendor'`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Fetch Vendors Error:", err.message);
        res.status(500).json({ error: "فشل جلب البائعين" });
    }
});

app.get('/api/admin/stats', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const userCount = await pool.query("SELECT COUNT(*) FROM users");
        const orderCount = await pool.query("SELECT COUNT(*) FROM orders");
        const revenue = await pool.query("SELECT SUM(total_price) FROM orders WHERE status = 'Delivered'");

        res.json({
            users: userCount.rows[0].count,
            orders: orderCount.rows[0].count,
            revenue: revenue.rows[0].sum || 0
        });
    } catch (err) {
        res.status(500).json({ error: "Admin stats failed" });
    }
});

// --- 9c. جلب كافة الطلبات (للأدمن فقط) ---
app.get('/api/admin/orders', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT o.*, u.name as customer_name 
             FROM orders o 
             JOIN users u ON o.user_id = u.id 
             ORDER BY o.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Admin Fetch Orders Error:", err.message);
        res.status(500).json({ error: "فشل جلب كافة الطلبات" });
    }
});

// --- 10a. تغيير دور المستخدم (للأدمن فقط) ---
app.patch('/api/admin/users/:id/role', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body; 

        const updatedUser = await pool.query(
            "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role, is_blocked",
            [role, id]
        );

        if (updatedUser.rows.length === 0) return res.status(404).json({ error: "المستخدم غير موجود" });

        res.json({ message: "تم تحديث دور المستخدم بنجاح!", user: updatedUser.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "فشل تحديث الدور" });
    }
});

// --- 10b. تحديث حالة المستخدم (حظر/فك حظر) ---
app.patch('/api/admin/users/:id/status', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // نأخذ القيمة سواء كانت is_blocked أو عكس is_active
        const is_blocked = req.body.is_blocked !== undefined ? req.body.is_blocked : !req.body.is_active;

        const updatedUser = await pool.query(
            "UPDATE users SET is_blocked = $1 WHERE id = $2 RETURNING id, name, email, role, is_blocked",
            [is_blocked, id]
        );

        if (updatedUser.rows.length === 0) return res.status(404).json({ error: "المستخدم غير موجود" });

        if (is_blocked === false) {
            console.log('User unblocked:', id);
        } else {
            console.log('User blocked:', id);
        }

        res.json({ message: "تم تغيير حالة الحظر بنجاح!", user: updatedUser.rows[0] });
    } catch (err) {
        console.error("Admin Status Update Error:", err);
        res.status(500).json({ error: "فشل تحديث الحالة" });
    }
});

// --- 10c. ترقية مستخدم ليكون أدمن من قبل أدمن آخر ---
app.patch('/api/admin/users/:id/make-admin', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const updatedUser = await pool.query(
            "UPDATE users SET role = 'admin' WHERE id = $1 RETURNING id, name, email, role, is_blocked",
            [id]
        );

        if (updatedUser.rows.length === 0) return res.status(404).json({ error: "المستخدم غير موجود" });

        res.json({ message: "تم ترقية المستخدم إلى أدمن بنجاح!", user: updatedUser.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "فشل ترقية المستخدم" });
    }
});

// --- 11. حذف مستخدم نهائياً ---
app.delete('/api/admin/users/:id', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
        res.json({ message: "تم حذف المستخدم نهائياً" });
    } catch (err) {
        res.status(500).json({ error: "فشل الحذف" });
    }
});

// --- 12. جلب المنتجات للجميع (Public API) ---
app.get('/api/products', async (req, res) => {
    try {
        const { category } = req.query;
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;

        let query;
        let params;

        if (category) {
            query = `
                SELECT p.* 
                FROM products p
                WHERE p.category = $1
                ORDER BY p.id DESC 
                LIMIT $2 OFFSET $3
            `;
            params = [category, limit, offset];
        } else {
            query = "SELECT * FROM products ORDER BY id DESC LIMIT $1 OFFSET $2";
            params = [limit, offset];
        }

        const products = await pool.query(query, params);
        res.json(products.rows);
    } catch (err) {
        console.error("خطأ في جلب المنتجات:", err.message);
        res.status(500).json({ error: "فشل جلب المنتجات من قاعدة البيانات" });
    }
});

// --- 13. إنشاء متجر جديد (للبائع في بداية التسجيل) ---
app.post('/api/vendor/create-store', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const { store_name, name } = req.body;
        const finalName = store_name || name;

        if (!finalName) {
            return res.status(400).json({ error: "لازم تدخل اسم المتجر" });
        }

        // تشخيص إضافي قبل الإدخال (Debug)
        const columns = await pool.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'stores'");
        console.log("🛠️ Current columns in stores table:", columns.rows);

        const newStore = await pool.query(
            "INSERT INTO stores (owner_id, name) VALUES ($1, $2) RETURNING *",
            [req.user.id, finalName]
        );

        res.status(201).json({
            message: "تم إنشاء المتجر بنجاح!",
            store: newStore.rows[0]
        });
    } catch (err) {
        console.error("❌ خطأ مفصل في إنشاء المتجر:", err);
        res.status(500).json({ 
            error: "فشل إنشاء المتجر", 
            message: err.message,
            detail: err.detail,
            hint: err.hint,
            column: err.column,
            constraint: err.constraint
        });
    }
});

// --- Debug Endpoint ---
app.get('/api/debug/schema', async (req, res) => {
    try {
        console.log("⚡ Manual schema update triggered via debug endpoint");
        await updateDatabaseSchema();
        const result = await pool.query(`
            SELECT table_name, column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            ORDER BY table_name, column_name;
        `);
        res.json({
            schema: result.rows,
            migrationLogs: migrationLogs
        });
    } catch (err) {
        res.status(500).json({ error: err.message, logs: migrationLogs });
    }
});

// --- 14. إضافة منتج جديد للمطعم (خاص بالبائع) ---
app.post('/api/vendor/products', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const { name, description, price, image_url, category } = req.body;
        const ownerId = req.user.id; // هويّة الشخص اللي باعت الطلب

        // أولاً: بنعرف البائع ده يملك أنهي مطعم
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [ownerId]);

        if (storeResult.rows.length === 0) {
            return res.status(404).json({ error: "لا يوجد مطعم مسجل بهذا الحساب!" });
        }

        const storeId = storeResult.rows[0].id;

        // ثانياً: بنضيف المنتج وبنربطه بالـ storeId أوتوماتيك
        const newProduct = await pool.query(
            "INSERT INTO products (store_id, name, description, price, image_url, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [storeId, name, description, price, image_url, category]
        );

        res.status(201).json({
            message: "تم إضافة الأكلة بنجاح!",
            product: newProduct.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "فشل إضافة المنتج" });
    }
});

// --- 15. API البحث عن المنتجات (متاح للجميع) ---
app.get('/api/products/search', async (req, res) => {
    try {
        const searchQuery = req.query.q; // الكلمة اللي العميل كتبها في البحث

        if (!searchQuery) {
            return res.json([]); // لو داس بحث وهو مش كاتب حاجة، نرجعله فاضي
        }

        // بنستخدم ILIKE عشان يدور على الكلمة سواء كابيتال أو سمول، وفي الاسم أو الوصف
        const result = await pool.query(
            "SELECT * FROM products WHERE name ILIKE $1 OR description ILIKE $1 ORDER BY id DESC",
            [`%${searchQuery}%`] // علامات % معناها "أي كلام قبل الكلمة أو بعدها"
        );

        res.json(result.rows);
    } catch (err) {
        console.error("خطأ في البحث:", err.message);
        res.status(500).json({ error: "حصلت مشكلة أثناء البحث" });
    }
});

// --- 16. إرسال تنبيه من الإدارة للبائع (للأدمن فقط) ---
app.post('/api/admin/notify-vendor', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { vendor_id, message } = req.body;
        // بنستخدم جدول الإشعارات اللي عملناه في أول المشروع
        await pool.query(
            "INSERT INTO notifications (user_id, message) VALUES ($1, $2)",
            [vendor_id, message]
        );
        res.json({ message: "تم إرسال رسالة التنبيه للبائع بنجاح!" });
    } catch (err) {
        res.status(500).json({ error: "فشل إرسال التنبيه" });
    }
});

// --- 17. دفع الاشتراك وتجديد الباقة (للبائع) ---
app.post('/api/vendor/pay-subscription', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const vendor_id = req.user.id;
        const subscription_fee = 500; // حدد قيمة الاشتراك اللي تعجبك (مثلاً 500 جنيه)

        // 1. تسجيل الفلوس في أرباح المنصة (بتسمع في لوحة التحكم بتاعتك)
        await pool.query(
            "INSERT INTO platform_profits (vendor_id, amount, payment_reason) VALUES ($1, $2, 'اشتراك شهري للمنصة')",
            [vendor_id, subscription_fee]
        );

        // 2. تحديث حالة المطعم وتمديد الاشتراك 30 يوم
        await pool.query(
            "UPDATE stores SET subscription_status = 'paid', subscription_expiry = CURRENT_DATE + INTERVAL '30 days' WHERE owner_id = $1",
            [vendor_id]
        );

        res.json({ message: "تم دفع الاشتراك بنجاح! مطعمك مفعل الآن لمدة 30 يوم." });
    } catch (err) {
        res.status(500).json({ error: "فشل عملية الدفع" });
    }
});


// --- 18. جلب المنتجات حسب القسم (مطاعم، كافيهات، ماركت) ---
app.get('/api/products/category/:categoryName', async (req, res) => {
    try {
        const { categoryName } = req.params;

        const result = await pool.query(
            `SELECT p.*, s.name as store_name 
            FROM products p
            JOIN stores s ON p.store_id = s.id
            WHERE p.category = $1
            ORDER BY p.id DESC`
            , [categoryName]);

        res.json(result.rows);
    } catch (err) {
        console.error("❌ Category Fetch Error:", err);
        res.status(500).json({ 
            error: "فشل في جلب المنتجات", 
            details: err.message,
            hint: "تأكد أن أسماء الأعمدة في جدول الـ stores صحيحة (name, category)"
        });
    }
});

// --- 19. Global Error Handler (معالجة الأخطاء الشاملة) ---
// هذا مهم جداً لضمان عدم تعطل السيرفر وإرجاع استجابة JSON دائماً
app.use((err, req, res, next) => {
    console.error("💥 Unhandled Error:", err.stack);
    
    // إرجاع استجابة JSON مع كود 500 لو محصلش غير كدة
    res.status(err.status || 500).json({
        error: "حدث خطأ داخلي في السيرفر",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ==========================================
// تشغيل السيرفر وتصديره لـ Vercel
// ==========================================
const PORT = process.env.PORT || 5000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server is flying on port ${PORT}`);
    });
}

module.exports = app;
