const express = require('express')
const session = require('express-session')
const pg = require('pg')
const connectPgSimple = require('connect-pg-simple')
const bcrypt = require('bcryptjs')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
require('dotenv').config()

const { Pool } = pg
const root = path.resolve(__dirname, '..')

const uploadDir = path.join(root, 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured.')
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
})

pool.on('error', error => {
  console.error('[PostgreSQL Pool Error]', error)
})

const app = express()
app.disable('x-powered-by')

const isProduction =
  process.env.NODE_ENV === 'production' || !!process.env.RENDER

if (isProduction) {
  app.set('trust proxy', 1)
}

app.use(express.json({ limit: '32kb' }))

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production.')
}

const PgSession = connectPgSimple(session)

app.use(
  session({
    name: 'steadysight.sid',
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'local-development-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    }
  })
)

app.use(
  '/uploads',
  express.static(uploadDir, {
    fallthrough: false,
    setHeaders (res) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
    }
  })
)

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
}

const baseMimeType = value =>
  String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()

const upload = multer({
  storage: multer.diskStorage({
    destination (req, file, callback) {
      callback(null, uploadDir)
    },
    filename (req, file, callback) {
      const extension = mediaExtensions[baseMimeType(file.mimetype)]
      callback(null, crypto.randomUUID() + extension)
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter (req, file, callback) {
    const mime = baseMimeType(file.mimetype)

    if (Object.hasOwn(mediaExtensions, mime)) {
      return callback(null, true)
    }

    callback(new Error(`Unsupported media type: ${file.mimetype}`))
  }
})

const api = express.Router()

const safeUser = user => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.created_at
})

function auth (req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Please log in to continue.'
    })
  }

  next()
}

function establishSession (req, res, userId, status = 200) {
  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({
        error: 'Could not start a secure session.'
      })
    }

    req.session.userId = Number(userId)

    req.session.save(async saveError => {
      if (saveError) {
        return res.status(500).json({
          error: 'Could not save the session.'
        })
      }

      try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [
          req.session.userId
        ])

        res.status(status).json({
          user: safeUser(result.rows[0])
        })
      } catch (error) {
        res.status(500).json({
          error: 'Could not load your account.'
        })
      }
    })
  })
}

function parseTags (value) {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map(tag => tag.trim())
      .filter(Boolean)
      .slice(0, 20)
  }

  return String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function captureRow (row, userId) {
  return {
    ...row,
    tags: JSON.parse(row.tags),
    mediaUrl: `/uploads/${encodeURIComponent(row.filename)}`,
    likeCount: Number(row.like_count),
    liked: !!row.liked,
    bookmarked: !!row.bookmarked,
    owner: Number(row.owner_id) === Number(userId)
  }
}

const selection = `
  c.id, c.title, c.description, c.type, c.mime_type,
  c.filename, c.category, c.tags, c.created_at, c.owner_id,
  (SELECT COUNT(*) FROM likes l
    WHERE l.capture_id = c.id) AS like_count,
  EXISTS(
    SELECT 1 FROM likes l
    WHERE l.capture_id = c.id AND l.user_id = $1
  ) AS liked,
  EXISTS(
    SELECT 1 FROM bookmarks b
    WHERE b.capture_id = c.id AND b.user_id = $2
  ) AS bookmarked
`

// REGISTER
api.post('/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim()
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase()
    const password = String(req.body.password || '')

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: 'Name must be 2–80 characters.'
      })
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address.'
      })
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: 'Password must be 8–128 characters.'
      })
    }

    const hash = await bcrypt.hash(password, 12)

    const result = await pool.query(
      `INSERT INTO users(name, email, password_hash)
       VALUES($1, $2, $3)
       RETURNING id`,
      [name, email, hash]
    )

    establishSession(req, res, result.rows[0].id, 201)
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'An account with that email already exists.'
      })
    }

    next(error)
  }
})

// LOGIN
api.post('/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase()
    const password = String(req.body.password || '')

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [
      email
    ])

    const user = result.rows[0]

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      })
    }

    establishSession(req, res, user.id)
  } catch (error) {
    next(error)
  }
})

// LOGOUT
api.post('/auth/logout', (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: 'Could not log out.'
      })
    }

    res.clearCookie('steadysight.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/'
    })

    res.json({ ok: true })
  })
})

// CURRENT USER
api.get('/auth/me', async (req, res, next) => {
  try {
    const result = req.session.userId
      ? await pool.query('SELECT * FROM users WHERE id = $1', [
          req.session.userId
        ])
      : { rows: [] }

    const user = result.rows[0]

    res.json({
      user: user ? safeUser(user) : null
    })
  } catch (error) {
    next(error)
  }
})

// PROFILE
api.get('/profile', auth, async (req, res, next) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [
      req.session.userId
    ])

    const user = userResult.rows[0]

    if (!user) {
      return res.status(401).json({
        error: 'Please log in to continue.'
      })
    }

    const statsResult = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE type = 'video') AS videos,
        COUNT(*) FILTER (WHERE type = 'photo') AS photos
       FROM captures
       WHERE owner_id = $1`,
      [user.id]
    )

    const activityResult = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM likes WHERE user_id = $1) AS likes,
        (SELECT COUNT(*) FROM bookmarks WHERE user_id = $1) AS bookmarks`,
      [user.id]
    )

    const stats = statsResult.rows[0]
    const activities = activityResult.rows[0]

    res.json({
      user: safeUser(user),
      stats: {
        total: Number(stats.total),
        videos: Number(stats.videos),
        photos: Number(stats.photos),
        likes: Number(activities.likes),
        bookmarks: Number(activities.bookmarks)
      }
    })
  } catch (error) {
    next(error)
  }
})

// LIST CAPTURES
api.get('/captures', auth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const type = ['video', 'photo'].includes(req.query.type)
      ? req.query.type
      : ''
    const category = String(req.query.category || '').trim()
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC'
    const userId = req.session.userId

    const result = await pool.query(
      `SELECT ${selection}
       FROM captures c
       WHERE c.owner_id = $3
       AND ($4 = '' OR c.title ILIKE $5 OR c.description ILIKE $5)
       AND ($6 = '' OR c.type = $6)
       AND ($7 = '' OR c.category = $7)
       ORDER BY c.created_at ${sort}, c.id ${sort}`,
      [userId, userId, userId, q, `%${q}%`, type, category]
    )

    const categoryResult = await pool.query(
      `SELECT DISTINCT category
       FROM captures
       WHERE owner_id = $1
       ORDER BY category`,
      [userId]
    )

    res.json({
      captures: result.rows.map(row => captureRow(row, userId)),
      categories: categoryResult.rows.map(row => row.category)
    })
  } catch (error) {
    next(error)
  }
})

// CREATE CAPTURE
api.post('/captures', auth, upload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No media file was uploaded.'
      })
    }

    const receivedMimeType = baseMimeType(req.file.mimetype)
    const reportedMimeType = String(
      req.body.mimeType || req.file.mimetype
    ).trim()

    const validReportedMime =
      /^(image\/(jpeg|png|webp)|video\/(webm|mp4|ogg|quicktime|x-matroska|3gpp2?))(?:\s*;\s*codecs\s*=\s*[a-z0-9., _-]+)?$/i.test(
        reportedMimeType
      )

    if (
      !validReportedMime ||
      reportedMimeType.length > 160 ||
      baseMimeType(reportedMimeType) !== receivedMimeType
    ) {
      fs.unlink(req.file.path, () => {})

      return res.status(400).json({
        error: 'Uploaded media MIME type does not match.'
      })
    }

    const title = String(req.body.title || '').trim()
    const category = String(req.body.category || '').trim()
    const description = String(req.body.description || '').trim()

    if (
      !title ||
      title.length > 120 ||
      !category ||
      category.length > 60 ||
      description.length > 2000
    ) {
      fs.unlink(req.file.path, () => {})

      return res.status(400).json({
        error: 'Title and category are required. Check field lengths.'
      })
    }

    const type = receivedMimeType.startsWith('video/') ? 'video' : 'photo'

    const id = crypto.randomUUID()

    await pool.query(
      `INSERT INTO captures(
        id, title, description, type, mime_type,
        filename, category, tags, owner_id
      )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        title,
        description,
        type,
        reportedMimeType,
        req.file.filename,
        category,
        JSON.stringify(parseTags(req.body.tags)),
        req.session.userId
      ]
    )

    const result = await pool.query(
      `SELECT ${selection}
       FROM captures c
       WHERE c.id = $3 AND c.owner_id = $4`,
      [req.session.userId, req.session.userId, id, req.session.userId]
    )

    res.status(201).json({
      capture: captureRow(result.rows[0], req.session.userId)
    })
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {})
    next(error)
  }
})

// GET ONE CAPTURE
api.get('/captures/:id', auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${selection}
       FROM captures c
       WHERE c.id = $3 AND c.owner_id = $4`,
      [
        req.session.userId,
        req.session.userId,
        req.params.id,
        req.session.userId
      ]
    )

    const row = result.rows[0]

    if (!row) {
      return res.status(404).json({
        error: 'Capture not found.'
      })
    }

    res.json({
      capture: captureRow(row, req.session.userId)
    })
  } catch (error) {
    next(error)
  }
})

// UPDATE CAPTURE
api.put('/captures/:id', auth, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim()
    const category = String(req.body.category || '').trim()
    const description = String(req.body.description || '').trim()

    if (
      !title ||
      title.length > 120 ||
      !category ||
      category.length > 60 ||
      description.length > 2000
    ) {
      return res.status(400).json({
        error: 'Title and category are required. Check field lengths.'
      })
    }

    const result = await pool.query(
      `UPDATE captures
       SET title = $1, description = $2, category = $3, tags = $4
       WHERE id = $5 AND owner_id = $6`,
      [
        title,
        description,
        category,
        JSON.stringify(parseTags(req.body.tags)),
        req.params.id,
        req.session.userId
      ]
    )

    if (!result.rowCount) {
      const exists = await pool.query('SELECT id FROM captures WHERE id = $1', [
        req.params.id
      ])

      return res.status(exists.rowCount ? 403 : 404).json({
        error: 'Capture not found or not yours.'
      })
    }

    const updated = await pool.query(
      `SELECT ${selection}
       FROM captures c
       WHERE c.id = $3`,
      [req.session.userId, req.session.userId, req.params.id]
    )

    res.json({
      capture: captureRow(updated.rows[0], req.session.userId)
    })
  } catch (error) {
    next(error)
  }
})

// DELETE CAPTURE
api.delete('/captures/:id', auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT filename, owner_id FROM captures WHERE id = $1',
      [req.params.id]
    )

    const row = result.rows[0]

    if (!row) {
      return res.status(404).json({
        error: 'Capture not found.'
      })
    }

    if (Number(row.owner_id) !== Number(req.session.userId)) {
      return res.status(403).json({
        error: 'You can only delete your own captures.'
      })
    }

    await pool.query('DELETE FROM captures WHERE id = $1', [req.params.id])

    fs.unlink(path.join(uploadDir, row.filename), () => {})

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

// LIKE AND BOOKMARK
for (const [table, verb, route] of [
  ['likes', 'liked', 'like'],
  ['bookmarks', 'bookmarked', 'bookmark']
]) {
  api.post(`/captures/:id/${route}`, auth, async (req, res, next) => {
    try {
      const existsCapture = await pool.query(
        'SELECT id FROM captures WHERE id = $1',
        [req.params.id]
      )

      if (!existsCapture.rowCount) {
        return res.status(404).json({
          error: 'Capture not found.'
        })
      }

      const exists = await pool.query(
        `SELECT 1 FROM ${table}
         WHERE user_id = $1 AND capture_id = $2`,
        [req.session.userId, req.params.id]
      )

      if (exists.rowCount) {
        await pool.query(
          `DELETE FROM ${table}
           WHERE user_id = $1 AND capture_id = $2`,
          [req.session.userId, req.params.id]
        )
      } else {
        await pool.query(
          `INSERT INTO ${table}(user_id, capture_id)
           VALUES($1, $2)
           ON CONFLICT DO NOTHING`,
          [req.session.userId, req.params.id]
        )
      }

      res.json({
        [verb]: !exists.rowCount
      })
    } catch (error) {
      next(error)
    }
  })
}

app.use('/api', api)

// FRONTEND
app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'index.html'))
})

app.get('/:file', (req, res, next) => {
  const allowed = [
    'index.html',
    'style.css',
    'library.css',
    'script.js',
    'library.js'
  ]

  if (allowed.includes(req.params.file)) {
    return res.sendFile(path.join(root, req.params.file))
  }

  next()
})

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error('[SteadySight Error]', error)

  if (res.headersSent) return next(error)

  const status =
    error instanceof multer.MulterError
      ? error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400
      : 400

  res.status(status).json({
    error: error.message || 'Request failed.'
  })
})

// CREATE DATABASE TABLES
async function startServer () {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('video', 'photo')),
      mime_type TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  `)

  const port = Number(process.env.PORT) || 3000

  app.listen(port, '0.0.0.0', () => {
    console.log(`SteadySight running on port ${port}`)
    console.log('Connected to PostgreSQL database.')
  })
}

startServer().catch(error => {
  console.error('[Database Startup Error]', error)
  process.exit(1)
})
