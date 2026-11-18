<!-- The reader page: a native sign-in form for a visitor; for a reader their own account, one
     form per newsletter to leave it and a sign-out button (ADR 009: no JavaScript needed). Each
     newsletter row has one button, so no row of actions has to fit side by side. The honeypot
     sits out of sight and out of reach of password managers, like the form block's; `proof.js`
     fills `_proof` when it runs. -->
<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  const labels = $derived(data.labels);
</script>

<svelte:head>
  <title>{data.account ? labels.accountTitle : labels.title}</title>
  {#if data.form}<script type="module" src="/_form/proof.js"></script>{/if}
</svelte:head>

<main class="page">
  {#if data.account}
    {@const account = data.account}
    <h1>{labels.accountTitle}</h1>
    {#if account.withdrawn}
      <p role="status">{labels.withdrawn.replace('{list}', account.withdrawn)}</p>
    {/if}
    <dl class="reader-account">
      <dt>{labels.email}</dt>
      <dd>{account.email}</dd>
      {#if account.lastSeen}
        <dt>{labels.lastSeen}</dt>
        <dd>{account.lastSeen}</dd>
      {/if}
    </dl>

    <h2>{labels.access}</h2>
    {#if account.access.length}
      <ul class="reader-access">
        {#each account.access as entry (entry.name)}
          <li><strong>{entry.name}</strong>: {entry.status}</li>
        {/each}
      </ul>
      <p>{labels.accessChange}</p>
    {:else}
      <p>{labels.accessNone}</p>
    {/if}

    <h2>{labels.newsletters}</h2>
    {#if account.lists.length}
      <ul class="reader-lists">
        {#each account.lists as entry (entry.list)}
          <li>
            <span>{entry.label}</span>
            <form method="post" action={account.withdrawAction}>
              <input type="hidden" name="list" value={entry.list} />
              <button type="submit">{entry.button}</button>
            </form>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{labels.newslettersNone}</p>
    {/if}

    <p><a href={data.givingHref}>{labels.giving}</a></p>

    <h2>{labels.privacy}</h2>
    <p>{account.retention}</p>
    <p>{account.sessionEnds}</p>
    <form method="post" action={data.signoutAction}>
      <button type="submit">{labels.signout}</button>
    </form>
  {:else if data.form}
    <h1>{labels.title}</h1>
    <p>{labels.intro}</p>
    <form
      method="post"
      action={data.form.action}
      class="signup"
      data-proof={JSON.stringify(data.form.proof)}
    >
      {#if form?.message}
        <div class="error-summary" role="alert">
          <p>{form.message}</p>
        </div>
      {/if}
      <input type="hidden" name="_started" value={data.form.startedToken} />
      <input type="hidden" name="_proof" value="" />
      {#if data.form.returnPath}
        <input type="hidden" name="return" value={data.form.returnPath} />
      {/if}
      <div class="hp" aria-hidden="true">
        <label for="reader-website">{labels.honeypot}</label>
        <input
          id="reader-website"
          name="website"
          type="text"
          tabindex="-1"
          autocomplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
        />
      </div>
      <div class="field" data-form-field>
        <label for="reader-email">{labels.email}</label>
        <input
          id="reader-email"
          name="email"
          type="email"
          autocomplete="email"
          required
          maxlength="320"
          value={form?.email ?? ''}
        />
      </div>
      <button type="submit">{labels.submit}</button>
    </form>
  {:else}
    <h1>{labels.title}</h1>
    <p>{labels.suspended}</p>
  {/if}
</main>
