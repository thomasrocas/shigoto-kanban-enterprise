import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertTriangle,
  Archive,
  BellRing,
  LayoutGrid,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'

type ColumnId = 'todo' | 'doing' | 'review' | 'done'
type Priority = 'Low' | 'Med' | 'High'
type Filter = 'all' | 'today' | 'overdue' | 'high'
type ArchiveSource = 'auto' | 'manual' | null
type Organization = 'home-health' | 'hospice' | 'ligare'

type Task = {
  id: string
  title: string
  description: string
  priority: Priority
  dueDate?: string
  reminderAck?: boolean
  archived: boolean
  archivedAt: string | null
  archivedBy: ArchiveSource
  archivedReason: string | null
  previousStatus: ColumnId | null
  organization?: Organization
  projectId?: string
  owner?: string
}

type Board = Record<ColumnId, Task[]>
type Project = {
  id: string
  name: string
  organization: Organization
}
type ColumnSetting = {
  title: string
  accent: string
  icon?: string
  wipLimit?: number
}

type ArchiveSettings = {
  autoArchiveEnabled: boolean
  autoArchiveDays: number
  showDeleteConfirm: boolean
  defaultArchiveReason: string
  titleOnlyGlobal: boolean
  titleOnlyTaskIds: string[]
  titleOnlyColumns: ColumnId[]
  columnOrder: ColumnId[]
  columnSettings: Record<ColumnId, ColumnSetting>
}
type BoardState = { columns: Board; archived: Task[]; settings: ArchiveSettings; projects: Project[] }

const columnMeta: Record<ColumnId, ColumnSetting> = {
  todo: { title: 'Backlog', accent: '#8b5cf6', icon: '🗂️' },
  doing: { title: 'In Progress', accent: '#06b6d4', icon: '⚙️' },
  review: { title: 'Review', accent: '#f59e0b', icon: '🔎' },
  done: { title: 'Done', accent: '#22c55e', icon: '✅' },
}

const todayISO = new Date().toISOString().slice(0, 10)

const emptyBoard: Board = { todo: [], doing: [], review: [], done: [] }
const defaultSettings: ArchiveSettings = {
  autoArchiveEnabled: true,
  autoArchiveDays: 7,
  showDeleteConfirm: true,
  defaultArchiveReason: 'Manually archived',
  titleOnlyGlobal: false,
  titleOnlyTaskIds: [],
  titleOnlyColumns: [],
  columnOrder: ['todo', 'doing', 'review', 'done'],
  columnSettings: columnMeta,
}
const defaultProjects: Project[] = [
  { id: 'p-hh', name: 'Home Health Ops', organization: 'home-health' },
  { id: 'p-hospice', name: 'Hospice Ops', organization: 'hospice' },
  { id: 'p-ligare', name: 'Ligare BPO', organization: 'ligare' },
]
const seed: BoardState = {
  columns: emptyBoard,
  archived: [],
  settings: defaultSettings,
  projects: defaultProjects,
}

function asStartOfDay(dateISO: string) {
  return new Date(`${dateISO}T00:00:00`)
}

function isToday(dateISO?: string) {
  if (!dateISO) return false
  return dateISO === todayISO
}

function isOverdue(task: Task, columnId?: ColumnId) {
  if (!task.dueDate) return false
  if (columnId === 'done') return false
  return asStartOfDay(task.dueDate).getTime() < asStartOfDay(todayISO).getTime()
}

function matchesFilter(task: Task, filter: Filter, columnId?: ColumnId) {
  if (filter === 'all') return true
  if (filter === 'today') return isToday(task.dueDate)
  if (filter === 'overdue') return isOverdue(task, columnId)
  if (filter === 'high') return task.priority === 'High'
  return true
}

function formatDue(dateISO?: string) {
  if (!dateISO) return 'No due date'
  const date = new Date(`${dateISO}T00:00:00`)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—'
  const date = new Date(iso)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function App() {
  const [data, setData] = useState<BoardState>(seed)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState<Priority>('Med')
  const [owner, setOwner] = useState('')
  const [organization, setOrganization] = useState<Organization>('home-health')
  const [projectId, setProjectId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [orgFilter, setOrgFilter] = useState<'all' | Organization>('all')
  const [projectFilter, setProjectFilter] = useState<'all' | string>('all')
  const [search, setSearch] = useState('')

  const [archiveSourceFilter, setArchiveSourceFilter] = useState<'all' | 'auto' | 'manual'>('all')
  const [archiveFrom, setArchiveFrom] = useState('')
  const [archiveTo, setArchiveTo] = useState('')

  const [view, setView] = useState<'active' | 'archived'>(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('view') === 'archived' ? 'archived' : 'active'
  })

  const board = data.columns
  const orderedColumns = useMemo<ColumnId[]>(() => {
    const valid = (data.settings.columnOrder || []).filter((c): c is ColumnId =>
      ['todo', 'doing', 'review', 'done'].includes(c),
    )
    const missing = (['todo', 'doing', 'review', 'done'] as ColumnId[]).filter((c) => !valid.includes(c))
    return [...valid, ...missing]
  }, [data.settings.columnOrder])

  const getColumnConfig = (columnId: ColumnId): ColumnSetting => ({
    ...columnMeta[columnId],
    ...(data.settings.columnSettings?.[columnId] || {}),
  })

  const allTasks = useMemo(() => Object.values(board).flat(), [board])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    p.set('view', view)
    window.history.replaceState({}, '', `${window.location.pathname}?${p.toString()}`)
  }, [view])

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('http://127.0.0.1:4173/api/board')
        if (!res.ok) return
        const remote = (await res.json()) as BoardState
        const remoteSettings = remote.settings || defaultSettings
        const normalizedSettings: ArchiveSettings = {
          ...defaultSettings,
          ...remoteSettings,
          columnOrder:
            remoteSettings.columnOrder?.filter((c): c is ColumnId => ['todo', 'doing', 'review', 'done'].includes(c)) ||
            defaultSettings.columnOrder,
          columnSettings: {
            ...defaultSettings.columnSettings,
            ...(remoteSettings.columnSettings || {}),
          },
        }

        const normalized: BoardState = {
          columns: { ...emptyBoard, ...(remote.columns || emptyBoard) },
          archived: remote.archived || [],
          settings: normalizedSettings,
          projects: remote.projects?.length ? remote.projects : defaultProjects,
        }
        setData(normalized)
      } catch {
        // API not running
      }
    }
    void load()
  }, [])

  async function persist(next: BoardState) {
    setData(next)
    try {
      await fetch('http://127.0.0.1:4173/api/board', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
    } catch {
      // best effort local update
    }
  }

  // Auto-archive old done tasks
  useEffect(() => {
    if (!data.settings.autoArchiveEnabled) return
    const ms = data.settings.autoArchiveDays * 24 * 60 * 60 * 1000
    const staleDone = board.done.filter(
      (t) => t.dueDate && asStartOfDay(t.dueDate).getTime() < Date.now() - ms,
    )
    if (staleDone.length === 0) return

    const nextDone = board.done.filter((t) => !staleDone.some((s) => s.id === t.id))
    const moved = staleDone.map((t) => ({
      ...t,
      archived: true,
      archivedAt: new Date().toISOString(),
      archivedBy: 'auto' as const,
      archivedReason: 'Auto-archived from Done (stale)',
      previousStatus: 'done' as ColumnId,
    }))

    void persist({
      columns: { ...board, done: nextDone },
      archived: [...moved, ...data.archived],
      settings: data.settings,
      projects: data.projects,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.done.length, data.settings.autoArchiveEnabled, data.settings.autoArchiveDays])

  function findColumn(taskId: string): ColumnId | undefined {
    return (Object.keys(board) as ColumnId[]).find((col) => board[col].some((task) => task.id === taskId))
  }

  function updateTask(taskId: string, patch: Partial<Task>) {
    const col = findColumn(taskId)
    if (!col) return
    void persist({
      ...data,
      columns: {
        ...board,
        [col]: board[col].map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
      },
    })
  }

  function openEditor(taskId: string) {
    const task = allTasks.find((t) => t.id === taskId)
    if (task) setEditingTask(task)
  }

  function saveEditor(task: Task) {
    updateTask(task.id, task)
    setEditingTask(null)
  }

  function saveSettings(next: ArchiveSettings) {
    void persist({ ...data, settings: next })
    setSettingsOpen(false)
  }

  function saveProjects(next: Project[]) {
    void persist({ ...data, projects: next })
    setProjectsOpen(false)
  }

  function toggleTaskTitleOnly(taskId: string) {
    const set = new Set(data.settings.titleOnlyTaskIds)
    if (set.has(taskId)) set.delete(taskId)
    else set.add(taskId)
    void persist({
      ...data,
      settings: { ...data.settings, titleOnlyTaskIds: Array.from(set) },
    })
  }

  function toggleColumnTitleOnly(columnId: ColumnId) {
    const set = new Set(data.settings.titleOnlyColumns)
    if (set.has(columnId)) set.delete(columnId)
    else set.add(columnId)
    void persist({
      ...data,
      settings: { ...data.settings, titleOnlyColumns: Array.from(set) },
    })
  }

  function archiveTask(taskId: string, by: 'manual' | 'auto' = 'manual', reason?: string) {
    const col = findColumn(taskId)
    if (!col) return
    const task = board[col].find((t) => t.id === taskId)
    if (!task) return

    const archivedTask: Task = {
      ...task,
      archived: true,
      archivedAt: new Date().toISOString(),
      archivedBy: by,
      archivedReason:
        reason ||
        (by === 'manual' ? data.settings.defaultArchiveReason : 'Automatically archived'),
      previousStatus: col,
    }

    void persist({
      columns: {
        ...board,
        [col]: board[col].filter((t) => t.id !== taskId),
      },
      archived: [archivedTask, ...data.archived],
      settings: data.settings,
      projects: data.projects,
    })
  }

  function restoreTask(taskId: string) {
    const task = data.archived.find((t) => t.id === taskId)
    if (!task) return
    const target: ColumnId = task.previousStatus || 'todo'
    const restored: Task = {
      ...task,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
      previousStatus: null,
    }

    void persist({
      columns: { ...board, [target]: [restored, ...board[target]] },
      archived: data.archived.filter((t) => t.id !== taskId),
      settings: data.settings,
      projects: data.projects,
    })
  }

  function deleteArchived(taskId: string) {
    if (data.settings.showDeleteConfirm && !window.confirm('Delete this archived task permanently?')) return
    void persist({ ...data, archived: data.archived.filter((t) => t.id !== taskId) })
  }

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    const task = allTasks.find((t) => t.id === id) || null
    setActiveTask(task)
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)

    const from = findColumn(activeId)
    if (!from) return

    const to = orderedColumns.includes(overId as ColumnId) ? (overId as ColumnId) : findColumn(overId)

    if (!to) return

    if (from === to) {
      const fromTasks = board[from]
      const oldIndex = fromTasks.findIndex((t) => t.id === activeId)
      const newIndex = fromTasks.findIndex((t) => t.id === overId)
      if (oldIndex === -1 || newIndex === -1) return
      void persist({ ...data, columns: { ...board, [from]: arrayMove(fromTasks, oldIndex, newIndex) } })
      return
    }

    const movingTask = board[from].find((t) => t.id === activeId)
    if (!movingTask) return

    const fromTasks = board[from].filter((t) => t.id !== activeId)
    const toTasks = [...board[to]]
    const overIndex = toTasks.findIndex((t) => t.id === overId)
    const insertAt = overIndex < 0 ? toTasks.length : overIndex
    toTasks.splice(insertAt, 0, movingTask)

    void persist({
      ...data,
      columns: {
        ...board,
        [from]: fromTasks,
        [to]: toTasks,
      },
    })
  }

  function addTask() {
    if (!title.trim()) return
    const task: Task = {
      id: crypto.randomUUID(),
      title: title.trim(),
      description: desc.trim(),
      priority,
      dueDate: dueDate || undefined,
      reminderAck: false,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
      previousStatus: null,
      owner: owner.trim() || undefined,
      organization,
      projectId: projectId || undefined,
    }
    void persist({ ...data, columns: { ...board, todo: [task, ...board.todo] } })
    setTitle('')
    setDesc('')
    setPriority('Med')
    setOwner('')
    setOrganization('home-health')
    setProjectId('')
    setDueDate('')
  }

  function removeTask(taskId: string) {
    const col = findColumn(taskId)
    if (!col) return
    void persist({ ...data, columns: { ...board, [col]: board[col].filter((t) => t.id !== taskId) } })
  }

  const upcomingTimeline = useMemo(() => {
    return (Object.entries(board) as [ColumnId, Task[]][])
      .flatMap(([columnId, tasks]) => tasks.map((task) => ({ task, columnId })))
      .filter(({ task, columnId }) => !!task.dueDate && columnId !== 'done')
      .filter(({ task }) => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return `${task.title} ${task.description}`.toLowerCase().includes(q)
      })
      .sort((a, b) => (a.task.dueDate! > b.task.dueDate! ? 1 : -1))
      .slice(0, 8)
  }, [board, search])

  const archivedViewTasks = useMemo(() => {
    return data.archived
      .filter((t) => (archiveSourceFilter === 'all' ? true : t.archivedBy === archiveSourceFilter))
      .filter((t) => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return `${t.title} ${t.description}`.toLowerCase().includes(q)
      })
      .filter((t) => {
        const at = t.archivedAt ? new Date(t.archivedAt).toISOString().slice(0, 10) : ''
        if (archiveFrom && at < archiveFrom) return false
        if (archiveTo && at > archiveTo) return false
        return true
      })
  }, [data.archived, archiveSourceFilter, search, archiveFrom, archiveTo])

  return (
    <div className="app-shell">
      <aside className={`left-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button className="sidebar-toggle" onClick={() => setSidebarCollapsed((v) => !v)}>
          <Menu size={16} />
          {!sidebarCollapsed && <span>Menu</span>}
        </button>

        <button className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>
          <LayoutGrid size={16} />
          {!sidebarCollapsed && <span>Board</span>}
        </button>

        <button className={view === 'archived' ? 'active' : ''} onClick={() => setView('archived')}>
          <Archive size={16} />
          {!sidebarCollapsed && (
            <>
              <span>Archived</span>
              <b className="badge">{data.archived.length}</b>
            </>
          )}
        </button>

        <button onClick={() => setProjectsOpen(true)}>
          <LayoutGrid size={16} />
          {!sidebarCollapsed && <span>Projects</span>}
        </button>

        <button onClick={() => setSettingsOpen(true)}>
          <Settings2 size={16} />
          {!sidebarCollapsed && <span>Settings</span>}
        </button>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <h1>
              <Sparkles size={22} /> Shigoto Kanban
            </h1>
            <p>Now with due dates, reminders, filters, timeline, and archive control center.</p>
          </div>
        </header>

        {view === 'active' ? (
          <>
            <section className="composer">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="One-line description" />
              <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" />
              <select value={organization} onChange={(e) => setOrganization(e.target.value as Organization)}>
                <option value="home-health">Home Health</option>
                <option value="hospice">Hospice</option>
                <option value="ligare">Ligare</option>
              </select>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                <option>Low</option>
                <option>Med</option>
                <option>High</option>
              </select>
              <div className="date-input-wrap">
                <input id="composer-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <button onClick={addTask}>
                <Plus size={16} /> Add
              </button>
            </section>

            <section className="filters">
              {(['all', 'today', 'overdue', 'high'] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'today' ? 'Today' : f === 'overdue' ? 'Overdue' : 'High Priority'}
                </button>
              ))}
              <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value as 'all' | Organization)}>
                <option value="all">All Orgs</option>
                <option value="home-health">Home Health</option>
                <option value="hospice">Hospice</option>
                <option value="ligare">Ligare</option>
              </select>
              <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
                <option value="all">All Projects</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button onClick={() => saveSettings({ ...data.settings, titleOnlyGlobal: !data.settings.titleOnlyGlobal })}>
                {data.settings.titleOnlyGlobal ? 'Full Cards' : 'Title Only'}
              </button>
            </section>

            <div className="workspace">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              >
                <div className="board">
                  {orderedColumns.map((columnId) => {
                    const colConfig = getColumnConfig(columnId)
                    return (
                      <Column
                        key={columnId}
                        id={columnId}
                        title={`${colConfig.icon ? `${colConfig.icon} ` : ''}${colConfig.title}`}
                        accent={colConfig.accent}
                        wipLimit={colConfig.wipLimit}
                        tasks={board[columnId]}
                        filter={filter}
                        search={search}
                        orgFilter={orgFilter}
                        projectFilter={projectFilter}
                        titleOnlyGlobal={data.settings.titleOnlyGlobal}
                        titleOnlyColumns={data.settings.titleOnlyColumns}
                        titleOnlyTaskIds={data.settings.titleOnlyTaskIds}
                        projects={data.projects}
                        onDelete={removeTask}
                        onAcknowledge={(taskId) => updateTask(taskId, { reminderAck: true })}
                        onOpenEditor={openEditor}
                        onArchive={(taskId) => archiveTask(taskId, 'manual')}
                        onToggleTaskTitleOnly={toggleTaskTitleOnly}
                        onToggleColumnTitleOnly={toggleColumnTitleOnly}
                      />
                    )
                  })}
                </div>

                <DragOverlay>
                  {activeTask ? (
                    <TaskCard
                      task={activeTask}
                      onDelete={() => {}}
                      onAcknowledge={() => {}}
                      onOpenEditor={() => {}}
                      onArchive={() => {}}
                      onToggleTaskTitleOnly={() => {}}
                      titleOnly={false}
                      overlay
                    />
                  ) : null}
                </DragOverlay>
              </DndContext>

              <aside className="timeline">
                <h3>Timeline</h3>
                {upcomingTimeline.length === 0 ? (
                  <p className="timeline-empty">No upcoming due dates yet.</p>
                ) : (
                  <ul>
                    {upcomingTimeline.map(({ task, columnId }) => {
                      const overdue = isOverdue(task, columnId)
                      return (
                        <li key={task.id} className={overdue ? 'overdue' : ''}>
                          <div>
                            <strong>{task.title}</strong>
                            <small>{getColumnConfig(columnId).title}</small>
                          </div>
                          <span>{formatDue(task.dueDate)}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </aside>
            </div>
          </>
        ) : (
          <section className="archived-view">
            <div className="archived-toolbar">
              <div className="archived-title">
                <Archive size={18} /> Archived Tasks
              </div>
              <div className="archived-controls">
                <div className="search-box">
                  <Search size={14} />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search archived" />
                </div>
                <select
                  value={archiveSourceFilter}
                  onChange={(e) => setArchiveSourceFilter(e.target.value as 'all' | 'auto' | 'manual')}
                >
                  <option value="all">All sources</option>
                  <option value="auto">Auto-archived</option>
                  <option value="manual">Manual archive</option>
                </select>
                <input type="date" value={archiveFrom} onChange={(e) => setArchiveFrom(e.target.value)} />
                <input type="date" value={archiveTo} onChange={(e) => setArchiveTo(e.target.value)} />
              </div>
            </div>

            <div className="archived-list">
              {archivedViewTasks.length === 0 ? (
                <p className="timeline-empty">No archived tasks found for current filters.</p>
              ) : (
                archivedViewTasks.map((t) => (
                  <article key={t.id} className="archived-card">
                    <div className="card-head">
                      <strong>{t.title}</strong>
                    </div>
                    <p>{t.description || '—'}</p>
                    <div className="archived-meta">
                      <span>Original: {t.previousStatus ? columnMeta[t.previousStatus].title : 'Backlog'}</span>
                      <span>Archived: {formatDateTime(t.archivedAt)}</span>
                      <span>Source: {t.archivedBy || 'manual'}</span>
                      <span>Reason: {t.archivedReason || '—'}</span>
                    </div>
                    <div className="archived-actions">
                      <button className="ghost" onClick={() => restoreTask(t.id)}>
                        <RotateCcw size={14} /> Restore
                      </button>
                      <button className="danger" onClick={() => deleteArchived(t.id)}>
                        <Trash2 size={14} /> Delete permanently
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        )}

        {editingTask && (
          <TaskEditorModal
            task={editingTask}
            projects={data.projects}
            onClose={() => setEditingTask(null)}
            onSave={saveEditor}
          />
        )}
        {settingsOpen && (
          <ArchiveSettingsModal
            settings={data.settings}
            onClose={() => setSettingsOpen(false)}
            onSave={saveSettings}
          />
        )}
        {projectsOpen && (
          <ProjectsModal projects={data.projects} onClose={() => setProjectsOpen(false)} onSave={saveProjects} />
        )}
      </main>
    </div>
  )
}

function Column({
  id,
  title,
  accent,
  tasks,
  wipLimit,
  filter,
  search,
  orgFilter,
  projectFilter,
  titleOnlyGlobal,
  titleOnlyColumns,
  titleOnlyTaskIds,
  projects,
  onDelete,
  onAcknowledge,
  onOpenEditor,
  onArchive,
  onToggleTaskTitleOnly,
  onToggleColumnTitleOnly,
}: {
  id: ColumnId
  title: string
  accent: string
  tasks: Task[]
  wipLimit?: number
  filter: Filter
  search: string
  orgFilter: 'all' | Organization
  projectFilter: 'all' | string
  titleOnlyGlobal: boolean
  titleOnlyColumns: ColumnId[]
  titleOnlyTaskIds: string[]
  projects: Project[]
  onDelete: (id: string) => void
  onAcknowledge: (id: string) => void
  onOpenEditor: (id: string) => void
  onArchive: (id: string) => void
  onToggleTaskTitleOnly: (id: string) => void
  onToggleColumnTitleOnly: (id: ColumnId) => void
}) {
  const visibleTasks = tasks
    .filter((task) => !task.archived)
    .filter((task) => matchesFilter(task, filter, id))
    .filter((task) => (orgFilter === 'all' ? true : task.organization === orgFilter))
    .filter((task) => (projectFilter === 'all' ? true : task.projectId === projectFilter))
    .filter((task) => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return `${task.title} ${task.description} ${task.owner || ''}`.toLowerCase().includes(q)
    })

  return (
    <section className="column" style={{ '--accent': accent } as CSSProperties}>
      <header>
        <h2>{title}</h2>
        <div className="column-head-actions">
          <button className="icon" onClick={() => onToggleColumnTitleOnly(id)}>
            {titleOnlyColumns.includes(id) ? '↕' : '≡'}
          </button>
          <span>
            {visibleTasks.length}
            {wipLimit ? ` / ${wipLimit}` : ''}
          </span>
        </div>
      </header>
      <SortableContext items={visibleTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="stack" id={id}>
          {visibleTasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              onDelete={onDelete}
              onAcknowledge={onAcknowledge}
              onOpenEditor={onOpenEditor}
              onArchive={onArchive}
              onToggleTaskTitleOnly={onToggleTaskTitleOnly}
              titleOnly={titleOnlyGlobal || titleOnlyColumns.includes(id) || titleOnlyTaskIds.includes(task.id)}
              projectName={projects.find((p) => p.id === task.projectId)?.name}
              overdue={isOverdue(task, id)}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  )
}

function SortableTaskCard({
  task,
  onDelete,
  onAcknowledge,
  onOpenEditor,
  onArchive,
  onToggleTaskTitleOnly,
  titleOnly,
  projectName,
  overdue,
}: {
  task: Task
  onDelete: (id: string) => void
  onAcknowledge: (id: string) => void
  onOpenEditor: (id: string) => void
  onArchive: (id: string) => void
  onToggleTaskTitleOnly: (id: string) => void
  titleOnly: boolean
  projectName?: string
  overdue: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'dragging' : ''}
      {...attributes}
      {...listeners}
    >
      <TaskCard
        task={task}
        onDelete={onDelete}
        onAcknowledge={onAcknowledge}
        onOpenEditor={onOpenEditor}
        onArchive={onArchive}
        onToggleTaskTitleOnly={onToggleTaskTitleOnly}
        titleOnly={titleOnly}
        projectName={projectName}
        overdue={overdue}
      />
    </div>
  )
}

function TaskCard({
  task,
  onDelete,
  onAcknowledge,
  onOpenEditor,
  onArchive,
  onToggleTaskTitleOnly,
  titleOnly,
  projectName,
  overdue,
  overlay,
}: {
  task: Task
  onDelete: (id: string) => void
  onAcknowledge: (id: string) => void
  onOpenEditor: (id: string) => void
  onArchive: (id: string) => void
  onToggleTaskTitleOnly: (id: string) => void
  titleOnly?: boolean
  projectName?: string
  overdue?: boolean
  overlay?: boolean
}) {
  const showReminder = overdue && !task.reminderAck

  return (
    <article
      className={`card ${overlay ? 'overlay' : ''} ${overdue ? 'card-overdue' : ''}`}
      onClick={() => !overlay && onOpenEditor(task.id)}
    >
      <div className="card-head">
        <strong>{task.title}</strong>
        {!overlay && (
          <div className="card-actions-inline">
            <button
              className="icon"
              onClick={(e) => {
                e.stopPropagation()
                onToggleTaskTitleOnly(task.id)
              }}
              aria-label="Toggle title-only"
            >
              {titleOnly ? '↕' : '≡'}
            </button>
            <button
              className="icon"
              onClick={(e) => {
                e.stopPropagation()
                onArchive(task.id)
              }}
              aria-label="Archive task"
            >
              <Archive size={14} />
            </button>
            <button
              className="icon"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(task.id)
              }}
              aria-label="Delete task"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {!titleOnly && task.description && <p>{task.description}</p>}

      <div className="chips">
        <span className={`priority ${task.priority.toLowerCase()}`}>{task.priority}</span>
        {task.dueDate && <span className={`due ${overdue ? 'bad' : ''}`}>Due {formatDue(task.dueDate)}</span>}
        {!titleOnly && task.owner && <span className="due">Owner {task.owner}</span>}
        {!titleOnly && task.organization && (
          <span className="due">{task.organization === 'home-health' ? 'Home Health' : task.organization === 'hospice' ? 'Hospice' : 'Ligare'}</span>
        )}
        {!titleOnly && projectName && <span className="due">{projectName}</span>}
      </div>

      {showReminder && !overlay && (
        <button
          className="reminder"
          onClick={(e) => {
            e.stopPropagation()
            onAcknowledge(task.id)
          }}
        >
          <BellRing size={13} /> Reminder due
        </button>
      )}
      {overdue && (
        <div className="overdue-note">
          <AlertTriangle size={13} /> Overdue
        </div>
      )}
    </article>
  )
}

function TaskEditorModal({
  task,
  projects,
  onSave,
  onClose,
}: {
  task: Task
  projects: Project[]
  onSave: (task: Task) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Task>(task)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit card</h3>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Task title"
        />
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Task description"
          rows={4}
        />
        <div className="modal-row">
          <select
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value as Priority })}
          >
            <option>Low</option>
            <option>Med</option>
            <option>High</option>
          </select>
          <div className="date-input-wrap">
            <input
              id="edit-due"
              type="date"
              value={draft.dueDate || ''}
              onChange={(e) => setDraft({ ...draft, dueDate: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="modal-row">
          <input
            value={draft.owner || ''}
            onChange={(e) => setDraft({ ...draft, owner: e.target.value || undefined })}
            placeholder="Owner"
          />
          <select
            value={draft.organization || 'home-health'}
            onChange={(e) => setDraft({ ...draft, organization: e.target.value as Organization })}
          >
            <option value="home-health">Home Health</option>
            <option value="hospice">Hospice</option>
            <option value="ligare">Ligare</option>
          </select>
        </div>

        <select
          value={draft.projectId || ''}
          onChange={(e) => setDraft({ ...draft, projectId: e.target.value || undefined })}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(draft)}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

function ArchiveSettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: ArchiveSettings
  onSave: (settings: ArchiveSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ArchiveSettings>(settings)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Kanban Settings</h3>

        <h4>Archive</h4>
        <label className="setting-row">
          <span>Enable auto-archive for old Done tasks</span>
          <input
            type="checkbox"
            checked={draft.autoArchiveEnabled}
            onChange={(e) => setDraft({ ...draft, autoArchiveEnabled: e.target.checked })}
          />
        </label>

        <label>
          <span>Auto-archive threshold (days)</span>
          <input
            type="number"
            min={1}
            value={draft.autoArchiveDays}
            onChange={(e) => setDraft({ ...draft, autoArchiveDays: Number(e.target.value || 7) })}
          />
        </label>

        <label className="setting-row">
          <span>Confirm before permanent delete</span>
          <input
            type="checkbox"
            checked={draft.showDeleteConfirm}
            onChange={(e) => setDraft({ ...draft, showDeleteConfirm: e.target.checked })}
          />
        </label>

        <label>
          <span>Default manual archive reason</span>
          <input
            value={draft.defaultArchiveReason}
            onChange={(e) => setDraft({ ...draft, defaultArchiveReason: e.target.value })}
          />
        </label>

        <h4>Columns</h4>
        <div className="archived-list" style={{ marginTop: '0.5rem' }}>
          {draft.columnOrder.map((columnId, index) => {
            const config = draft.columnSettings[columnId] || columnMeta[columnId]
            const update = (patch: Partial<ColumnSetting>) =>
              setDraft({
                ...draft,
                columnSettings: {
                  ...draft.columnSettings,
                  [columnId]: { ...config, ...patch },
                },
              })

            return (
              <div key={columnId} className="archived-card">
                <div className="modal-row" style={{ gridTemplateColumns: '70px 1fr' }}>
                  <input
                    value={config.icon || ''}
                    onChange={(e) => update({ icon: e.target.value.slice(0, 2) })}
                    placeholder="Icon"
                  />
                  <input value={config.title} onChange={(e) => update({ title: e.target.value })} placeholder="Title" />
                </div>

                <div className="modal-row" style={{ gridTemplateColumns: '1fr 120px' }}>
                  <input value={config.accent} onChange={(e) => update({ accent: e.target.value })} placeholder="#8b5cf6" />
                  <input
                    type="number"
                    min={0}
                    value={config.wipLimit ?? ''}
                    onChange={(e) => update({ wipLimit: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="WIP"
                  />
                </div>

                <div className="archived-actions">
                  <button
                    className="ghost"
                    disabled={index === 0}
                    onClick={() => {
                      if (index === 0) return
                      const next = [...draft.columnOrder]
                      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                      setDraft({ ...draft, columnOrder: next })
                    }}
                  >
                    Move up
                  </button>
                  <button
                    className="ghost"
                    disabled={index === draft.columnOrder.length - 1}
                    onClick={() => {
                      if (index === draft.columnOrder.length - 1) return
                      const next = [...draft.columnOrder]
                      ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                      setDraft({ ...draft, columnOrder: next })
                    }}
                  >
                    Move down
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(draft)}>
            Save settings
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectsModal({
  projects,
  onSave,
  onClose,
}: {
  projects: Project[]
  onSave: (projects: Project[]) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Project[]>(projects)
  const [name, setName] = useState('')
  const [org, setOrg] = useState<Organization>('home-health')

  function addProject() {
    if (!name.trim()) return
    setDraft([...draft, { id: crypto.randomUUID(), name: name.trim(), organization: org }])
    setName('')
  }

  function updateProject(id: string, patch: Partial<Project>) {
    setDraft(draft.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Projects</h3>

        <div className="modal-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" />
          <select value={org} onChange={(e) => setOrg(e.target.value as Organization)}>
            <option value="home-health">Home Health</option>
            <option value="hospice">Hospice</option>
            <option value="ligare">Ligare</option>
          </select>
        </div>
        <button className="primary" onClick={addProject}>
          Add project
        </button>

        <div className="archived-list" style={{ marginTop: '0.75rem' }}>
          {draft.map((p) => (
            <div key={p.id} className="archived-card">
              <div className="modal-row">
                <input value={p.name} onChange={(e) => updateProject(p.id, { name: e.target.value })} />
                <select value={p.organization} onChange={(e) => updateProject(p.id, { organization: e.target.value as Organization })}>
                  <option value="home-health">Home Health</option>
                  <option value="hospice">Hospice</option>
                  <option value="ligare">Ligare</option>
                </select>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(draft)}>
            Save projects
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
