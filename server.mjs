import crypto from 'crypto'
import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import path from 'path'

const app = express()
const PORT = Number(process.env.PORT || 4273)
const DATA_PATH = path.resolve(process.cwd(), process.env.KANBAN_DATA_PATH || './kanban-data.local.json')
const AUDIT_PATH = path.resolve(process.cwd(), process.env.AUDIT_LOG_PATH || './audit.log')
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitWindows = new Map() // ip -> { count, resetAt }

function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown'
    const now = Date.now()
    let entry = rateLimitWindows.get(ip)

    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs }
      rateLimitWindows.set(ip, entry)
      return next()
    }

    entry.count++
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000))
      return res.status(429).json({ error: 'Too many requests — slow down.' })
    }
    next()
  }
}

// ─── Webhook signature validation ────────────────────────────────────────────

function verifyWebhookSignature(req, res, next) {
  if (!WEBHOOK_SECRET) return next() // skip if not configured

  const sig = req.headers['x-webhook-signature']
  if (!sig) return res.status(401).json({ error: 'Missing X-Webhook-Signature header.' })

  const payload = JSON.stringify(req.body)
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')

  // Constant-time comparison to prevent timing attacks
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    auditLog({ event: 'webhook.invalid_signature', ip: req.ip, path: req.path })
    return res.status(401).json({ error: 'Invalid webhook signature.' })
  }
  next()
}

// ─── Audit logging ────────────────────────────────────────────────────────────

async function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  try {
    await fs.appendFile(AUDIT_PATH, line)
  } catch {
    // non-fatal — don't crash the server over audit write failures
  }
}

function auditMiddleware(event) {
  return (req, _res, next) => {
    auditLog({ event, ip: req.ip, method: req.method, path: req.path }).catch(() => {})
    next()
  }
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

const emptyColumns = { todo: [], doing: [], review: [], done: [] }

const defaultSettings = {
  autoArchiveEnabled: true,
  autoArchiveDays: 7,
  showDeleteConfirm: true,
  defaultArchiveReason: 'Manually archived',
}

const emptyState = { columns: emptyColumns, archived: [], settings: defaultSettings }

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw)

    if (parsed.todo || parsed.doing || parsed.review || parsed.done) {
      return {
        columns: {
          todo: parsed.todo || [],
          doing: parsed.doing || [],
          review: parsed.review || [],
          done: parsed.done || [],
        },
        archived: parsed.archived || [],
        settings: { ...defaultSettings, ...(parsed.settings || {}) },
        projects: parsed.projects || [],
      }
    }

    return {
      columns: { ...emptyColumns, ...(parsed.columns || {}) },
      archived: parsed.archived || [],
      settings: { ...defaultSettings, ...(parsed.settings || {}) },
      projects: parsed.projects || [],
    }
  } catch {
    await fs.writeFile(DATA_PATH, JSON.stringify(emptyState, null, 2))
    return emptyState
  }
}

async function writeState(state) {
  const next = {
    columns: { ...emptyColumns, ...(state.columns || {}) },
    archived: state.archived || [],
    settings: { ...defaultSettings, ...(state.settings || {}) },
    projects: state.projects || [],
  }
  await fs.writeFile(DATA_PATH, JSON.stringify(next, null, 2))
  return next
}

function findTaskInColumns(columns, taskId) {
  for (const key of ['todo', 'doing', 'review', 'done']) {
    const idx = columns[key].findIndex((t) => t.id === taskId)
    if (idx >= 0) return { column: key, index: idx, task: columns[key][idx] }
  }
  return null
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use(rateLimit({ windowMs: 60_000, max: 120 }))

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/board', async (_req, res) => {
  const state = await readState()
  res.json(state)
})

app.put('/api/board', auditMiddleware('board.save'), async (req, res) => {
  const state = req.body
  const saved = await writeState(state)
  res.json(saved)
})

app.get('/api/tasks', async (req, res) => {
  const state = await readState()
  const archived = String(req.query.archived || 'false') === 'true'
  if (archived) return res.json(state.archived)
  return res.json(Object.values(state.columns).flat())
})

app.post('/api/tasks/:id/archive', auditMiddleware('task.archive'), async (req, res) => {
  const { id } = req.params
  const { archivedBy = 'manual', reason = null } = req.body || {}

  const state = await readState()
  const found = findTaskInColumns(state.columns, id)
  if (!found) return res.status(404).json({ error: 'task not found' })

  state.columns[found.column].splice(found.index, 1)
  const archivedTask = {
    ...found.task,
    archived: true,
    archivedAt: new Date().toISOString(),
    archivedBy,
    archivedReason: reason,
    previousStatus: found.column,
  }
  state.archived.unshift(archivedTask)
  await writeState(state)
  res.json({ ok: true, task: archivedTask })
})

app.post('/api/tasks/:id/restore', auditMiddleware('task.restore'), async (req, res) => {
  const { id } = req.params
  const state = await readState()

  const idx = state.archived.findIndex((t) => t.id === id)
  if (idx < 0) return res.status(404).json({ error: 'archived task not found' })

  const archivedTask = state.archived[idx]
  state.archived.splice(idx, 1)

  const target = archivedTask.previousStatus || 'todo'
  const restored = {
    ...archivedTask,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    previousStatus: null,
  }
  state.columns[target].unshift(restored)
  await writeState(state)
  res.json({ ok: true, task: restored })
})

// Intake webhook — optional signature validation
app.post('/api/intake', rateLimit({ windowMs: 60_000, max: 20 }), verifyWebhookSignature, auditMiddleware('webhook.intake'), async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text is required' })

  // Basic input sanitisation — strip control chars, cap length
  const sanitised = text.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500)
  if (!sanitised) return res.status(400).json({ error: 'text contained only control characters' })

  const state = await readState()

  const dueMatch = sanitised.match(/due\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/i)
  const priorityMatch = sanitised.match(/priority\s+(high|med|low)/i)

  const task = {
    id: crypto.randomUUID(),
    title: sanitised
      .replace(/due\s+[0-9]{4}-[0-9]{2}-[0-9]{2}/i, '')
      .replace(/priority\s+(high|med|low)/i, '')
      .trim(),
    description: 'Captured from channel message',
    dueDate: dueMatch?.[1],
    priority: priorityMatch ? priorityMatch[1][0].toUpperCase() + priorityMatch[1].slice(1).toLowerCase() : 'Med',
    reminderAck: false,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    archivedReason: null,
    previousStatus: null,
  }

  state.columns.todo = [task, ...state.columns.todo]
  await writeState(state)
  res.json({ ok: true, task })
})

// Audit log viewer (last N lines)
app.get('/api/audit', async (req, res) => {
  const n = Math.min(parseInt(req.query.limit || '100', 10), 1000)
  try {
    const raw = await fs.readFile(AUDIT_PATH, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const recent = lines.slice(-n).map((l) => {
      try { return JSON.parse(l) } catch { return { raw: l } }
    })
    res.json({ count: recent.length, entries: recent.reverse() })
  } catch {
    res.json({ count: 0, entries: [] })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Kanban sync API running on http://127.0.0.1:${PORT}`)
  console.log(`Data file: ${DATA_PATH}`)
  console.log(`Audit log: ${AUDIT_PATH}`)
  console.log(`Webhook signature validation: ${WEBHOOK_SECRET ? 'enabled' : 'disabled (set WEBHOOK_SECRET to enable)'}`)
})
