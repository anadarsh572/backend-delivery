-- 1. Identify and delete products belonging to cafe stores
DELETE FROM products 
WHERE store_id IN (SELECT id FROM stores WHERE category IN ('cafe', 'كافيهات'));

-- 2. Identify and delete orders belonging to cafe stores
DELETE FROM orders 
WHERE store_id IN (SELECT id FROM stores WHERE category IN ('cafe', 'كافيهات'));

-- 3. Delete the cafe stores themselves
DELETE FROM stores 
WHERE category IN ('cafe', 'كافيهات');

-- 4. Correct any user store_category references
UPDATE users SET store_category = 'restaurant' WHERE store_category = 'cafe';
