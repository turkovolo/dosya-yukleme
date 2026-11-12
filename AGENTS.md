# Project notes

freecode reads this file before every change. Add anything it should always remember about this project.

## Dosya Paylaş (file sharing app)
- Stack: Node.js + Express 4 + multer (disk storage), vanilla HTML/CSS/JS frontend, no build step.
- All UI text is Turkish. Dark theme: bg #0f172a, surface #1e293b, accent emerald #10b981.
- Hard limit 100 MB (104,857,600 bytes) enforced by multer (`limits.fileSize`) and in the browser.
- Files: `uploads/` (stored as `<id><ext>`), metadata index in `data/files.json` (atomic write via tmp file + rename).
- Short IDs: 5 chars from an unambiguous alphabet, collision-checked. Canonical link `/f/:id`; `/d/:id` forces download, `/p/:id` serves inline for preview.
- API: `POST /api/upload` (field name `file`), `GET /api/files/:id` (JSON metadata).
- Run: `npm install && npm start` (serves on $PORT or 3000).
- Preview command in this workspace: `npm start` with PORT=3000.
