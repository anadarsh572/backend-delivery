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
    'https://frontend-delivery-sooty.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5000'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    preflightContinue: false,
    optionsSuccessStatus: 204,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

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

// اختبار الاتصال عند التشغيل
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Error acquiring client:', err.stack);
    }
    console.log('✅ Connected to PostgreSQL successfully!');
    release();
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
    if (req.user && (req.user.role === 'seller' || req.user.role === 'admin')) {
        next();
    } else {
        res.status(403).json({ error: "لازم تكون صاحب مطعم عشان تدخل هنا" });
    }
};

// API لجلب طلبات مطعم معين فقط (للبائع)
app.get('/api/vendor/my-orders', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        // req.user.id هو الـ ID بتاع البائع اللي جاي من التوكن
        const result = await pool.query(
            "SELECT * FROM orders WHERE store_id = (SELECT id FROM stores WHERE owner_id = $1)",
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "فشل جلب طلباتك" });
    }
});

// ==========================================
// APIs المستخدمين (Users & Auth)
// ==========================================

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, role, address, password } = req.body;
        
        // التحقق من نوع الحساب المختار
        let finalRole = 'user';
        let is_active = true;
        
        if (role === 'seller' || role === 'vendor' || role === 'بائع') {
            finalRole = 'seller';
            is_active = false; // Pending admin approval
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        const newUser = await pool.query(
            "INSERT INTO users (name, email, phone, role, address, password, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, role, is_active",
            [name, email, phone, finalRole, address, hashedPassword, is_active]
        );
        res.status(201).json({ 
            message: "Account created successfully!", 
            user: newUser.rows[0],
            status: finalRole === 'seller' ? 'pending' : 'active'
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Email or phone already exists." });
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
        // لو الأدمن خلى is_active = false، السيرفر هيوقف العملية هنا
        if (user.is_active === false) {
            return res.status(403).json({ error: "حسابك محظور يا صاحبي.. راجع الإدارة!" });
        }

        // 3. مقارنة الباسورد
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: "الباسورد غلط يا صاحبي" });
        }

        // 4. Check if seller has a store (only for sellers)
        let has_store = false;
        if (user.role === 'seller') {
            const storeCheck = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [user.id]);
            has_store = storeCheck.rows.length > 0;
        }

        // 5. إنشاء الـ Token (كارت الدخول)
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
                has_store: has_store
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during login" });
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
                "INSERT INTO users (name, email, role, password, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING *",
                [name, email, 'customer', hashedPassword, true]
            );
            user = newUser.rows[0];
        } else {
            user = userResult.rows[0];
        }

        // 4. Check block status
        if (user.is_active === false) {
            return res.status(403).json({ error: "حسابك محظور راجع الإدارة" });
        }

        // 5. Generate JWT
        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            message: "Login successful with Google",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error("Google Auth Error:", err.message);
        res.status(400).json({ error: "فشل الدخول بحساب جوجل" });
    }
});

// ==========================================
// APIs المنتجات والطلبات (Products & Orders)
// ==========================================

app.post('/api/products', async (req, res) => {
    try {
        const { store_id, name, description, price, image_url } = req.body;
        const newProduct = await pool.query(
            "INSERT INTO products (store_id, name, description, price, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [store_id, name, description, price, image_url]
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
    const client = await pool.connect();
    try {
        const user_id = req.user.id;
        const { store_id, total_price, items, delivery_address, customer_phone } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: "السلة فاضية يا بطل!" });
        }

        await client.query('BEGIN');

        // 1. تسجيل الطلب الأساسي
        const orderResult = await client.query(
            "INSERT INTO orders (user_id, store_id, total_price, delivery_address, customer_phone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [user_id, store_id, total_price, delivery_address, customer_phone]
        );
        const orderId = orderResult.rows[0].id;

        // 2. تسجيل المنتجات
        for (let item of items) {
            await client.query(
                "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)",
                [orderId, item.product_id || item.id, item.quantity, item.price]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ status: "success", message: "تم استقبال الطلب بنجاح وحفظه في قاعدة البيانات", orderId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("خطأ في إنشاء الطلب:", err.message);
        res.status(500).json({ error: "حصلت مشكلة واحنا بنأكد الطلب" });
    } finally {
        client.release();
    }
});

// تحديث الحالة (للمطعم والمندوب)
app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const updatedOrder = await pool.query(
            "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );
        res.json(updatedOrder.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
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
        res.status(500).json({ error: "Error fetching store orders" });
    }
});

// ==========================================
// 🔒 APIs المشرف السرية (Admin Only)
// ==========================================

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

// --- 10. التحكم الكامل في المستخدمين (للأدمن فقط) ---
app.put('/api/admin/users/:id', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role, is_active } = req.body;

        const updatedUser = await pool.query(
            "UPDATE users SET role = $1, is_active = $2 WHERE id = $3 RETURNING id, name, email, role, is_active",
            [role, is_active, id]
        );

        if (updatedUser.rows.length === 0) return res.status(404).json({ error: "المستخدم غير موجود" });

        res.json({ message: "تم التحديث بنجاح!", user: updatedUser.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "فشل التحديث" });
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
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;

        const products = await pool.query(
            "SELECT * FROM products ORDER BY id DESC LIMIT $1 OFFSET $2",
            [limit, offset]
        );
        res.json(products.rows);
    } catch (err) {
        console.error("خطأ في جلب المنتجات:", err.message);
        res.status(500).json({ error: "فشل جلب المنتجات من قاعدة البيانات" });
    }
});

// --- 13. إنشاء متجر جديد (للبائع في بداية التسجيل) ---
app.post('/api/vendor/create-store', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const { store_name, category } = req.body;
        const owner_id = req.user.id;

        if (!store_name || !category) {
            return res.status(400).json({ error: "لازم تدخل اسم المتجر والقسم" });
        }

        const newStore = await pool.query(
            "INSERT INTO stores (owner_id, store_name, category) VALUES ($1, $2, $3) RETURNING *",
            [owner_id, store_name, category]
        );

        res.status(201).json({
            message: "تم إنشاء المتجر بنجاح!",
            store: newStore.rows[0]
        });
    } catch (err) {
        console.error("خطأ في إنشاء المتجر:", err.message);
        res.status(500).json({ error: "فشل إنشاء المتجر" });
    }
});

// --- 14. إضافة منتج جديد للمطعم (خاص بالبائع) ---
app.post('/api/vendor/products', authenticateToken, authorizeSeller, async (req, res) => {
    try {
        const { name, description, price, image_url } = req.body;
        const ownerId = req.user.id; // هويّة الشخص اللي باعت الطلب

        // أولاً: بنعرف البائع ده يملك أنهي مطعم
        const storeResult = await pool.query("SELECT id FROM stores WHERE owner_id = $1", [ownerId]);

        if (storeResult.rows.length === 0) {
            return res.status(404).json({ error: "لا يوجد مطعم مسجل بهذا الحساب!" });
        }

        const storeId = storeResult.rows[0].id;

        // ثانياً: بنضيف المنتج وبنربطه بالـ storeId أوتوماتيك
        const newProduct = await pool.query(
            "INSERT INTO products (store_id, name, description, price, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [storeId, name, description, price, image_url]
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

        // هنا السيرفر بيجيب المنتجات اللي تابعة لمتاجر من القسم المطلوب بس
        const result = await pool.query(
            `SELECT p.*, s.store_name, s.category 
            FROM products p
            JOIN stores s ON p.store_id = s.id
            WHERE s.category = $1
            ORDER BY p.id DESC`
            , [categoryName]);

        res.json(result.rows);
    } catch (err) {
        console.error("خطأ في جلب منتجات القسم:", err.message);
        res.status(500).json({ error: "حصلت مشكلة واحنا بنجيب المنتجات" });
    }
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