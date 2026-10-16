import type { ReviewItem } from '../shared/messages';
import { CLEARCHOICE_SUBSCRIPTION_HELP, isSubscriptionHelpResponse, CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING, CLEARCHOICE_SUBSCRIPTION_LIST, CLEARCHOICE_SUBSCRIPTION_CREATE, CLEARCHOICE_SUBSCRIPTION_UPDATE, CLEARCHOICE_SUBSCRIPTION_DELETE, isSubscriptionListResponse, isSubscriptionMutationResponse } from '../shared/messages';
import { isSubscriptionFields, normalizeMerchant, normalizeCurrency } from '../shared/models';
import type { Subscription } from '../shared/models';

export function mountSubscriptions(root: HTMLElement) {
  // All innerHTML templates are fixed extension-owned markup. User values use value/textContent only.
  root.innerHTML = '<section aria-label="Subscriptions"><h2>Subscriptions</h2><p>Saved on this device. Deleting a record does not cancel billing.</p><details><summary>Privacy and cancellation help</summary><p>Help uses retained observations only; it cannot read payment data or cancel for you.</p></details><button type="button" data-subscription-action="add">Add subscription</button><button type="button" data-subscription-action="refresh">Refresh subscriptions</button><p role="status" aria-live="polite">Loading subscriptions…</p><div data-subscription-list></div><div data-subscription-editor></div></section>';
  const status = root.querySelector<HTMLElement>('[role="status"]')!;
  const list = root.querySelector<HTMLElement>('[data-subscription-list]')!;
  const editor = root.querySelector<HTMLElement>('[data-subscription-editor]')!;
  const add = root.querySelector<HTMLButtonElement>('[data-subscription-action="add"]')!;
  let entries: Subscription[] = [];
  let revision = 0;
  let busy = false;
  const helpControls = new Set<HTMLButtonElement>();
  let initialDraft = '';
  const draft = () => JSON.stringify(Array.from(editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'), (field) => [field.name, field.value]));
  function mayReplace(): boolean {
    return !editor.querySelector('form') || draft() === initialDraft || window.confirm('Discard unsaved subscription changes?');
  }
  let suggestionOpen = false;
  let suggestionInvalidationPending = false;
  const invalidationMessage = 'Observation changed or refreshed. Review it again before saving a subscription.';
  function invalidateSuggestion() {
    if (!suggestionOpen) return;
    // An in-flight worker commit cannot be cancelled. Discard its stale editor on settlement.
    if (busy) { suggestionInvalidationPending = true; return; }
    suggestionOpen = false; editor.replaceChildren();
    status.textContent = invalidationMessage;
    add.focus();
  }
  function controls() {
    editor.setAttribute('aria-busy', String(busy));
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) control.disabled = busy || helpControls.has(control as HTMLButtonElement);
  }
  async function refresh() {
    const current = ++revision;
    list.setAttribute('aria-busy', 'true');
    status.textContent = 'Refreshing subscriptions…';
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_SUBSCRIPTION_LIST, version: 1 });
      if (current !== revision) return false;
      if (!isSubscriptionListResponse(response)) throw new Error('Invalid list');
      entries = response.subscriptions;
      list.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement('article');
        const text = document.createElement('h3');
        text.textContent = entry.merchant;
        const amount = document.createElement('p');
        amount.className = 'subscription-amount';
        amount.textContent = `${entry.amount} ${entry.currency} · ${entry.cadence}${entry.customDescription ? `: ${entry.customDescription}` : ''}`;
        const billing = document.createElement('p');
        if (entry.nextBillingDate) {
          billing.append('Next billing: ');
          const time = document.createElement('time'); time.dateTime = entry.nextBillingDate;
          time.textContent = entry.nextBillingDate; billing.append(time);
        }
        const notes = document.createElement('details');
        if (entry.notes) { const summary = document.createElement('summary'); summary.textContent = 'Notes'; const content = document.createElement('p'); content.textContent = entry.notes; notes.append(summary, content); }
        const edit = document.createElement('button');
        edit.type = 'button'; edit.dataset.subscriptionAction = 'edit'; edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit subscription ${entry.merchant}`);
        edit.addEventListener('click', () => { if (!busy) form(entry); });
        const remove = document.createElement('button');
        remove.type = 'button'; remove.dataset.subscriptionAction = 'delete'; remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete subscription ${entry.merchant}`);
        remove.addEventListener('click', () => {
          if (busy || !mayReplace()) return;
          suggestionOpen = false;
          suggestionInvalidationPending = false;
          editor.innerHTML = '<div role="group" aria-label="Delete confirmation"><h3>Delete subscription?</h3><p></p><p>Deletes this local record only. This does not cancel billing.</p><button type="button" data-subscription-action="cancel">Cancel</button><button type="button" data-subscription-action="confirm-delete">Delete subscription</button></div>';
          editor.querySelector('p')!.textContent = entry.merchant;
          const cancel = editor.querySelector<HTMLButtonElement>('[data-subscription-action="cancel"]')!;
          cancel.focus();
          cancel.addEventListener('click', () => { editor.replaceChildren(); remove.focus(); });
          const confirm = editor.querySelector<HTMLButtonElement>('[data-subscription-action="confirm-delete"]')!;
          confirm.addEventListener('click', () => {
            if (busy) return;
            busy = true; revision++; controls(); status.textContent = 'Deleting subscription…';
            void (async () => {
              try {
                const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_SUBSCRIPTION_DELETE, version: 1, id: entry.id });
                if (!isSubscriptionMutationResponse(response) || response.type !== CLEARCHOICE_SUBSCRIPTION_DELETE || response.id !== entry.id) throw new Error('Invalid delete');
                if (!await refresh() || entries.some((saved) => saved.id === entry.id)) throw new Error('Delete readback mismatch');
                editor.replaceChildren(); status.textContent = 'Subscription deleted locally.'; add.focus();
              } catch { status.textContent = 'Could not delete local subscription. Check the list before retrying.'; } finally { busy = false; controls(); if (!editor.childElementCount) add.focus(); }
            })();
          });
        });
        const helpButton = document.createElement('button');
        helpButton.type = 'button'; helpButton.dataset.subscriptionAction = 'help';
        helpButton.textContent = 'Cancellation help';
        helpButton.setAttribute('aria-label', `Cancellation help for ${entry.merchant}`);
        const helpRegion = document.createElement('div');
        helpRegion.setAttribute('role', 'status'); helpRegion.setAttribute('aria-live', 'polite');
        let helpPending = false;
        helpButton.addEventListener('click', () => {
          if (busy || helpPending || !row.isConnected) return;
          const helpRevision = revision;
          helpPending = true; helpControls.add(helpButton); helpButton.disabled = true;
          helpRegion.setAttribute('aria-busy', 'true');
          helpRegion.textContent = 'Loading cancellation help…';
          const live = () => helpRevision === revision && row.isConnected && root.contains(row);
          void (async () => {
            try {
              const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_SUBSCRIPTION_HELP, version: 1, id: entry.id });
              if (!live()) return;
              if (!isSubscriptionHelpResponse(response) || response.id !== entry.id) throw new Error('Invalid help');
              helpRegion.replaceChildren();
              const help = response.help;
              if (help.kind === 'none') {
                helpRegion.textContent = 'No known provider site; check your billing provider';
                return;
              }
              const link = document.createElement('a');
              link.href = help.kind === 'guide' ? help.destination : help.originURL;
              link.target = '_blank'; link.rel = 'noopener noreferrer';
              link.textContent = help.kind === 'guide' ? `Official guide (reviewed ${help.lastReviewed})` : 'Visit site — not a cancellation guide';
              helpRegion.append(link);
              if (help.kind === 'guide') {
                const detail = document.createElement('p');
                detail.textContent = `${help.title}. ${help.caveat}`;
                helpRegion.append(detail);
              }
            } catch { if (live()) helpRegion.textContent = 'Could not load cancellation help. Try again; check your billing provider.'; }
            finally { helpPending = false; helpControls.delete(helpButton); helpButton.disabled = busy; helpRegion.setAttribute('aria-busy', 'false'); }
          })();
        });
        row.append(text, amount); if (billing.childNodes.length) row.append(billing); if (entry.notes) row.append(notes); row.append(edit, remove, helpButton, helpRegion); list.append(row);
      }
      status.textContent = entries.length ? `${entries.length} subscriptions saved locally.` : 'No subscriptions saved.';
    return true;
    } catch { if (current === revision) status.textContent = 'Could not load local subscriptions. Try again.'; return false; } finally { if (current === revision) list.setAttribute('aria-busy', 'false'); }
  }
  function form(entry?: Subscription, source?: ReviewItem, returnControl?: HTMLButtonElement) {
    if (!mayReplace()) return;
    suggestionOpen = !!source;
    suggestionInvalidationPending = false;
    status.textContent = 'Save explicitly to confirm changes.';
    editor.innerHTML = '<form novalidate autocomplete="off"><h3>Add subscription</h3><p>Do not enter payment or account details.</p><label>Merchant<input name="merchant" maxlength="120" required></label><label>Amount (positive, two decimal places)<input name="amount" placeholder="12.99" inputmode="decimal" required></label><label>Currency (ISO code)<input name="currency" spellcheck="false" maxlength="3" value="USD" required></label><label>Cadence<select name="cadence"><option>weekly</option><option selected>monthly</option><option>quarterly</option><option>yearly</option><option>custom</option></select></label><label>Custom cadence description<input name="customDescription" maxlength="120"></label><label>Next billing date (YYYY-MM-DD, optional)<input name="nextBillingDate" placeholder="YYYY-MM-DD"></label><label>Notes (optional)<textarea name="notes" maxlength="500"></textarea></label><button type="button" data-subscription-action="cancel">Cancel</button><button type="submit">Save subscription</button></form>';
    const element = editor.querySelector('form')!;
    element.querySelector('[data-subscription-action="cancel"]')!.addEventListener('click', () => { if (busy) return; suggestionOpen = false; editor.replaceChildren(); status.textContent = 'Editor closed; no additional save requested.'; (returnControl?.isConnected ? returnControl : add).focus(); });
    if (source) {
      element.querySelector('h3')!.textContent = 'Confirm observation as subscription';
      const provenance = document.createElement('p');
      provenance.textContent = `Observation only — ${source.origin} · ${source.kind} · ${source.screenedExcerpt}. Complete the fields yourself; only Save subscription confirms.`;
      element.querySelector('h3')!.after(provenance);
      (element.elements.namedItem('currency') as HTMLInputElement).value = '';
      const cadence = element.elements.namedItem('cadence') as HTMLSelectElement;
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose cadence'; cadence.prepend(blank); cadence.value = '';
    }
    if (entry) {
      element.querySelector('h3')!.textContent = 'Edit subscription';
      for (const name of ['merchant', 'amount', 'currency', 'cadence', 'customDescription', 'nextBillingDate', 'notes'] as const)
        (element.elements.namedItem(name) as HTMLInputElement).value = entry[name] ?? '';
    }
    const custom = element.querySelector<HTMLInputElement>('[name="customDescription"]')!.closest('label')!;
    const cadenceControl = element.elements.namedItem('cadence') as HTMLSelectElement;
    const showCustom = () => { custom.hidden = cadenceControl.value !== 'custom'; };
    cadenceControl.addEventListener('change', showCustom); showCustom();
    initialDraft = draft();
    const read = (name: string) => (element.elements.namedItem(name) as HTMLInputElement).value;
    element.querySelector<HTMLInputElement>('[name="merchant"]')!.focus();
    element.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || !element.isConnected) return;
      const fields = { merchant: normalizeMerchant(read('merchant')), amount: read('amount'), currency: normalizeCurrency(read('currency')), cadence: read('cadence'), ...(read('cadence') === 'custom' ? { customDescription: read('customDescription') } : {}), ...(read('nextBillingDate') ? { nextBillingDate: read('nextBillingDate') } : {}), ...(read('notes') ? { notes: read('notes') } : {}) };
      for (const field of element.querySelectorAll('[aria-invalid]')) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
      for (const error of element.querySelectorAll('[data-field-error]')) error.remove();
      if (!isSubscriptionFields(fields)) {
        const baseline = { merchant: 'Merchant', amount: '1.00', currency: 'USD', cadence: 'monthly' };
        const messages: Record<string, string> = { merchant: 'Enter a merchant without payment, account or URL details.', amount: 'Enter a positive amount with two decimal places, such as 12.99.', currency: 'Enter a supported three-letter currency code.', cadence: 'Choose a cadence.', customDescription: 'Describe the cadence without payment, account or URL details.', nextBillingDate: 'Enter a valid date as YYYY-MM-DD.', notes: 'Use plain notes without payment, account or URL details.' };
        let first: HTMLElement | undefined;
        for (const name of Object.keys(messages)) {
          if (name === 'customDescription' && fields.cadence !== 'custom') continue;
          const candidate = name === 'customDescription' ? { ...baseline, cadence: 'custom', customDescription: read(name) }
            : name === 'cadence' ? { ...baseline, cadence: fields.cadence, ...(fields.cadence === 'custom' ? { customDescription: 'Custom schedule' } : {}) }
            : { ...baseline, ...(Object.hasOwn(fields, name) ? { [name]: fields[name as keyof typeof fields] } : {}) };
          if (isSubscriptionFields(candidate)) continue;
          const field = element.elements.namedItem(name) as HTMLElement;
          const error = document.createElement('span'); error.id = `subscription-error-${name}`; error.dataset.fieldError = ''; error.textContent = messages[name];
          field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', error.id); field.after(error); first ??= field;
        }
        status.textContent = 'Invalid subscription. Check the highlighted fields.';
        first?.focus(); return;
      }
      const save = element.querySelector<HTMLButtonElement>('[type="submit"]')!;
      if (save.disabled) return;
      busy = true; revision++; controls(); status.textContent = 'Saving subscription…';
      void (async () => {
        try {
          const type = source ? CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING : entry ? CLEARCHOICE_SUBSCRIPTION_UPDATE : CLEARCHOICE_SUBSCRIPTION_CREATE;
          const response: unknown = await chrome.runtime.sendMessage({ type, version: 1, fields, ...(source ? { id: source.id } : entry ? { id: entry.id } : {}) });
          if (!isSubscriptionMutationResponse(response) || response.type !== type || !('subscription' in response)
            || (entry && response.subscription.id !== entry.id)
            || (source && response.subscription.sourceFindingId !== source.id)
            || Object.entries(fields).some(([key, value]) => response.subscription[key as keyof Subscription] !== value)
            || ['customDescription', 'nextBillingDate', 'notes'].some((key) => !Object.hasOwn(fields, key) && Object.hasOwn(response.subscription, key))) throw new Error('Invalid save');
          if (!await refresh()) throw new Error('Save readback failed');
          if (!entries.some((saved) => Object.keys(saved).length === Object.keys(response.subscription).length
            && Object.entries(response.subscription).every(([key, value]) => saved[key as keyof Subscription] === value))) throw new Error('Save readback mismatch');
          suggestionOpen = false; editor.replaceChildren(); status.textContent = 'Subscription saved locally.';
        } catch {
          status.textContent = 'Could not save local subscription. Check the list before retrying.';
          if (source && suggestionInvalidationPending) status.textContent += ` ${invalidationMessage}`;
        } finally {
          if (source && suggestionInvalidationPending) {
            suggestionInvalidationPending = false;
            suggestionOpen = false;
            editor.replaceChildren();
          }
          busy = false; controls(); if (!editor.childElementCount) add.focus();
        }
      })();
    });
  }
  root.querySelector('[data-subscription-action="refresh"]')!.addEventListener('click', () => { if (!busy) { invalidateSuggestion(); void refresh(); } });
  add.addEventListener('click', () => { if (!busy) form(); });
  void refresh();
  return { refresh, invalidateSuggestion, reviewAsSubscription: (item: ReviewItem, control: HTMLButtonElement) => { if (!busy) form(undefined, { ...item }, control); } };
}
