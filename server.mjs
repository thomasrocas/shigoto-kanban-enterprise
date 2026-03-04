import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import path from 'path'

const app = express()
const PORT = Number(process.env.PORT || 4273)
const DATA_PATH = path.resolve(process.cwd(), process.env.KANBAN_DATA_PATH || './kanban-data.local.json')

const emptyColumns = {
  todo: [],
  doing: [],
  review: [],
  done: [],
}

const defaultSettings = {
  autoArchiveEnabled: true,
  autoArchiveDays: 7,
  showDeleteConfirm: true,
  defaultArchiveReason: 'Manually archived',
}

const emptyState = {
  columns: emptyColumns,
  archived: [],
  settings: defaultSettings,
}

app.use(cors())
app.use(express.json({ limit: '1mb' }))

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw)

    // backward compatibility (old flat board format)
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
      }
    }

    return {
      columns: { ...emptyColumns, ...(parsed.columns || {}) },
      archived: parsed.archived || [],
      settings: { ...defaultSettings, ...(parsed.settings || {}) },
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

app.get('/api/board', async (_req, res) => {
  const state = await readState()
  res.json(state)
})

app.put('/api/board', async (req, res) => {
  const state = req.body
  const saved = await writeState(state)
  res.json(saved)
})

app.get('/api/tasks', async (req, res) => {
  const state = await readState()
  const archived = String(req.query.archived || 'false') === 'true'

  if (archived) return res.json(state.archived)

  const active = Object.values(state.columns).flat()
  return res.json(active)
})

app.post('/api/tasks/:id/archive', async (req, res) => {
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

app.post('/api/tasks/:id/restore', async (req, res) => {
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

app.post('/api/intake', async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text is required' })

  const state = await readState()

  const dueMatch = text.match(/due\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/i)
  const priorityMatch = text.match(/priority\s+(high|med|low)/i)

  const task = {
    id: crypto.randomUUID(),
    title: text
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

app.listen(PORT, () => {
  console.log(`Kanban sync API running on http://127.0.0.1:${PORT}`)
  console.log(`Data file: ${DATA_PATH}`)
})
