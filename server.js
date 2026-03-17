require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({
    origin: 'https://frontend-delivery-sooty.vercel.app',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    preflightContinue: false,
    optionsSuccessStatus: 204,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
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
const authorizeVendor = (req, res, next) => {
    if (req.user && (req.user.role === 'vendor' || req.user.role === 'admin')) {
        next();
    } else {
        res.status(403).json({ error: "لازم تكون صاحب مطعم عشان تدخل هنا" });
    }
};

// API لجلب طلبات مطعم معين فقط (للبائع)
app.get('/api/vendor/my-orders', authenticateToken, authorizeVendor, async (req, res) => {
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
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await pool.query(
            "INSERT INTO users (name, email, phone, role, address, password) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, role",
            [name, email, phone, role || 'customer', address, hashedPassword]
        );
        res.status(201).json({ message: "Account created successfully!", user: newUser.rows[0] });
    } catch (err) {
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

        // 4. إنشاء الـ Token (كارت الدخول)
        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // 5. الرد النهائي
        res.json({
            message: "Login successful",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during login" });
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
        const orders = await pool.query(
            `SELECT o.*, u.name as driver_name, u.phone as driver_phone
             FROM orders o
             LEFT JOIN users u ON o.driver_id = u.id
             WHERE o.user_id = $1 ORDER BY o.created_at DESC`,
            [userId]
        );
        res.json(orders.rows);
    } catch (err) {
        res.status(500).json({ error: "Error fetching orders" });
    }
});

// --- 5. API إنشاء طلب جديد (Checkout) ---
app.post('/api/orders', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.id; // بناخد الـ ID من التوكن للأمان
        const { store_id, total_price, items, delivery_address, customer_phone } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: "السلة فاضية يا بطل!" });
        }

        // 1. تسجيل الطلب الأساسي مع العنوان ورقم التليفون
        const newOrder = await pool.query(
            "INSERT INTO orders (user_id, store_id, total_price, delivery_address, customer_phone) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [user_id, store_id, total_price, delivery_address, customer_phone]
        );
        const orderId = newOrder.rows[0].id;

        // 2. تسجيل المنتجات اللي جوه الطلب
        for (let item of items) {
            await pool.query(
                "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)",
                [orderId, item.product_id || item.id, item.quantity, item.price]
            );
        }

        res.status(201).json({ message: "تم إرسال الطلب للمطعم بنجاح!", orderId });
    } catch (err) {
        console.error("خطأ في إنشاء الطلب:", err.message);
        res.status(500).json({ error: "حصلت مشكلة واحنا بنأكد الطلب" });
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
        const storeOrders = await pool.query(
            `SELECT o.*, u1.name as customer_name, u2.name as driver_name
             FROM orders o
             JOIN users u1 ON o.user_id = u1.id 
             LEFT JOIN users u2 ON o.driver_id = u2.id 
             WHERE o.store_id = $1 ORDER BY o.created_at DESC`,
            [storeId]
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

// ==========================================
// تشغيل السيرفر
// ==========================================
const PORT = process.env.PORT || 5000;
// --- 12. جلب المنتجات للجميع (Public API) ---
// الزائر والعميل والأدمن كلهم يقدروا يشوفوا المنتجات هنا
app.get('/api/products', async (req, res) => {
    try {
        const products = await pool.query("SELECT * FROM products ORDER BY id DESC");
        res.json(products.rows);
    } catch (err) {
        console.error("خطأ في جلب المنتجات:", err.message);
        res.status(500).json({ error: "فشل جلب المنتجات من قاعدة البيانات" });
    }
});
app.listen(PORT, () => {
    console.log(`🚀 Server is flying on port ${PORT}`);
});

// --- 14. إضافة منتج جديد للمطعم (خاص بالبائع) ---
app.post('/api/vendor/products', authenticateToken, authorizeVendor, async (req, res) => {
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
            [`${searchQuery}%`] // علامات % معناها "أي كلام قبل الكلمة أو بعدها"
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
app.post('/api/vendor/pay-subscription', authenticateToken, authorizeVendor, async (req, res) => {
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