
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const root = path.resolve(__dirname, '..');

// Render: set DATA_DIR=/var/data
// Local development: use the project's data folder.
const dataRoot = process.env.DATA_DIR || path.join(root, 'data');

const dataDir = path.join(dataRoot, 'steadysight');
const uploadDir = path.join(dataRoot, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'steadysight.sqlite'));

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK(type IN ('video','photo')),
        mime_type TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        category TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS likes (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, capture_id)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, capture_id)
    );

    CREATE TABLE IF NOT EXISTS session_store (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
    );
`);

if (!db.prepare('PRAGMA table_info(captures)').all()
    .some(column => column.name === 'mime_type')) {
    db.exec("ALTER TABLE captures ADD COLUMN mime_type TEXT NOT NULL DEFAULT ''");
}

const app = express();

app.disable('x-powered-by');

// Render terminates HTTPS before forwarding requests to Express.
if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

app.use(express.json({ limit: '32kb' }));

const isProduction =
    process.env.NODE_ENV === 'production' || !!process.env.RENDER;

if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be configured in production.');
}

class SQLiteSessionStore extends session.Store {
    get(sid, callback) {
        try {
            const row = db.prepare(
                'SELECT sess, expire FROM session_store WHERE sid = ?'
            ).get(sid);

            if (!row || row.expire < Date.now()) {
                this.destroy(sid, () => {});
                return callback(null, null);
            }

            callback(null, JSON.parse(row.sess));
        } catch (error) {
            callback(error);
        }
    }

    set(sid, sess, callback = () => {}) {
        try {
            const expire = sess.cookie?.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + 86400000;

            db.prepare(`
                INSERT INTO session_store(sid, sess, expire)
                VALUES(?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET
                    sess = excluded.sess,
                    expire = excluded.expire
            `).run(sid, JSON.stringify(sess), expire);

            callback();
        } catch (error) {
            callback(error);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            db.prepare('DELETE FROM session_store WHERE sid = ?').run(sid);
            callback();
        } catch (error) {
            callback(error);
        }
    }

    touch(sid, sess, callback = () => {}) {
        this.set(sid, sess, callback);
    }
}

const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
};

app.use(session({
    name: 'steadysight.sid',
    store: new SQLiteSessionStore(),
    secret: process.env.SESSION_SECRET || 'local-development-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: cookieOptions
}));

app.use('/uploads', express.static(uploadDir, {
    fallthrough: false,
    setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

const mediaExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/webm': '.webm',
    'video/mp4': '.mp4',
    'video/ogg': '.ogv',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'video/3gpp': '.3gp',
    'video/3gpp2': '.3g2'
};

const baseMimeType = value =>
    String(value || '').split(';', 1)[0].trim().toLowerCase();

const upload = multer({
    storage: multer.diskStorage({
        destination(req, file, callback) {
            callback(null, uploadDir);
        },
        filename(req, file, callback) {
            const extension = mediaExtensions[baseMimeType(file.mimetype)];
            callback(null, crypto.randomUUID() + extension);
        }
    }),
    limits: {
        fileSize: 100 * 1024 * 1024
    },
    fileFilter(req, file, callback) {
        const mime = baseMimeType(file.mimetype);

        if (Object.hasOwn(mediaExtensions, mime)) {
            return callback(null, true);
        }

        callback(new Error(`Unsupported media type: ${file.mimetype}`));
    }
});

const api = express.Router();

const safeUser = user => ({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.created_at
});

function auth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: 'Please log in to continue.'
        });
    }

    next();
}

function establishSession(req, res, userId, status = 200) {
    req.session.regenerate(error => {
        if (error) {
            return res.status(500).json({
                error: 'Could not start a secure session.'
            });
        }

        req.session.userId = Number(userId);

        req.session.save(saveError => {
            if (saveError) {
                return res.status(500).json({
                    error: 'Could not save the session.'
                });
            }

            const user = db.prepare(
                'SELECT * FROM users WHERE id = ?'
            ).get(req.session.userId);

            res.status(status).json({
                user: safeUser(user)
            });
        });
    });
}

function parseTags(value) {
    if (Array.isArray(value)) {
        return value.map(String)
            .map(tag => tag.trim())
            .filter(Boolean)
            .slice(0, 20);
    }

    return String(value || '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 20);
}

function captureRow(row, userId) {
    return {
        ...row,
        tags: JSON.parse(row.tags),
        mediaUrl: `/uploads/${encodeURIComponent(row.filename)}`,
        likeCount: row.like_count,
        liked: !!row.liked,
        bookmarked: !!row.bookmarked,
        owner: row.owner_id === userId
    };
}

const selection = `
    c.id, c.title, c.description, c.type, c.mime_type,
    c.filename, c.category, c.tags, c.created_at, c.owner_id,
    (SELECT COUNT(*) FROM likes l
        WHERE l.capture_id = c.id) AS like_count,
    EXISTS(SELECT 1 FROM likes l
        WHERE l.capture_id = c.id AND l.user_id = ?) AS liked,
    EXISTS(SELECT 1 FROM bookmarks b
        WHERE b.capture_id = c.id AND b.user_id = ?) AS bookmarked
`;

// REGISTER
api.post('/auth/register', async (req, res, next) => {
    try {
        const name = String(req.body.name || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');

        if (name.length < 2 || name.length > 80) {
            return res.status(400).json({
                error: 'Name must be 2–80 characters.'
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                error: 'Enter a valid email address.'
            });
        }

        if (password.length < 8 || password.length > 128) {
            return res.status(400).json({
                error: 'Password must be 8–128 characters.'
            });
        }

        const hash = await bcrypt.hash(password, 12);

        const result = db.prepare(`
            INSERT INTO users(name, email, password_hash)
            VALUES(?, ?, ?)
        `).run(name, email, hash);

        establishSession(req, res, result.lastInsertRowid, 201);
    } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
            return res.status(409).json({
                error: 'An account with that email already exists.'
            });
        }

        next(error);
    }
});

// LOGIN
api.post('/auth/login', async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');

        const user = db.prepare(
            'SELECT * FROM users WHERE email = ?'
        ).get(email);

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({
                error: 'Email or password is incorrect.'
            });
        }

        establishSession(req, res, user.id);
    } catch (error) {
        next(error);
    }
});

// LOGOUT
api.post('/auth/logout', (req, res) => {
    req.session.destroy(error => {
        if (error) {
            return res.status(500).json({
                error: 'Could not log out.'
            });
        }

        res.clearCookie('steadysight.sid', {
            httpOnly: true,
            sameSite: 'lax',
            secure: isProduction,
            path: '/'
        });

        res.json({ ok: true });
    });
});

// CURRENT USER
api.get('/auth/me', (req, res) => {
    const user = req.session.userId
        ? db.prepare('SELECT * FROM users WHERE id = ?')
            .get(req.session.userId)
        : null;

    res.json({
        user: user ? safeUser(user) : null
    });
});

// PROFILE
api.get('/profile', auth, (req, res) => {
    const user = db.prepare(
        'SELECT * FROM users WHERE id = ?'
    ).get(req.session.userId);

    if (!user) {
        return res.status(401).json({
            error: 'Please log in to continue.'
        });
    }

    const stats = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(type = 'video') AS videos,
            SUM(type = 'photo') AS photos
        FROM captures
        WHERE owner_id = ?
    `).get(user.id);

    const activities = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM likes WHERE user_id = ?) AS likes,
            (SELECT COUNT(*) FROM bookmarks WHERE user_id = ?) AS bookmarks
    `).get(user.id, user.id);

    res.json({
        user: safeUser(user),
        stats: {
            total: stats.total,
            videos: stats.videos || 0,
            photos: stats.photos || 0,
            ...activities
        }
    });
});

// LIST CAPTURES
api.get('/captures', auth, (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = ['video', 'photo'].includes(req.query.type)
        ? req.query.type : '';
    const category = String(req.query.category || '').trim();
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

    const userId = req.session.userId;

    const rows = db.prepare(`
        SELECT ${selection}
        FROM captures c
        WHERE c.owner_id = ?
        AND (? = '' OR c.title LIKE ? OR c.description LIKE ?)
        AND (? = '' OR c.type = ?)
        AND (? = '' OR c.category = ?)
        ORDER BY c.created_at ${sort}, c.rowid ${sort}
    `).all(
        userId,
        userId,
        userId,
        q,
        `%${q}%`,
        `%${q}%`,
        type,
        type,
        category,
        category
    );

    const categories = db.prepare(`
        SELECT DISTINCT category
        FROM captures
        WHERE owner_id = ?
        ORDER BY category
    `).all(userId).map(row => row.category);

    res.json({
        captures: rows.map(row => captureRow(row, userId)),
        categories
    });
});

// CREATE CAPTURE
api.post('/captures', auth, upload.single('media'), (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'No media file was uploaded.'
            });
        }

        const receivedMimeType = baseMimeType(req.file.mimetype);
        const reportedMimeType = String(
            req.body.mimeType || req.file.mimetype
        ).trim();

        const validReportedMime =
            /^(image\/(jpeg|png|webp)|video\/(webm|mp4|ogg|quicktime|x-matroska|3gpp2?))(?:\s*;\s*codecs\s*=\s*[a-z0-9., _-]+)?$/i
                .test(reportedMimeType);

        if (
            !validReportedMime ||
            reportedMimeType.length > 160 ||
            baseMimeType(reportedMimeType) !== receivedMimeType
        ) {
            fs.unlink(req.file.path, () => {});

            return res.status(400).json({
                error: 'Uploaded media MIME type does not match.'
            });
        }

        const title = String(req.body.title || '').trim();
        const category = String(req.body.category || '').trim();
        const description = String(req.body.description || '').trim();

        if (
            !title || title.length > 120 ||
            !category || category.length > 60 ||
            description.length > 2000
        ) {
            fs.unlink(req.file.path, () => {});

            return res.status(400).json({
                error: 'Title and category are required. Check field lengths.'
            });
        }

        const type = receivedMimeType.startsWith('video/')
            ? 'video' : 'photo';

        const id = crypto.randomUUID();

        db.prepare(`
            INSERT INTO captures(
                id, title, description, type, mime_type,
                filename, category, tags, owner_id
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            title,
            description,
            type,
            reportedMimeType,
            req.file.filename,
            category,
            JSON.stringify(parseTags(req.body.tags)),
            req.session.userId
        );

        const row = db.prepare(`
            SELECT ${selection}
            FROM captures c
            WHERE c.id = ?
        `).get(req.session.userId, req.session.userId, id);

        res.status(201).json({
            capture: captureRow(row, req.session.userId)
        });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        next(error);
    }
});

// GET ONE CAPTURE
api.get('/captures/:id', auth, (req, res) => {
    const row = db.prepare(`
        SELECT ${selection}
        FROM captures c
        WHERE c.id = ? AND c.owner_id = ?
    `).get(
        req.session.userId,
        req.session.userId,
        req.params.id,
        req.session.userId
    );

    if (!row) {
        return res.status(404).json({
            error: 'Capture not found.'
        });
    }

    res.json({
        capture: captureRow(row, req.session.userId)
    });
});

// UPDATE CAPTURE
api.put('/captures/:id', auth, (req, res) => {
    const title = String(req.body.title || '').trim();
    const category = String(req.body.category || '').trim();
    const description = String(req.body.description || '').trim();

    if (
        !title || title.length > 120 ||
        !category || category.length > 60 ||
        description.length > 2000
    ) {
        return res.status(400).json({
            error: 'Title and category are required. Check field lengths.'
        });
    }

    const result = db.prepare(`
        UPDATE captures
        SET title = ?, description = ?, category = ?, tags = ?
        WHERE id = ? AND owner_id = ?
    `).run(
        title,
        description,
        category,
        JSON.stringify(parseTags(req.body.tags)),
        req.params.id,
        req.session.userId
    );

    if (!result.changes) {
        const exists = db.prepare(
            'SELECT id FROM captures WHERE id = ?'
        ).get(req.params.id);

        return res.status(exists ? 403 : 404).json({
            error: 'Capture not found or not yours.'
        });
    }

    const row = db.prepare(`
        SELECT ${selection}
        FROM captures c
        WHERE c.id = ?
    `).get(
        req.session.userId,
        req.session.userId,
        req.params.id
    );

    res.json({
        capture: captureRow(row, req.session.userId)
    });
});

// DELETE CAPTURE
api.delete('/captures/:id', auth, (req, res) => {
    const row = db.prepare(`
        SELECT filename, owner_id
        FROM captures
        WHERE id = ?
    `).get(req.params.id);

    if (!row) {
        return res.status(404).json({
            error: 'Capture not found.'
        });
    }

    if (row.owner_id !== req.session.userId) {
        return res.status(403).json({
            error: 'You can only delete your own captures.'
        });
    }

    db.prepare('DELETE FROM captures WHERE id = ?')
        .run(req.params.id);

    fs.unlink(path.join(uploadDir, row.filename), () => {});

    res.json({ ok: true });
});

// LIKE AND BOOKMARK
for (const [table, verb, route] of [
    ['likes', 'liked', 'like'],
    ['bookmarks', 'bookmarked', 'bookmark']
]) {
    api.post(`/captures/:id/${route}`, auth, (req, res) => {
        const existsCapture = db.prepare(
            'SELECT id FROM captures WHERE id = ?'
        ).get(req.params.id);

        if (!existsCapture) {
            return res.status(404).json({
                error: 'Capture not found.'
            });
        }

        const exists = db.prepare(`
            SELECT 1 FROM ${table}
            WHERE user_id = ? AND capture_id = ?
        `).get(req.session.userId, req.params.id);

        if (exists) {
            db.prepare(`
                DELETE FROM ${table}
                WHERE user_id = ? AND capture_id = ?
            `).run(req.session.userId, req.params.id);
        } else {
            db.prepare(`
                INSERT OR IGNORE INTO ${table}(user_id, capture_id)
                VALUES(?, ?)
            `).run(req.session.userId, req.params.id);
        }

        res.json({
            [verb]: !exists
        });
    });
}

app.use('/api', api);

// FRONTEND
app.get('/', (req, res) => {
    res.sendFile(path.join(root, 'index.html'));
});

app.get('/:file', (req, res, next) => {
    const allowed = [
        'index.html',
        'style.css',
        'library.css',
        'script.js',
        'library.js'
    ];

    if (allowed.includes(req.params.file)) {
        return res.sendFile(path.join(root, req.params.file));
    }

    next();
});

// ERROR HANDLER
app.use((error, req, res, next) => {
    console.error('[SteadySight Error]', error);

    if (res.headersSent) return next(error);

    const status = error instanceof multer.MulterError
        ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        : 400;

    res.status(status).json({
        error: error.message || 'Request failed.'
    });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, '0.0.0.0', () => {
    console.log(`SteadySight running on port ${port}`);
});
