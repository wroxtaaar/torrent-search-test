import express from 'express';
import WebTorrent from 'webtorrent';

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '256kb' }));

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 2500);
const METADATA_TIMEOUT_MS = Number(process.env.METADATA_TIMEOUT_MS || 15000);
const METADATA_ATTEMPT_TIMEOUT_MS = Number(process.env.METADATA_ATTEMPT_TIMEOUT_MS || 8000);
const METADATA_MAX_RETRIES = Number(process.env.METADATA_MAX_RETRIES || 3);
const METADATA_RETRY_DELAY_MS = Number(process.env.METADATA_RETRY_DELAY_MS || 150);
const METADATA_MAX_CONNS = Number(process.env.METADATA_MAX_CONNS || 50);
const APIBAY_ENABLED = process.env.ENABLE_APIBAY !== 'false';
const TORRENTS_CSV_URL = 'https://torrents-csv.com/service/search';
const APIBAY_URL = 'https://apibay.org/q.php';

const TRACKERS = [
  'http://tracker.dler.org:6969/announce',
  'http://tracker2.dler.org:80/announce',
  'http://1337.abcvg.info:80/announce'
];

const FALLBACK_TRACKERS = [
  'http://tracker.qu.ax:6969/announce',
  'http://tracker.renfei.net:8080/announce',
  'http://t.overflow.biz:6969/announce',
  'http://ipv4announce.sktorrent.eu:6969/announce',
  'http://tracker.dhitechnical.com:6969/announce',
  'http://tr.nyacat.pw:80/announce'
];

const active = new Map();
const metadataClients = new Set();
const metadataPromises = new Map();
let metadataInFlight = false;
let metadataDiagnostics = {
  phase: 'idle',
  infoHash: null,
  peers: 0,
  wires: 0,
  warnings: 0,
  startedAt: null,
  elapsedMs: 0
};

function createMetadataClient(maxConns) {
  const metadataClient = new WebTorrent({
    dht: false,
    tracker: true,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    maxConns
  });

  metadataClients.add(metadataClient);
  metadataClient.on('error', err => {
    console.error('[WEBTORRENT] metadata client error:', err?.message || err);
  });

  return metadataClient;
}

function destroyMetadataClient(metadataClient) {
  if (!metadataClient) return Promise.resolve();

  metadataClients.delete(metadataClient);

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1500);

    try {
      metadataClient.destroy(finish);
    } catch {
      finish();
    }
  });
}

function elapsed(start) {
  return Math.round(performance.now() - start);
}

function makeMagnet(infoHash, name) {
  const params = new URLSearchParams();
  params.set('xt', 'urn:btih:' + infoHash);
  if (name) params.set('dn', name);
  for (const tracker of TRACKERS) params.append('tr', tracker);
  // parse-torrent expects the BTIH xt value in its canonical unescaped form.
  // URLSearchParams escapes the colons, so restore only the xt prefix.
  return 'magnet:?' + params.toString().replace('xt=urn%3Abtih%3A', 'xt=urn:btih:');
}

function normalizeMagnet(input) {
  const raw = String(input || '').trim();
  if (!/^magnet:\?/i.test(raw)) {
    throw new Error('A valid magnet URI is required');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid magnet URI');
  }

  const xt = url.searchParams.get('xt') || '';
  const match = xt.match(/^urn:btih:([a-f0-9]{40})$/i);
  if (!match) {
    throw new Error('Magnet must contain a valid 40-character BTIH infohash');
  }

  const name = url.searchParams.get('dn') || '';
  const params = new URLSearchParams();
  params.set('xt', 'urn:btih:' + match[1].toLowerCase());
  if (name) params.set('dn', name);

  // Keep a small known-good tracker set in the magnet so parse-torrent
  // recognizes it as a complete magnet. Tracker networking is disabled
  // separately in client.add() for the DHT-only experiment.
  for (const tracker of TRACKERS) params.append('tr', tracker);
  // Keep BTIH in the canonical unescaped form required by parse-torrent.
  const normalized = 'magnet:?' + params.toString().replace('xt=urn%3Abtih%3A', 'xt=urn:btih:');

  console.log('[MAGNET] normalized', {
    infoHash: match[1].toLowerCase(),
    name: name.slice(0, 120),
    droppedTrackers: url.searchParams.getAll('tr').length
  });

  return normalized;
}

async function fetchJson(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'TorrentStudio-FastSearchTest/1.0'
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchTorrentsCsv(query, limit) {
  const started = performance.now();
  const url = new URL(TORRENTS_CSV_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('size', String(Math.min(limit, 50)));
  url.searchParams.set('type', 'torrent');

  try {
    const data = await fetchJson(url);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.torrents) ? data.torrents : [];
    return {
      source: 'torrents-csv',
      elapsedMs: elapsed(started),
      results: rows.filter(x => /^[a-f0-9]{40}$/i.test(String(x.infohash || ''))).map(x => {
        const infoHash = String(x.infohash).toLowerCase();
        const name = String(x.name || 'Untitled');
        return {
          source: 'torrents-csv',
          title: name,
          infoHash,
          magnet: makeMagnet(infoHash, name),
          size: Number(x.size_bytes || 0),
          seeders: Number(x.seeders || 0),
          leechers: Number(x.leechers || 0),
          createdAt: Number(x.created_unix || 0) || null
        };
      })
    };
  } catch (error) {
    return { source: 'torrents-csv', elapsedMs: elapsed(started), results: [], error: error?.message || String(error) };
  }
}

async function searchApiBay(query, limit) {
  const started = performance.now();
  const url = new URL(APIBAY_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('cat', '0');

  try {
    const data = await fetchJson(url);
    const rows = Array.isArray(data) ? data : [];
    return {
      source: 'apibay',
      elapsedMs: elapsed(started),
      results: rows.filter(x => /^[a-f0-9]{40}$/i.test(String(x.info_hash || ''))).slice(0, limit).map(x => {
        const infoHash = String(x.info_hash).toLowerCase();
        const name = String(x.name || 'Untitled');
        return {
          source: 'apibay',
          title: name,
          infoHash,
          magnet: makeMagnet(infoHash, name),
          size: Number(x.size || 0),
          seeders: Number(x.seeders || 0),
          leechers: Number(x.leechers || 0),
          createdAt: Number(x.added || 0) || null
        };
      })
    };
  } catch (error) {
    return { source: 'apibay', elapsedMs: elapsed(started), results: [], error: error?.message || String(error) };
  }
}

async function performSearch(query, limit = 30) {
  const started = performance.now();
  const csvPromise = searchTorrentsCsv(query, limit);
  const apiPromise = APIBAY_ENABLED ? searchApiBay(query, limit) : null;

  const first = await Promise.race(apiPromise ? [csvPromise, apiPromise] : [csvPromise]);
  const providers = [first];

  if (!first.results.length && apiPromise) {
    const second = first.source === 'torrents-csv' ? await apiPromise : await csvPromise;
    providers.push(second);
  } else if (first.results.length && apiPromise) {
    const second = await Promise.race([
      Promise.all([csvPromise, apiPromise]).then(values => values.find(value => value.source !== first.source)),
      new Promise(resolve => setTimeout(() => resolve(null), 450))
    ]);
    if (second && second.results?.length) providers.push(second);
  }

  const deduped = new Map();
  for (const provider of providers) {
    for (const item of provider.results) {
      if (!deduped.has(item.infoHash)) deduped.set(item.infoHash, item);
    }
  }

  return {
    query,
    elapsedMs: elapsed(started),
    results: [...deduped.values()].sort((a, b) => (b.seeders - a.seeders) || (b.size - a.size)).slice(0, limit),
    providers: providers.map(x => ({
      source: x.source,
      elapsedMs: x.elapsedMs,
      resultCount: x.results.length,
      error: x.error || null
    }))
  };
}

function metadataFromTorrent(torrent, elapsedMs, sourceMagnet) {
  return {
    name: torrent.name,
    infoHash: torrent.infoHash,
    magnet: torrent.magnetURI || sourceMagnet,
    totalSize: Number(torrent.length || 0),
    pieceLength: Number(torrent.pieceLength || 0),
    fileCount: torrent.files.length,
    elapsedMs,
    peersAtMetadata: Number(torrent.numPeers || 0),
    files: torrent.files.map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      size: Number(file.length || file.size || 0)
    }))
  };
}

function buildMagnetWithTrackers(normalizedMagnet, trackers) {
  const url = new URL(normalizedMagnet);
  const params = new URLSearchParams();
  params.set('xt', url.searchParams.get('xt') || '');
  const name = url.searchParams.get('dn') || '';
  if (name) params.set('dn', name);
  for (const tracker of trackers) params.append('tr', tracker);
  return 'magnet:?' + params.toString().replace('xt=urn%3Abtih%3A', 'xt=urn:btih:');
}

function metadataPlans() {
  return [
    { delayMs: 0, trackers: [...TRACKERS], maxConns: METADATA_MAX_CONNS },
    { delayMs: 3000, trackers: [...FALLBACK_TRACKERS], maxConns: 25 },
    { delayMs: 7000, trackers: [...new Set([...TRACKERS, ...FALLBACK_TRACKERS])], maxConns: 25 }
  ];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function destroyTorrent(torrent) {
  if (!torrent) return Promise.resolve();

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1500);

    try {
      torrent.destroy({ destroyStore: true }, finish);
    } catch {
      finish();
    }
  });
}

function startMetadataAttempt(normalizedMagnet, plan, attempt, keepActive, overallStarted, infoHash, onMetadata) {
  const attemptStarted = performance.now();
  const attemptMagnet = buildMagnetWithTrackers(normalizedMagnet, plan.trackers);

  let metadataClient = null;
  let torrent = null;
  let settled = false;
  let timeout;

  const cleanup = async () => {
    clearTimeout(timeout);
    await destroyTorrent(torrent);
    await destroyMetadataClient(metadataClient);
  };

  const promise = new Promise((resolve, reject) => {
    const fail = async error => {
      if (settled) return;
      settled = true;

      const elapsedMs = elapsed(attemptStarted);
      console.warn('[METADATA] attempt failed', {
        attempt,
        trackers: plan.trackers.length,
        infoHash,
        peers: Number(torrent?.numPeers || 0),
        wires: Number(torrent?._peers?.length || 0),
        elapsedMs,
        error: error?.message || String(error)
      });

      await cleanup();
      reject(error);
    };

    timeout = setTimeout(() => {
      void fail(new Error('Metadata attempt timed out after ' + Math.round((METADATA_ATTEMPT_TIMEOUT_MS / 1000)) + 's'));
    }, METADATA_ATTEMPT_TIMEOUT_MS);
    timeout.unref?.();

    try {
      // Each parallel attempt must use its own WebTorrent client.
      // WebTorrent rejects duplicate infohashes when added to the same client,
      // even when the torrents use different storage paths.
      metadataClient = createMetadataClient(plan.maxConns);
      torrent = metadataClient.add(attemptMagnet, {
        paused: false,
        deselect: true,
        dht: false,
        tracker: true,
        maxConns: plan.maxConns,
        path: '/tmp/torrent-studio-metadata/' + infoHash + '-' + attempt
      });

      console.log('[METADATA] attempt started', {
        attempt,
        delayMs: plan.delayMs,
        trackers: plan.trackers.length,
        maxConns: plan.maxConns,
        infoHash
      });

      torrent.on('infoHash', () => {
        console.log('[METADATA] infoHash discovered:', torrent.infoHash, 'attempt:', attempt);
      });

      torrent.on('wire', () => {
        console.log('[METADATA] peer connected; peers:', torrent.numPeers, 'attempt:', attempt);
      });

      let discoveredPeers = 0;
      torrent.on('peer', peer => {
        discoveredPeers += 1;
        if (discoveredPeers <= 3 || discoveredPeers % 10 === 0) {
          console.log('[TRACKER] peer discovered:', discoveredPeers, peer?.id || peer, 'attempt:', attempt);
        }
      });

      torrent.on('noPeers', announceType => {
        console.log('[METADATA] no peers after announce:', announceType, 'attempt:', attempt);
      });

      torrent.on('warning', error => {
        console.warn('[TORRENT WARNING] attempt', attempt, error?.message || error);
      });

      torrent.on('error', error => {
        void fail(error);
      });

      torrent.on('metadata', async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const attemptElapsedMs = elapsed(attemptStarted);
        const totalElapsedMs = elapsed(overallStarted);
        const metadata = {
          ...metadataFromTorrent(torrent, totalElapsedMs, attemptMagnet),
          attempts: attempt,
          trackerCount: plan.trackers.length,
          attemptElapsedMs
        };

        console.log('[METADATA] metadata received', {
          attempt,
          attemptElapsedMs,
          totalElapsedMs,
          peers: Number(torrent.numPeers || 0)
        });

        try { torrent.pause(); } catch {}
        onMetadata({ torrent, metadata, attempt, attemptElapsedMs });
        resolve({ torrent, metadata, attempt, client: metadataClient });
      });
    } catch (error) {
      void fail(error);
    }
  });

  return {
    promise,
    getTorrent: () => torrent,
    cleanup
  };
}

async function resolveMetadataFresh(normalizedMagnet, infoHash, keepActive) {
  const started = performance.now();
  const plans = metadataPlans();

  metadataDiagnostics = {
    phase: 'starting',
    infoHash,
    peers: 0,
    wires: 0,
    discoveredPeers: 0,
    warnings: 0,
    attempt: 0,
    maxAttempts: plans.length,
    trackers: plans[0].trackers.length,
    startedAt: new Date().toISOString(),
    elapsedMs: 0
  };

  return new Promise((resolve, reject) => {
    let finished = false;
    let completed = 0;
    const attempts = [];
    const startTimers = [];
    const overallTimer = setTimeout(() => {
      finishFailure(new Error('Metadata resolution timed out after ' + METADATA_TIMEOUT_MS + 'ms'));
    }, METADATA_TIMEOUT_MS);
    overallTimer.unref?.();

    const finishCleanup = async winnerTorrent => {
      clearTimeout(overallTimer);
      for (const timer of startTimers) clearTimeout(timer);

      await Promise.all(attempts.map(async attempt => {
        const torrent = attempt.getTorrent();
        if (torrent && torrent !== winnerTorrent) {
          await attempt.cleanup();
        }
      }));
    };

    const finishSuccess = async ({ torrent, metadata, attempt }) => {
      if (finished) return;
      finished = true;

      metadataDiagnostics.phase = 'metadata-received';
      metadataDiagnostics.infoHash = infoHash;
      metadataDiagnostics.peers = Number(torrent.numPeers || 0);
      metadataDiagnostics.elapsedMs = elapsed(started);
      metadataDiagnostics.attempt = attempt;

      if (keepActive) {
        active.set(infoHash, { torrent, client: metadataClient, createdAt: Date.now(), metadata });

        const cleanupTimer = setTimeout(() => {
          const entry = active.get(infoHash);
          if (entry?.torrent === torrent) {
            active.delete(infoHash);
            void destroyTorrent(torrent).then(() => destroyMetadataClient(entry.client));
          }
        }, 10 * 60 * 1000);
        cleanupTimer.unref?.();
      }

      await finishCleanup(keepActive ? torrent : null);
      resolve(metadata);
    };

    const finishFailure = async error => {
      if (finished) return;
      finished = true;

      metadataDiagnostics.phase = 'failed';
      metadataDiagnostics.infoHash = infoHash;
      metadataDiagnostics.elapsedMs = elapsed(started);

      await finishCleanup(null);
      reject(error);
    };

    const handleAttemptFailure = error => {
      completed += 1;
      console.warn('[METADATA] attempt finished without metadata', {
        completed,
        total: plans.length,
        error: error?.message || String(error)
      });
      if (!finished && completed >= plans.length) {
        void finishFailure(new Error(
          'Metadata resolution failed after ' + plans.length +
          ' parallel attempts (' + elapsed(started) + 'ms): ' +
          (error?.message || 'no metadata received')
        ));
      }
    };

    plans.forEach((plan, index) => {
      const attempt = index + 1;
      const launch = () => {
        if (finished) return;

        const entry = startMetadataAttempt(
          normalizedMagnet,
          plan,
          attempt,
          keepActive,
          started,
          infoHash,
          () => {}
        );
        attempts.push(entry);

        metadataDiagnostics.phase = attempt === 1 ? 'discovering' : 'fallback-discovering';
        metadataDiagnostics.attempt = attempt;
        metadataDiagnostics.trackers = plan.trackers.length;

        entry.promise
          .then(result => finishSuccess(result))
          .catch(handleAttemptFailure);
      };

      if (plan.delayMs === 0) {
        launch();
      } else {
        const timer = setTimeout(launch, plan.delayMs);
        timer.unref?.();
        startTimers.push(timer);
      }
    });
  });
}

async function resolveMetadata(magnet, keepActive = true) {
  const normalizedMagnet = normalizeMagnet(magnet);
  const url = new URL(normalizedMagnet);
  const infoHash = (url.searchParams.get('xt') || '')
    .replace(/^urn:btih:/i, '')
    .toLowerCase();

  const cached = active.get(infoHash);
  if (cached?.metadata) {
    console.log('[METADATA] cache hit:', infoHash);
    return cached.metadata;
  }

  const existing = metadataPromises.get(infoHash);
  if (existing) {
    console.log('[METADATA] joining duplicate request:', infoHash);
    return existing;
  }

  const promise = resolveMetadataFresh(normalizedMagnet, infoHash, keepActive)
    .finally(() => {
      metadataPromises.delete(infoHash);
      metadataInFlight = metadataPromises.size > 0;
    });

  metadataPromises.set(infoHash, promise);
  metadataInFlight = true;
  return promise;
}

app.get('/', (_req, res) => res.sendFile(process.cwd() + '/fast-search-test.html'));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'torrent-studio-fast-search-test',
    webtorrent: '3.0.21',
    activeTorrents: active.size,
    metadataInFlight: metadataPromises.size > 0,
    metadataDiagnostics,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);
  if (query.length < 2) return res.status(400).json({ error: 'Search query must be at least 2 characters.' });

  try {
    res.json(await performSearch(query, limit));
  } catch (error) {
    console.error('[SEARCH]', error);
    res.status(502).json({ error: error?.message || 'Search failed' });
  }
});

app.post('/api/metadata', async (req, res) => {
  const magnet = String(req.body?.magnet || '').trim();
  if (!magnet) return res.status(400).json({ error: 'magnet is required' });
  try {
    res.json({ ok: true, ...(await resolveMetadata(magnet, true)) });
  } catch (error) {
    console.error('[METADATA]', error);
    res.status(504).json({ ok: false, error: error?.message || 'Metadata resolution failed' });
  }
});

app.post('/api/add', async (req, res) => {
  const magnet = String(req.body?.magnet || '').trim();
  if (!magnet) return res.status(400).json({ error: 'magnet is required' });
  try {
    res.json({ ok: true, action: 'added-paused', ...(await resolveMetadata(magnet, true)) });
  } catch (error) {
    console.error('[ADD]', error);
    res.status(504).json({ ok: false, error: error?.message || 'Add failed' });
  }
});

app.get('/api/tracker-test', async (_req, res) => {
  const results = await Promise.all(TRACKERS.map(async tracker => {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const url = new URL(tracker);
      // Deliberately use an invalid/minimal announce request. Any HTTP response
      // proves Render can reach the tracker; WebTorrent still handles real announces.
      url.searchParams.set('info_hash', '00000000000000000000');
      url.searchParams.set('peer_id', '-TS0001-' + '0'.repeat(12));
      url.searchParams.set('port', '10000');
      url.searchParams.set('uploaded', '0');
      url.searchParams.set('downloaded', '0');
      url.searchParams.set('left', '1');
      url.searchParams.set('compact', '1');
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'TorrentStudio-TrackerTest/1.0' }
      });
      const body = await response.text();
      return {
        tracker,
        reachable: true,
        status: response.status,
        elapsedMs: elapsed(started),
        body: body.slice(0, 300)
      };
    } catch (error) {
      return {
        tracker,
        reachable: false,
        elapsedMs: elapsed(started),
        error: error?.message || String(error)
      };
    } finally {
      clearTimeout(timer);
    }
  }));

  res.json({
    ok: true,
    testedAt: new Date().toISOString(),
    results
  });
});

app.get('/api/metadata-status', (_req, res) => {
  res.json({
    ok: true,
    metadataInFlight: metadataPromises.size > 0,
    ...metadataDiagnostics,
    activeTorrents: active.size
  });
});

app.get('/api/active', (_req, res) => {
  res.json([...active.values()].map(entry => entry.metadata));
});

const server = app.listen(PORT, HOST, () => {
  console.log('[FAST TEST] listening on http://' + HOST + ':' + PORT);
  console.log('[FAST TEST] search sources: torrents-csv' + (APIBAY_ENABLED ? ', apibay' : ''));
  console.log('[FAST TEST] WebTorrent HTTP-tracker metadata resolver ready; max connections:', METADATA_MAX_CONNS);
});

async function shutdown() {
  console.log('[FAST TEST] shutting down');
  server.close(async () => {
    await Promise.all([...metadataClients].map(destroyMetadataClient));
    for (const entry of active.values()) {
      await destroyTorrent(entry.torrent);
      await destroyMetadataClient(entry.client);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
