# Shigoto Kanban Enterprise

Enterprise-grade TypeScript Kanban board with drag/drop UX, due dates, archived workflows, reminders, and API-backed sync.

## Stack
- React + TypeScript + Vite
- Node/Express sync API
- Local JSON data store (`kanban-data.json`)

## Run
```bash
npm install
npm run dev:all
```

## Features
- Backlog / In Progress / Review / Done
- Due dates + overdue highlighting
- Archived view with restore/delete
- Sidebar navigation + settings
- Task editing modal
- Shared data API for channel-sync workflows

## Security
- Keep secrets out of repo
- Use least-privilege OAuth scopes
- Route external webhooks through hardened reverse proxy
