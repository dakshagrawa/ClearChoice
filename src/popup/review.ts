import { CLEARCHOICE_REVIEW_LIST, CLEARCHOICE_REVIEW_MARK, CLEARCHOICE_REVIEW_DELETE, CLEARCHOICE_REVIEW_RETENTION, isReviewListResponse, isRestoreResponse } from '../shared/messages';
import type { ReviewItem, ReviewListResponse } from '../shared/messages';

export function mountReview(root: HTMLElement, reviewAsSubscription?: (item: ReviewItem, control: HTMLButtonElement) => void, invalidateSuggestion?: () => void): { refresh: () => Promise<void> } {
  // Fixed extension-owned template; record content is assigned with textContent below.
  root.innerHTML = `<section aria-labelledby="review-heading">
    <h2 id="review-heading">Needs review</h2>
    <p>Local observations are not confirmed subscriptions. Marking reviewed does not create a subscription. Turning detection off does not delete history.</p>
    <p data-review-count>Review count unavailable.</p>
    <button type="button" data-action="review-refresh">Refresh history</button>
    <p data-review-status role="status" aria-live="polite">Loading local history…</p>
    <label for="review-retention">Keep local observations</label>
    <select id="review-retention" data-review-retention disabled>
      <option value="7">7 days</option><option value="30">30 days</option>
      <option value="90">90 days</option><option value="never">Never expire</option>
    </select>
    <p>Expiry is based on latest seen. Shorter retention can permanently remove older observations.</p>
    <ol data-review-items></ol>
    <nav aria-label="Review history pages">
      <button type="button" data-action="review-previous" disabled>Previous page</button>
      <button type="button" data-action="review-next" disabled>Next page</button>
    </nav>
  </section>`;
  const count = root.querySelector<HTMLElement>('[data-review-count]')!;
  const status = root.querySelector<HTMLElement>('[data-review-status]')!;
  const list = root.querySelector<HTMLOListElement>('[data-review-items]')!;
  const previous = root.querySelector<HTMLButtonElement>('[data-action="review-previous"]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-action="review-next"]')!;
  const retention = root.querySelector<HTMLSelectElement>('[data-review-retention]')!;
  const refreshButton = root.querySelector<HTMLButtonElement>('[data-action="review-refresh"]')!;
  let mutating = false;
  let refreshPending = false;
  let revision = 0;
  function controls(): void {
    refreshButton.disabled = mutating;
    retention.disabled = mutating || !snapshot;
    previous.disabled = mutating || !snapshot || snapshot.offset === 0;
    next.disabled = mutating || !snapshot || snapshot.offset + snapshot.findings.length >= snapshot.total;
    for (const control of root.querySelectorAll<HTMLButtonElement>('[data-review-mutation]')) {
      control.disabled = mutating || control.dataset.reviewed === 'true';
    }
  }
  async function mutate(message: Record<string, unknown>): Promise<void> {
    if (mutating || !snapshot) return;
    const returnFocus = list.contains(document.activeElement);
    mutating = true;
    revision++;
    controls();
    status.textContent = 'Saving local history change…';
    try {
      const response: unknown = await chrome.runtime.sendMessage(message);
      if (!isRestoreResponse(response) || !response.ok) throw new Error('Mutation failed');
      await load(0);
    } catch {
      if (snapshot) retention.value = String(snapshot.retentionPolicy);
      status.textContent = 'Could not save local history change. Displayed records and retention are unchanged; refresh to check.';
    } finally {
      mutating = false;
      controls();
      if (refreshPending) { refreshPending = false; await load(0); }
      if (returnFocus && document.activeElement === document.body) refreshButton.focus();
    }
  }
  let snapshot: ReviewListResponse | undefined;
  function render(item: ReviewItem): HTMLElement {
    const row = document.createElement('li');
    row.dataset.reviewId = item.id;
    for (const text of [item.origin, item.status === 'needs-review' ? 'Needs review' : 'Reviewed', `ID: ${item.id}`, `${item.kind} — ${item.reason}`, item.screenedExcerpt, `First seen: ${item.firstSeen}`, `Latest seen: ${item.latestSeen}`]) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      row.append(paragraph);
    }
    const mark = document.createElement('button');
    mark.type = 'button'; mark.dataset.action = 'review-mark'; mark.dataset.reviewMutation = '';
    mark.dataset.reviewed = String(item.status === 'reviewed');
    mark.textContent = 'Mark reviewed';
    mark.setAttribute('aria-label', `Mark observation ${item.id} from ${item.origin} reviewed`);
    mark.addEventListener('click', () => { void mutate({ type: CLEARCHOICE_REVIEW_MARK, version: 1, id: item.id }); });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.dataset.action = 'review-delete'; remove.dataset.reviewMutation = '';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete observation ${item.id} from ${item.origin}`);
    remove.addEventListener('click', () => {
      if (!mutating && window.confirm(`Permanently delete observation ${item.id} from ${item.origin}?`)) {
        void mutate({ type: CLEARCHOICE_REVIEW_DELETE, version: 1, id: item.id });
      }
    });
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.dataset.action = 'review-as-subscription'; confirm.dataset.reviewMutation = '';
    confirm.textContent = 'Review as subscription';
    confirm.setAttribute('aria-label', `Review observation ${item.id} from ${item.origin} as subscription`);
    confirm.addEventListener('click', () => { if (!mutating && row.isConnected) reviewAsSubscription?.(item, confirm); });
    row.append(mark, remove, confirm);
    return row;
  }
  async function load(offset: number): Promise<void> {
    invalidateSuggestion?.();
    const current = ++revision;
    snapshot = undefined;
    retention.selectedIndex = -1;
    controls();
    count.textContent = 'Review count unavailable while refreshing.';
    status.textContent = 'Loading local history…';
    list.replaceChildren();
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_REVIEW_LIST, version: 1, offset, limit: 100 });
      if (current !== revision) return;
      if (!isReviewListResponse(response) || response.offset !== offset
        || response.findings.length !== Math.min(100, Math.max(0, response.total - offset))) throw new Error('Invalid history response');
      // Retention may remove a page between requests. Return to a valid first page.
      if (response.total > 0 && offset >= response.total) { await load(0); return; }
      snapshot = response;
      count.textContent = `${response.needsReviewCount} observation${response.needsReviewCount === 1 ? '' : 's'} ${response.needsReviewCount === 1 ? 'needs' : 'need'} review.`;
      list.start = offset + 1;
      list.replaceChildren(...response.findings.map(render));
      retention.value = String(response.retentionPolicy);
      controls();
      status.textContent = response.total === 0 ? 'No retained observations.' : `Showing ${offset + 1}–${offset + response.findings.length} of ${response.total} retained observations (including reviewed).`;
    } catch {
      if (current !== revision) return;
      count.textContent = 'Review count unavailable.';
      status.textContent = 'Could not load local history. Try refreshing.';
      controls();
    }
  }
  const refresh = async () => {
    if (mutating) { refreshPending = true; return; }
    await load(0);
  };
  retention.addEventListener('change', () => {
    if (mutating || !snapshot) return;
    const policy = retention.value === 'never' ? 'never' : Number(retention.value);
    retention.value = String(snapshot.retentionPolicy);
    if (policy === 7 || policy === 30 || policy === 90 || policy === 'never') {
      void mutate({ type: CLEARCHOICE_REVIEW_RETENTION, version: 1, policy });
    }
  });
  root.querySelector('[data-action="review-refresh"]')!.addEventListener('click', () => { void refresh(); });
  previous.addEventListener('click', () => { if (snapshot) void load(Math.max(0, snapshot.offset - 100)); });
  next.addEventListener('click', () => { if (snapshot) void load(snapshot.offset + 100); });
  void refresh();
  return { refresh };
}
