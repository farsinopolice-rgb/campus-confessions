const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_LENGTH = 280;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Image Upload Configuration ─────────────────────────────

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// ── Database ──────────────────────────────────────────────

const db = new sqlite3.Database('./confessions.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        mood TEXT DEFAULT 'none',
        likes INTEGER DEFAULT 0,
        reposts INTEGER DEFAULT 0,
        image TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add image column to posts table if it doesn't exist
    db.run(`ALTER TABLE posts ADD COLUMN image TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding image column to posts:', err.message);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        image TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id)
    )`);

    // Add image column to replies table if it doesn't exist
    db.run(`ALTER TABLE replies ADD COLUMN image TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('Error adding image column to replies:', err.message);
        }
    });
});

// ── Helpers ───────────────────────────────────────────────

function getReactionsForPosts(ids, callback) {
    if (ids.length === 0) return callback({});
    const placeholders = ids.map(() => '?').join(',');
    db.all(
        `SELECT post_id, type, COUNT(*) as count FROM reactions WHERE post_id IN (${placeholders}) GROUP BY post_id, type`,
        ids,
        (err, rows) => {
            if (err) return callback({});
            const map = {};
            rows.forEach(r => {
                if (!map[r.post_id]) map[r.post_id] = {};
                map[r.post_id][r.type] = r.count;
            });
            callback(map);
        }
    );
}

// ── Routes ────────────────────────────────────────────────

// Get all posts
app.get('/api/posts', (req, res) => {
    const sortType = req.query.sort || 'recent';
    let order;
    let timeFilter = '';
    
    switch(sortType) {
        case 'new':
            order = 'posts.timestamp DESC';
            break;
        case 'rising':
            // Posts with high engagement in the last 2 hours
            timeFilter = `AND posts.timestamp >= datetime('now', '-2 hours')`;
            order = '(COALESCE(r.reaction_count, 0) + posts.reposts + posts.likes + COALESCE(rep.reply_count, 0)) DESC, posts.timestamp DESC';
            break;
        case 'controversial':
            // Posts with mixed reactions (high ratio of angry/sad to love/happy)
            order = `
                CASE 
                    WHEN (COALESCE(love_count, 0) + COALESCE(happy_count, 0)) > 0 
                    THEN (COALESCE(angry_count, 0) + COALESCE(sad_count, 0)) * 1.0 / (COALESCE(love_count, 0) + COALESCE(happy_count, 0))
                    ELSE 0 
                END DESC,
                (COALESCE(r.reaction_count, 0) + posts.reposts + posts.likes + COALESCE(rep.reply_count, 0)) DESC
            `;
            break;
        case 'top':
            order = '(COALESCE(r.reaction_count, 0) + posts.reposts + posts.likes + COALESCE(rep.reply_count, 0)) DESC';
            break;
        case 'best':
            // Quality score: likes + reposts*2 + reactions*1.5 + replies*0.5
            order = '(posts.likes + posts.reposts * 2 + COALESCE(r.reaction_count, 0) * 1.5 + COALESCE(rep.reply_count, 0) * 0.5) DESC';
            break;
        case 'hot':
            // Recent posts with high engagement (last 6 hours)
            timeFilter = `AND posts.timestamp >= datetime('now', '-6 hours')`;
            order = '((COALESCE(r.reaction_count, 0) + posts.reposts + posts.likes + COALESCE(rep.reply_count, 0)) * 1000.0 / (julianday("now") - julianday(posts.timestamp))) DESC';
            break;
        case 'trending':
        default:
            order = 'posts.timestamp DESC';
            break;
    }

    const baseQuery = `
        SELECT posts.*,
            COALESCE(r.reaction_count, 0) as reaction_count,
            COALESCE(rep.reply_count, 0) as reply_count,
            COALESCE(love_count.love, 0) as love_count,
            COALESCE(happy_count.happy, 0) as happy_count,
            COALESCE(angry_count.angry, 0) as angry_count,
            COALESCE(sad_count.sad, 0) as sad_count
        FROM posts
        LEFT JOIN (SELECT post_id, COUNT(*) as reaction_count FROM reactions GROUP BY post_id) r ON r.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as reply_count FROM replies GROUP BY post_id) rep ON rep.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as love FROM reactions WHERE type = 'love' GROUP BY post_id) love_count ON love_count.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as happy FROM reactions WHERE type = 'haha' GROUP BY post_id) happy_count ON happy_count.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as angry FROM reactions WHERE type = 'angry' GROUP BY post_id) angry_count ON angry_count.post_id = posts.id
        LEFT JOIN (SELECT post_id, COUNT(*) as sad FROM reactions WHERE type = 'sad' GROUP BY post_id) sad_count ON sad_count.post_id = posts.id
        WHERE 1=1 ${timeFilter}
        ORDER BY ${order}
    `;

    db.all(baseQuery, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        getReactionsForPosts(rows.map(r => r.id), (reactionsMap) => {
            res.json(rows.map(row => ({ ...row, reactions: reactionsMap[row.id] || {} })));
        });
    });
});

// Create post
app.post('/api/posts', upload.single('image'), (req, res) => {
    const { text, mood } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Post cannot be empty' });
    if (text.trim().length > MAX_LENGTH) return res.status(400).json({ error: `Max ${MAX_LENGTH} characters` });

    const validMoods = ['none', 'love', 'happy', 'sad', 'angry', 'anxious', 'excited'];
    const safeMood = validMoods.includes(mood) ? mood : 'none';
    
    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    db.run(`INSERT INTO posts (text, mood, image) VALUES (?, ?, ?)`, [text.trim(), safeMood, imagePath], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
            id: this.lastID, 
            text: text.trim(), 
            mood: safeMood, 
            image: imagePath,
            likes: 0, 
            reposts: 0, 
            reactions: {}, 
            reply_count: 0 
        });
    });
});

// Like a post
app.post('/api/posts/:id/like', (req, res) => {
    db.run(`UPDATE posts SET likes = likes + 1 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
        db.get(`SELECT likes FROM posts WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ likes: row.likes });
        });
    });
});

// Repost
app.post('/api/posts/:id/repost', (req, res) => {
    db.run(`UPDATE posts SET reposts = reposts + 1 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
        db.get(`SELECT reposts FROM posts WHERE id = ?`, [req.params.id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ reposts: row.reposts });
        });
    });
});

// React to a post
app.post('/api/posts/:id/react', (req, res) => {
    const { type } = req.body;
    const validTypes = ['love', 'haha', 'sad', 'angry', 'fire'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid reaction' });

    db.run(`INSERT INTO reactions (post_id, type) VALUES (?, ?)`, [req.params.id, type], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT type, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY type`, [req.params.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const reactions = {};
            rows.forEach(r => reactions[r.type] = r.count);
            res.json({ reactions });
        });
    });
});

// Delete post
app.delete('/api/posts/:id', (req, res) => {
    const postId = req.params.id;
    console.log(`Delete request received for post ID: ${postId}`);
    
    // Validate postId
    if (!postId || isNaN(parseInt(postId))) {
        console.error('Invalid post ID:', postId);
        return res.status(400).json({ error: 'Invalid post ID' });
    }
    
    // Delete associated replies first
    db.run(`DELETE FROM replies WHERE post_id = ?`, [postId], (err) => {
        if (err) {
            console.error('Error deleting replies:', err.message);
            return res.status(500).json({ error: 'Failed to delete replies' });
        }
        console.log('Deleted replies for post:', postId);
        
        // Delete associated reactions
        db.run(`DELETE FROM reactions WHERE post_id = ?`, [postId], (err) => {
            if (err) {
                console.error('Error deleting reactions:', err.message);
                return res.status(500).json({ error: 'Failed to delete reactions' });
            }
            console.log('Deleted reactions for post:', postId);
            
            // Delete the post
            db.run(`DELETE FROM posts WHERE id = ?`, [postId], function(err) {
                if (err) {
                    console.error('Error deleting post:', err.message);
                    return res.status(500).json({ error: 'Failed to delete post' });
                }
                
                console.log(`Post deletion result: ${this.changes} rows affected`);
                
                if (this.changes === 0) {
                    console.log('Post not found:', postId);
                    return res.status(404).json({ error: 'Post not found' });
                }
                
                console.log('Post deleted successfully:', postId);
                res.json({ 
                    message: 'Post deleted successfully',
                    deletedId: postId
                });
            });
        });
    });
});

// Get replies
app.get('/api/posts/:id/replies', (req, res) => {
    db.all(`SELECT * FROM replies WHERE post_id = ? ORDER BY timestamp ASC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Post reply
app.post('/api/posts/:id/reply', upload.single('image'), (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Reply cannot be empty' });

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    db.run(`INSERT INTO replies (post_id, text, image) VALUES (?, ?, ?)`, [req.params.id, text.trim(), imagePath], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
            id: this.lastID, 
            post_id: Number(req.params.id), 
            text: text.trim(),
            image: imagePath
        });
    });
});

// ── Start ─────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
