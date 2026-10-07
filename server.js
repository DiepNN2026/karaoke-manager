const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Khởi tạo SQLite Database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Lỗi kết nối DB:', err.message);
    else console.log('Đã kết nối cơ sở dữ liệu SQLite.');
});

// Tạo bảng dữ liệu
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'staff'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        logo TEXT,
        address TEXT,
        phone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_name TEXT,
        price_per_hour REAL,
        status TEXT DEFAULT 'Trống', -- Trống, Đang hát (Online), Đang hát (Tại quầy)
        customer_name TEXT,
        customer_phone TEXT,
        customer_cccd TEXT,
        start_time DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS menu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT,
        category TEXT, -- 'Thực đơn' hoặc 'Nước uống'
        price REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER,
        item_id INTEGER,
        quantity INTEGER,
        total_price REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT,
        quantity INTEGER,
        unit TEXT,
        import_date DATE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT, -- Lương, An ninh, Điện, Nước, Tiếp khách, Khác
        amount REAL,
        note TEXT,
        date DATE
    )`);

    // Tạo tài khoản Admin mặc định nếu chưa có
    db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO users (username, password, role) VALUES ('admin', '123456', 'admin')`);
            db.run(`INSERT INTO settings (name, logo, address, phone) VALUES ('Karaoke Hoàng Gia', '', '123 Đường Karaoke, Cà Mau', '0909123456')`);
        }
    });
});

// --- API ROUTES ---

// Đăng nhập
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu!' });
        res.json({ success: true, user: { username: row.username, role: row.role } });
    });
});

// Đổi mật khẩu & Thêm tài khoản
app.post('/api/users', (req, res) => {
    const { username, password, role } = req.body;
    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, password, role || 'staff'], function(err) {
        if (err) return res.status(500).json({ error: 'Tên tài khoản đã tồn tại!' });
        res.json({ success: true, id: this.lastID });
    });
});

// Lấy cài đặt chung
app.get('/api/settings', (req, res) => {
    db.get(`SELECT * FROM settings LIMIT 1`, (err, row) => {
        res.json(row || {});
    });
});

// Cập nhật cài đặt
app.post('/api/settings', (req, res) => {
    const { name, logo, address, phone } = req.body;
    db.run(`UPDATE settings SET name = ?, logo = ?, address = ?, phone = ? WHERE id = 1`, [name, logo, address, phone], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Lấy danh sách phòng
app.get('/api/rooms', (req, res) => {
    db.all(`SELECT * FROM rooms`, (err, rows) => {
        res.json(rows);
    });
});

// Thêm / Cập nhật bảng giá phòng (Quản trị viên)
app.post('/api/rooms/update', (req, res) => {
    const { id, room_name, price_per_hour } = req.body;
    if (id) {
        db.run(`UPDATE rooms SET room_name = ?, price_per_hour = ? WHERE id = ?`, [room_name, price_per_hour, id], (err) => {
            res.json({ success: true });
        });
    } else {
        db.run(`INSERT INTO rooms (room_name, price_per_hour, status) VALUES (?, ?, 'Trống')`, [room_name, price_per_hour], (err) => {
            res.json({ success: true });
        });
    }
});

// Đặt phòng (Online hoặc Tại quầy)
app.post('/api/rooms/book', (req, res) => {
    const { room_id, type, customer_name, customer_phone, customer_cccd } = req.body;
    const status = type === 'online' ? 'Đang hát (Online)' : 'Đang hát (Tại quầy)';
    const start_time = new Date().toISOString();

    db.run(`UPDATE rooms SET status = ?, customer_name = ?, customer_phone = ?, customer_cccd = ?, start_time = ? WHERE id = ?`,
        [status, customer_name || 'Khách tại quầy', customer_phone || '', customer_cccd || '', start_time, room_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// Tính tiền & Thanh toán (Phòng trở thành trống)
app.post('/api/rooms/checkout', (req, res) => {
    const { room_id } = req.body;
    db.get(`SELECT * FROM rooms WHERE id = ?`, [room_id], (err, room) => {
        if (!room || room.status === 'Trống') return res.status(400).json({ error: 'Phòng đang trống!' });

        const startTime = new Date(room.start_time);
        const now = new Date();
        const hours = Math.max(1, (now - startTime) / (1000 * 60 * 60)); // Tính tối thiểu 1 giờ hoặc theo thời gian thực
        const roomTotal = hours * room.price_per_hour;

        // Tính tiền dịch vụ gọi thêm (Thực đơn + Nước uống)
        db.all(`SELECT SUM(total_price) as serviceTotal FROM orders WHERE room_id = ?`, [room_id], (err, rows) => {
            const serviceTotal = rows[0]?.serviceTotal || 0;
            const grandTotal = roomTotal + serviceTotal;

            // Reset trạng thái phòng
            db.run(`UPDATE rooms SET status = 'Trống', customer_name = NULL, customer_phone = NULL, customer_cccd = NULL, start_time = NULL WHERE id = ?`, [room_id], () => {
                // Xóa orders cũ của phòng này
                db.run(`DELETE FROM orders WHERE room_id = ?`, [room_id], () => {
                    res.json({
                        success: true,
                        report: {
                            room_name: room.room_name,
                            hours: hours.toFixed(2),
                            roomTotal: roomTotal.toFixed(0),
                            serviceTotal: serviceTotal.toFixed(0),
                            grandTotal: grandTotal.toFixed(0)
                        }
                    });
                });
            });
        });
    });
});

// Quản lý Thực đơn & Nước uống
app.get('/api/menu', (req, res) => {
    db.all(`SELECT * FROM menu`, (err, rows) => res.json(rows));
});

app.post('/api/menu', (req, res) => {
    const { item_name, category, price } = req.body;
    db.run(`INSERT INTO menu (item_name, category, price) VALUES (?, ?, ?)`, [item_name, category, price], () => {
        res.json({ success: true });
    });
});

// Gọi món cho phòng
app.post('/api/orders', (req, res) => {
    const { room_id, item_id, quantity } = req.body;
    db.get(`SELECT price FROM menu WHERE id = ?`, [item_id], (err, item) => {
        const total_price = item.price * quantity;
        db.run(`INSERT INTO orders (room_id, item_id, quantity, total_price) VALUES (?, ?, ?, ?)`, [room_id, item_id, quantity, total_price], () => {
            res.json({ success: true });
        });
    });
});

// Báo cáo doanh thu và chi phí
app.get('/api/reports', (req, res) => {
    db.all(`SELECT SUM(amount) as totalExpense FROM expenses`, (err, exp) => {
        res.json({
            expenses: exp[0]?.totalExpense || 0
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại cổng ${PORT}`);
});