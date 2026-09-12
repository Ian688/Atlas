// Atlas host client (W10 seam).
//
// A host -- Modus today, something else tomorrow -- uses this to talk to a
// running Atlas service. Two properties are the whole point:
//
//   1. It has no storage access. There is no database path here, no file
//      read of the store, nothing but HTTP. A host that read Atlas' SQLite
//      file would be coupled to a layout that is explicitly not part of the
//      contract.
//   2. It cannot widen what Atlas does. Every method maps to one published
//      endpoint, and `contract()` returns what the service says those
//      endpoints guarantee and do not.
//
// Dependency-free ESM. Node 20+.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class AtlasHostError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AtlasHostError';
    this.status = status;
    this.body = body;
  }
}

export class AtlasHostClient {
  /**
   * @param {object} options
   * @param {string} options.url   e.g. http://127.0.0.1:43117/
   * @param {string} options.token the session token from the service's session file
   */
  constructor({ url, token }) {
    if (!url || !token) throw new AtlasHostError('url and token are required');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') {
      throw new AtlasHostError(`refusing non-http scheme: ${parsed.protocol}`);
    }
    // The service is a local service. A host that pointed this client at a
    // remote address would be sending a local session token off the machine.
    if (!LOOPBACK.has(parsed.hostname)) {
      throw new AtlasHostError(`refusing non-loopback host: ${parsed.hostname}`);
    }
    this.base = parsed.href.endsWith('/') ? parsed.href : parsed.href + '/';
    this.token = token;
    this.origin = parsed.origin;
  }

  async request(name, { params, body, method } = {}) {
    const search = new URLSearchParams(params || {});
    const url = `${this.base}api/${name}${search.size ? '?' + search : ''}`;
    const headers = { Authorization: `Bearer ${this.token}`, Origin: this.origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!response.ok) {
      throw new AtlasHostError(`${name} failed (${response.status})`, { status: response.status, body: parsed });
    }
    return parsed;
  }

  // -- read ---------------------------------------------------------------
  /** What this service promises, as data. A host should call this first. */
  contract(transport) { return this.request('contract', { params: transport ? { transport } : {} }); }
  report() { return this.request('report'); }
  nodes({ kind = 'all', limit = 100, cursor } = {}) {
    return this.request('nodes', { params: { kind, limit, ...(cursor ? { cursor } : {}) } });
  }
  edges({ kind = 'call_candidate', limit = 100, cursor } = {}) {
    return this.request('edges', { params: { kind, limit, ...(cursor ? { cursor } : {}) } });
  }
  reach({ entity, direction = 'out', maxNodes = 100, maxEdges = 400 } = {}) {
    return this.request('reach', { params: { entity, direction, max_nodes: maxNodes, max_edges: maxEdges } });
  }
  flow({ entity }) { return this.request('flow', { params: { entity } }); }
  flows({ limit = 100, cursor } = {}) {
    return this.request('flows', { params: { limit, ...(cursor ? { cursor } : {}) } });
  }
  source({ entity }) { return this.request('source', { params: { entity } }); }
  profile({ entity }) { return this.request('profile', { params: { entity } }); }
  execRecords({ entity, limit = 20 } = {}) {
    return this.request('exec-records', { params: { entity, limit } });
  }
  selection({ entity }) { return this.request('selection', { params: { entity } }); }
  annotations({ entity, limit = 50 } = {}) {
    return this.request('annotations', { params: { entity, limit } });
  }
  agentRequests({ state, limit = 50 } = {}) {
    return this.request('agent/requests', { params: { ...(state ? { state } : {}), limit } });
  }
  patches({ entity, limit = 50 } = {}) {
    return this.request('patches', { params: { ...(entity ? { entity } : {}), limit } });
  }
  patch({ id }) { return this.request('patch', { params: { id } }); }

  // -- act ----------------------------------------------------------------
  /** Pin a selection context. Content-addressed, so the same request is the same id. */
  context({ entity }) { return this.request('context', { body: { entity } }); }
  /** Register an Intent. Never writes source. */
  annotate({ entity, kind = 'intent', body, proposedBy = 'host' }) {
    return this.request('annotation', { body: { entity, kind, body, proposed_by: proposedBy } });
  }
  /** Enqueue a bounded bridge request; the service rejects unbounded kinds. */
  agentRequest({ owner, requestKey, kind = 'inspect', entity, payload }) {
    return this.request('agent/request', {
      body: { owner, request_key: requestKey, kind, entity, payload },
    });
  }
  /** Perform queued bounded actions. */
  agentWork({ max = 4 } = {}) { return this.request('agent/work', { body: { max } }); }
  /**
   * Register a unified diff as a proposal. This is an Intent: it changes
   * nothing. Verifying (which re-indexes) and applying (which writes a
   * checkout) are CLI operations -- a host must not do them behind a page.
   */
  proposePatch({ entity, diff, summary, proposedBy = 'host' }) {
    return this.request('patch/propose', {
      body: { entity, diff, ...(summary ? { summary } : {}), proposed_by: proposedBy },
    });
  }
  /**
   * Run one controlled call. Only a static profile that allows a run will
   * actually start a process; a refusal comes back as a record, not a throw.
   */
  exec({ symbol, args = [], timeoutMs, allowEffects = [], plan = false }) {
    return this.request('exec', {
      body: { symbol, args, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}), allow_effects: allowEffects, plan },
    });
  }

  /** The endpoints this client uses, for a contract check. */
  static requiredEndpoints() {
    return ['report', 'nodes', 'edges', 'reach', 'flow', 'flows', 'source', 'context',
      'profile', 'exec-records', 'exec', 'selection', 'annotations', 'annotation',
      'agent/requests', 'agent/request', 'agent/work', 'contract',
      'patches', 'patch', 'patch/propose'];
  }
}
