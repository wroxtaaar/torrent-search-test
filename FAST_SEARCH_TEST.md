# Fast Search / Metadata Experiment

This repository is intentionally isolated from the normal Torrent Studio application.

It tests fast torrent search plus direct magnet/search-result metadata resolution on Render Free.

Excluded on purpose:

- Oracle VPS
- qBittorrent
- Seedr
- Redis
- PostgreSQL
- Prowlarr
- background indexing
- persistent search cache
- existing Torrent Studio download/stream code

## Endpoints

- GET /health
- GET /api/search?q=your+query
- POST /api/metadata with JSON body {"magnet":"magnet:?xt=urn:btih:..."}
- POST /api/add with JSON body {"magnet":"magnet:?xt=urn:btih:..."}

The Add endpoint resolves metadata and keeps the torrent paused in the in-process WebTorrent client for this experiment.

The UI reports browser time, server time, provider time, metadata resolution time, file count, total size, and peers seen at metadata arrival.
