# server.js Integration

Add to the top of `server.js`, alongside existing requires:

```js
const { initSession, GRAPHS } = require('./registry/session-init.js');
```

Add after the server starts listening (at the bottom of `server.js`,
after `app.listen(...)`):

```js
// Registry bootstrap — runs async, does not block server startup
initSession().then(({ health }) => {
  const reachable = [...health.values()].filter(v => v.reachable).length;
  console.log(`[registry] ${reachable}/${health.size} bridge(s) reachable`);
}).catch(err => {
  console.warn('[registry] Session init error (non-fatal):', err.message);
});
```

Add two new REST endpoints to `server.js` to expose registry state:

```js
// GET /registry — list all known bridges with reachability status
// (cached from last session init; reachability is re-probed on request)
app.get('/registry', requireAuth, async (req, res) => {
  const { probeReachability, buildConfig, GRAPHS } = require('./registry/session-init.js');
  const { queryBridgeEndpoints } = require('./registry/sparql-helper.js');

  const config   = buildConfig();
  const health   = await probeReachability(config);
  const bridges  = await queryBridgeEndpoints(
    config.fuseki.base, config.fuseki.dataset,
    { registryGraph: GRAPHS.bridges, endpointGraph: GRAPHS.endpoints }
  );

  res.json({
    bridges: bridges.map(b => ({
      iri:    b.bridge?.value,
      label:  b.label?.value,
      url:    b.url?.value,
      health: health.get(b.bridge?.value) || { reachable: false },
    })),
  });
});

// POST /registry/refresh — force a full registry cache refresh
app.post('/registry/refresh', requireAuth, async (req, res) => {
  const { loadRegistryCache, resolveEndpoints, buildConfig } = require('./registry/session-init.js');
  const config = buildConfig();

  // Force refresh by temporarily setting cacheMaxAgeMs to 0
  const result = await loadRegistryCache({ ...config, cacheMaxAgeMs: 0 });
  await resolveEndpoints(config);

  res.json({ refreshed: true, graphsUpdated: result.graphsUpdated });
});
```

# .env Additions

Add to `.env` in the HolonBridge root:

```bash
# Registry configuration
REGISTRY_GITHUB_OWNER=colossalhop
REGISTRY_GITHUB_REPO=un-ggce-supply-chain
REGISTRY_GITHUB_TOKEN=<github-pat-with-repo-read-scope>
REGISTRY_CACHE_MAX_AGE=86400000
```

Note: `REGISTRY_GITHUB_TOKEN` can share the value of `GITHUB_PAT` if the
same PAT has read access to `colossalhop/un-ggce-supply-chain`.
