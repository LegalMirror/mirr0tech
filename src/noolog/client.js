// Noolog deliberation API (https://api.peeramid.xyz/swagger-ui/): start a job, poll its status, read
// its history and reference tree. Pure fetch; `fetchImpl` is injectable for tests and the mock.
export class NoologError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class NoologClient {
  constructor({ url = process.env.NOOLOG_URL ?? 'https://api.peeramid.xyz', apiKey = process.env.NOOLOG_API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new NoologError(401, 'Set NOOLOG_API_KEY (or run the mock)');
    Object.assign(this, { url: url.replace(/\/$/, ''), apiKey, fetchImpl });
  }
  async call(method, path, body) {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new NoologError(response.status, `${method} ${path}: ${response.status} ${await response.text().catch(() => '')}`.trim());
    return response.json();
  }
  /// POST /deliberation → { job_id }
  startDeliberation(body) { return this.call('POST', '/deliberation', body); }
  /// POST /v1/chat/completions (OpenAI-compatible, deliberating model). The job behind the answer is
  /// named by the x-nsed-session-id header, so its history and reference tree can be read afterwards.
  async chatCompletion(body) {
    const response = await this.fetchImpl(`${this.url}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new NoologError(response.status, `POST /v1/chat/completions: ${response.status} ${await response.text().catch(() => '')}`.trim());
    const completion = await response.json();
    const jobId = response.headers?.get?.('x-nsed-session-id') ?? completion.nsed_metadata?.session_id ?? null;
    if (!jobId) throw new NoologError(502, 'The completion named no deliberation job (x-nsed-session-id)');
    return { completion, jobId };
  }
  /// GET /v1/models → the deliberating models this token may name (OpenAI shape).
  async models() { return (await this.call('GET', '/v1/models')).data?.map((model) => model.id) ?? []; }
  /// GET /deliberation/{id}/result → { job_id, status, result }
  status(jobId) { return this.call('GET', `/deliberation/${encodeURIComponent(jobId)}/result`); }
  details(jobId) { return this.call('GET', `/deliberation/${encodeURIComponent(jobId)}/details`); }
  references(jobId) { return this.call('GET', `/deliberation/${encodeURIComponent(jobId)}/references`); }
  /// Polls until the job leaves pending/running.
  /// GET /policies → the registered seat lists; `policyFor(tag)` names one by tag or name.
  policies() { return this.call('GET', '/policies'); }
  async policyFor(tag) {
    const policy = (await this.policies()).find((entry) => entry.name === tag || (entry.tags ?? []).includes(tag));
    if (!policy) throw new NoologError(404, `No policy tagged ${tag}`);
    return policy;
  }
  /// Polls until the job leaves pending/running. The live status is a progress line
  /// ("running: round 2 — Starting"); `onProgress` sees every poll, so time-based progress can advance.
  async waitForResult(jobId, { pollMs = 500, timeoutMs = 120_000, onProgress = null } = {}) {
    const started = Date.now();
    for (;;) {
      const state = await this.status(jobId);
      await onProgress?.(state);
      if (!/^(pending|claimed|running|queued)/i.test(String(state.status))) return state;
      if (Date.now() - started > timeoutMs) throw new NoologError(504, `Job ${jobId} still ${state.status} after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
