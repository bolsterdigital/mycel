<!-- The donor's gifts (ADR 005 rule 6): one section per gift with what it is and where it stands,
     and for a running membership only "cancel for <date>" (MY-254 PR 4). For a running or paused
     gift three native forms stacked under each other: a new amount,
     pause or resume, and stop. Stopping sits behind a native disclosure with its own button, so
     one stray tap stops nothing and no JavaScript is needed (ADR 009). The forms are stacked,
     never a row, so no label has to fit beside another at 320 px or 200 % zoom. -->
<script lang="ts">
  /** As `own-gifts.ts` builds it on the server. */
  interface OwnGiftView {
    id: string;
    title: string;
    facts: { term: string; value: string }[];
    open: boolean;
    paused: boolean;
    euros: string;
    cancelFor: { summary: string; hint: string; confirm: string } | null;
  }

  interface Labels {
    none: string;
    amount: string;
    amountHint: string;
    amountSubmit: string;
    pause: string;
    pauseHint: string;
    resume: string;
    stop: string;
    stopHint: string;
    stopConfirm: string;
  }

  let {
    gifts,
    labels,
    action,
    failed = null,
  }: {
    gifts: OwnGiftView[];
    labels: Labels;
    /** The page's own path (with `?lang=` when the link had it): each form posts `?/<change>`. */
    action: (change: string) => string;
    failed?: { gift: string; message: string } | null;
  } = $props();
</script>

{#if gifts.length}
  {#each gifts as gift (gift.id)}
    <section class="own-gift" aria-labelledby="gift-{gift.id}">
      <h2 id="gift-{gift.id}">{gift.title}</h2>
      <dl>
        {#each gift.facts as fact (fact.term)}
          <div>
            <dt>{fact.term}</dt>
            <dd>{fact.value}</dd>
          </div>
        {/each}
      </dl>
      {#if failed && failed.gift === gift.id}
        <div class="error-summary" role="alert"><p>{failed.message}</p></div>
      {/if}
      {#if gift.cancelFor}
        <!-- A membership: only cancelling, for the end of the period it is paid for. -->
        <details class="own-gift-stop">
          <summary>{gift.cancelFor.summary}</summary>
          <form method="post" action={action('cancel')} class="own-gift-form">
            <input type="hidden" name="gift" value={gift.id} />
            <p>{gift.cancelFor.hint}</p>
            <button type="submit">{gift.cancelFor.confirm}</button>
          </form>
        </details>
      {/if}
      {#if gift.open}
        <form method="post" action={action('amount')} class="signup own-gift-form">
          <input type="hidden" name="gift" value={gift.id} />
          <div class="field">
            <label for="amount-{gift.id}">{labels.amount}</label>
            <p class="hint" id="amount-hint-{gift.id}">{labels.amountHint}</p>
            <input
              id="amount-{gift.id}"
              name="amount"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              required
              maxlength="12"
              value={gift.euros}
              aria-describedby="amount-hint-{gift.id}"
            />
          </div>
          <button type="submit">{labels.amountSubmit}</button>
        </form>
        <form method="post" action={action(gift.paused ? 'resume' : 'pause')} class="own-gift-form">
          <input type="hidden" name="gift" value={gift.id} />
          {#if !gift.paused}<p class="hint">{labels.pauseHint}</p>{/if}
          <button type="submit">{gift.paused ? labels.resume : labels.pause}</button>
        </form>
        <details class="own-gift-stop">
          <summary>{labels.stop}</summary>
          <form method="post" action={action('cancel')} class="own-gift-form">
            <input type="hidden" name="gift" value={gift.id} />
            <p>{labels.stopHint}</p>
            <button type="submit">{labels.stopConfirm}</button>
          </form>
        </details>
      {/if}
    </section>
  {/each}
{:else}
  <p>{labels.none}</p>
{/if}
